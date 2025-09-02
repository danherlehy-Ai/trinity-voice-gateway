import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// ---------- μ-law helpers (fallback only) ----------
const SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_SHIFT = 4, SEG_MASK = 0x70;
function ulawToLinear(u_val) {
  u_val = ~u_val & 0xFF;
  let t = ((u_val & QUANT_MASK) << 3) + 0x84;
  t <<= (u_val & SEG_MASK) >> SEG_SHIFT;
  return (u_val & SIGN_BIT) ? (0x84 - t) : (t - 0x84);
}
function linearToUlaw(sample) {
  const CLIP = 32635, BIAS = 0x84;
  let sign = (sample < 0) ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let seg = 0;
  for (; seg < 8 && (sample & 0x4000) === 0; seg++) sample <<= 1;
  const mantissa = (sample >> (seg + 3)) & 0x0F;
  return ~(sign | (seg << 4) | mantissa) & 0xFF;
}
function upsample8kTo16k(int16) {
  const out = new Int16Array(int16.length * 2);
  for (let i = 0; i < int16.length; i++) { out[2*i] = int16[i]; out[2*i+1] = int16[i]; }
  return out;
}
function downsample16kTo8k(int16) {
  const out = new Int16Array(Math.floor(int16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16[i];
  return out;
}

// ---------- Twilio <-> OpenAI audio utils ----------
const TWILIO_ULAW_BYTES_PER_20MS = 160; // 8kHz * 0.02s * 1 byte/μ-law sample
function chunkAndSendUlawBase64ToTwilio(b64Ulaw, twilioWS, streamSid, counters) {
  // Decode once to byte Buffer, then re-chunk into 20ms (160-byte) frames and re-encode
  const bytes = Buffer.from(b64Ulaw, 'base64');
  for (let off = 0; off < bytes.length; off += TWILIO_ULAW_BYTES_PER_20MS) {
    const slice = bytes.subarray(off, Math.min(off + TWILIO_ULAW_BYTES_PER_20MS, bytes.length));
    if (slice.length === 0) continue;
    const payload = slice.toString('base64');
    twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    counters.sentChunks++;
    if (counters.sentChunks % 10 === 0) {
      console.log(`Audio → Twilio: sent ${counters.sentChunks} chunks`);
    }
  }
}

// Fallback: if OpenAI ever sends PCM16 @ 16k in binary, convert → μ-law @ 8k and send
function sendPcm16kBinaryToTwilioAsUlaw(binaryBuf, twilioWS, streamSid, counters) {
  const int16 = new Int16Array(binaryBuf.buffer, binaryBuf.byteOffset, binaryBuf.byteLength / 2);
  // downsample 16k -> 8k (every other sample)
  const pcm8 = downsample16kTo8k(int16);
  // μ-law encode
  const ulaw = Buffer.alloc(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) ulaw[i] = linearToUlaw(pcm8[i]);
  // chunk and send
  for (let off = 0; off < ulaw.length; off += TWILIO_ULAW_BYTES_PER_20MS) {
    const slice = ulaw.subarray(off, Math.min(off + TWILIO_ULAW_BYTES_PER_20MS, ulaw.length));
    const payload = slice.toString('base64');
    twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    counters.sentChunks++;
    if (counters.sentChunks % 10 === 0) {
      console.log(`Audio → Twilio (fallback): sent ${counters.sentChunks} chunks`);
    }
  }
}

// ---------- minimal app ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/warmup', (_req, res) => res.status(204).end());

// ---------- HTTP server + /media WebSocket ----------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWS, req) => {
  console.log('WS: connection from', req.socket.remoteAddress);
  let streamSid = null;
  const counters = { frames: 0, sentChunks: 0 };

  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1',
  };
  const aiWS = new WebSocket(OPENAI_URL, { headers, perMessageDeflate: false });

  aiWS.on('open', () => {
    console.log('AI: connected');
    const desiredVoice = process.env.DEFAULT_VOICE || 'marin';

    // *** Use μ-law both directions to avoid conversion/static ***
    aiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: desiredVoice,
        turn_detection: { type: 'server_vad', threshold: 0.6 },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw'
      }
    }));

    // One-shot test line so we can confirm return audio path
    aiWS.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: 'Say: "I am connected and listening." Then wait quietly for the caller.'
      }
    }));
  });

  aiWS.on('message', (raw, isBinary) => {
    if (!streamSid) return; // wait until Twilio gave us a streamSid

    // If model ever sends binary PCM16@16k, convert → μ-law and forward
    if (isBinary) {
      sendPcm16kBinaryToTwilioAsUlaw(raw, twilioWS, streamSid, counters);
      return;
    }

    // Otherwise expect JSON events
    try {
      const msg = JSON.parse(raw.toString());

      // Debug ALL events except audio deltas (too chatty)
      if (!['response.audio.delta', 'response.output_audio.delta'].includes(msg?.type)) {
        console.log('AI event:', msg?.type);
      }

      // Handle both event names, both field names (delta | audio)
      if ((msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta')) {
        const b64 = msg.delta || msg.audio;
        if (!b64) {
          console.log('Audio event without data');
          return;
        }
        // Already μ-law @ 8k (because output_audio_format=g711_ulaw)
        chunkAndSendUlawBase64ToTwilio(b64, twilioWS, streamSid, counters);
      } else if (msg.type === 'error') {
        console.log('AI error:', msg.error || msg);
      }
    } catch (e) {
      console.log('AI: failed to parse message', e?.message);
    }
  });

  aiWS.on('close', () => {
    console.log('AI: closed');
    console.log(`Session summary: received ${counters.frames} frames, sent ${counters.sentChunks} audio chunks`);
  });
  aiWS.on('error', (err) => console.log('AI: error', err?.message));

  twilioWS.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case 'connected':
          console.log('WS: connected event');
          break;

        case 'start':
          streamSid = data.start?.streamSid;
          console.log('WS: stream started', { streamSid, callSid: data.start?.callSid });
          counters.frames = 0;
          counters.sentChunks = 0;
          // Clear any prior input buffer (optional)
          if (aiWS.readyState === 1) {
            aiWS.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          }
          break;

        case 'media':
          counters.frames++;
          if (counters.frames % 100 === 0) console.log('WS: frames', counters.frames);
          // Twilio payload is already μ-law base64; pass straight through to OpenAI
          if (aiWS.readyState === 1 && data.media?.payload) {
            aiWS.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            }));
          }
          break;

        case 'stop':
          console.log('WS: stream stopped (frames received:', counters.frames, ')');
          // Do NOT commit on stop — avoids empty-buffer errors; VAD commits turns.
          try { twilioWS.close(); } catch {}
          break;
      }
    } catch (e) {
      console.log('WS: failed to parse message', e?.message);
    }
  });

  twilioWS.on('close', () => {
    if (aiWS.readyState === 1) aiWS.close();
    console.log('WS: connection closed');
  });
  twilioWS.on('error', (err) => console.log('WS: error', err?.message));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Trinity gateway listening on :${PORT}`));
