import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// ---------- helpers: μ-law <-> PCM16 + simple resampling ----------
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0F;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;

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
function twilioPayloadToPCM16k(payloadB64) {
  const ulaw = Buffer.from(payloadB64, 'base64');
  const pcm8 = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) pcm8[i] = ulawToLinear(ulaw[i]);
  return upsample8kTo16k(pcm8);
}
function pcm16kToTwilioPayload(int16) {
  const pcm8 = downsample16kTo8k(int16);
  const out = Buffer.alloc(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) out[i] = linearToUlaw(pcm8[i]);
  return out.toString('base64');
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
  let frames = 0; // ← count inbound frames so we know if buffer has audio

  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  const aiWS = new WebSocket(OPENAI_URL, { headers, perMessageDeflate: false });

  aiWS.on('open', () => {
    console.log('AI: connected');

    const desiredVoice = process.env.DEFAULT_VOICE || 'marin';
    aiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: desiredVoice,
        turn_detection: { type: 'server_vad', threshold: 0.6 },
        input_audio_format: 'pcm16',   // string (not object)
        output_audio_format: 'pcm16'   // string (not object)
      }
    }));

    aiWS.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio','text'], // both
        instructions:
          "You are Trinity, phone AI for Father Dan. After this greeting, listen and respond concisely. If the caller interrupts, stop speaking and listen. Keep a warm, upbeat tone."
      }
    }));
  });

  aiWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'response.audio.delta' && msg.audio && streamSid) {
        const pcm = Buffer.from(msg.audio, 'base64');
        const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength/2);
        const payload = pcm16kToTwilioPayload(int16);
        twilioWS.send(JSON.stringify({ event:'media', streamSid, media:{ payload } }));
      } else if (msg.type === 'error') {
        console.log('AI error:', msg.error || msg);
      }
    } catch {
      // ignore non-JSON frames from OpenAI
    }
  });

  aiWS.on('close', () => console.log('AI: closed'));
  aiWS.on('error', (err) => console.log('AI: error', err?.message));

  twilioWS.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      switch (data.event) {
        case 'connected':
          console.log('WS: connected event'); break;

        case 'start':
          streamSid = data.start?.streamSid;
          console.log('WS: stream started', { streamSid, callSid: data.start?.callSid });
          frames = 0;
          if (aiWS.readyState === 1) aiWS.send(JSON.stringify({ type:'input_audio_buffer.clear' }));
          break;

        case 'media': {
          frames++;
          if (frames % 50 === 0) console.log('WS: frames', frames);
          const pcm16 = twilioPayloadToPCM16k(data.media.payload);
          const b = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
          if (aiWS.readyState === 1) {
            aiWS.send(JSON.stringify({ type:'input_audio_buffer.append', audio: b.toString('base64') }));
          }
          break;
        }

        case 'stop':
          console.log('WS: stream stopped (frames received:', frames, ')');
          // Only commit if we actually appended audio
          if (frames > 0 && aiWS.readyState === 1) {
            aiWS.send(JSON.stringify({ type:'input_audio_buffer.commit' }));
          }
          try { twilioWS.close(); } catch {}
          break;
      }
    } catch {
      // ignore non-JSON
    }
  });

  twilioWS.on('close', () => { if (aiWS.readyState === 1) aiWS.close(); console.log('WS: connection closed'); });
  twilioWS.on('error', (err) => console.log('WS: error', err?.message));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Trinity gateway listening on :${PORT}`));
