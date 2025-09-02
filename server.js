import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

// ---------- helpers: μ-law <-> PCM16 + simple resampling ----------
const MU_LAW_MAX = 0x1FFF;
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

// PCM16 (-32768..32767) -> μ-law (0..255)
function linearToUlaw(sample) {
  const CLIP = 32635;
  const BIAS = 0x84;
  let sign = (sample < 0) ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let seg = 0;
  for (let i = 0x4000; (sample & 0x4000) === 0; i >>= 1) {
    seg++;
    if (seg >= 8) break;
  }
  const mantissa = (sample >> (seg + 3)) & 0x0F;
  const ulaw = ~(sign | (seg << 4) | mantissa) & 0xFF;
  return ulaw;
}

// upsample 8k -> 16k by simple linear duplication (fast; fine for voice)
function upsample8kTo16k(int16) {
  const out = new Int16Array(int16.length * 2);
  for (let i = 0; i < int16.length; i++) {
    out[2 * i] = int16[i];
    out[2 * i + 1] = int16[i]; // duplicate
  }
  return out;
}

// downsample 16k -> 8k by dropping every other sample
function downsample16kTo8k(int16) {
  const out = new Int16Array(Math.floor(int16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16[i];
  return out;
}

// Twilio media payload (base64 μ-law) -> Int16 16k PCM
function twilioPayloadToPCM16k(payloadB64) {
  const ulaw = Buffer.from(payloadB64, 'base64');
  const pcm8 = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) pcm8[i] = ulawToLinear(ulaw[i]);
  return upsample8kTo16k(pcm8);
}

// Int16 16k PCM -> Twilio payload (base64 μ-law 8k)
function pcm16kToTwilioPayload(int16) {
  const pcm8 = downsample16kTo8k(int16);
  const out = Buffer.alloc(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) out[i] = linearToUlaw(pcm8[i]);
  return out.toString('base64');
}

// ---------- google sheets test endpoints (unchanged) ----------
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/warmup', (_req, res) => res.status(204).end());

async function sendToSheet(payload) {
  const webhook = process.env.WEBHOOK_URL;
  if (!webhook) throw new Error('WEBHOOK_URL not set');
  const resp = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await resp.text();
  return { status: resp.status, body: text };
}
function testPayload(note = 'GET /logs/test appended this row.') {
  return {
    from: '+10000000000',
    to: '+10000000001',
    call_sid: `TEST_${Date.now()}`,
    caller_name: 'Test Caller',
    vip_name: '',
    vip_role: '',
    business: '',
    intent: 'test',
    summary: note,
    action_items: ['Example item'],
    spam: false,
    dnc_attempted: false,
    dnc_result: '',
    recording_url: '',
    transcript: 'This is only a test.'
  };
}
app.get('/logs/test', async (_req, res) => {
  try {
    const result = await sendToSheet(testPayload());
    res.status(200).send(`OK — test row appended to your Sheet. Webhook status: ${result.status}`);
  } catch (e) {
    res.status(500).send(`Error: ${String(e)}`);
  }
});
app.post('/logs/test', async (_req, res) => {
  try {
    const result = await sendToSheet(testPayload('POST /logs/test appended this row.'));
    res.json({ ok: true, webhook_status: result.status, body: result.body });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- HTTP server + /media WebSocket ----------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWS, req) => {
  console.log('WS: connection from', req.socket.remoteAddress);
  let streamSid = null;

  // OpenAI Realtime WS
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview'
  )}`;

  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1',
  };

  const aiWS = new WebSocket(OPENAI_URL, { headers });

  aiWS.on('open', () => {
    console.log('AI: connected');

    // Set up the session: voice + VAD + audio format
    const desiredVoice = process.env.DEFAULT_VOICE || 'marin';
    aiWS.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          // Server voice; Realtime will synthesize and send audio frames back
          voice: desiredVoice,
          turn_detection: { type: 'server_vad', threshold: 0.6 }, // caller barge-in
          input_audio_format: { type: 'pcm16', sample_rate: 16000 },
          output_audio_format: { type: 'pcm16', sample_rate: 16000 }
        }
      })
    );

    // Say hello immediately (so we can hear the bot)
    aiWS.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio'],
          instructions:
            "You are Trinity, phone AI for Father Dan. After this greeting, listen and respond concisely. If the caller interrupts, stop speaking and listen. Keep a warm, upbeat tone."
        }
      })
    );
  });

  aiWS.on('message', (raw) => {
    // Expect AI messages, including audio deltas
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'response.audio.delta' && msg.audio) {
        // base64 PCM16 16k from OpenAI -> μ-law 8k payload to Twilio
        const pcm = Buffer.from(msg.audio, 'base64');
        const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
        const payload = pcm16kToTwilioPayload(int16);
        if (streamSid) {
          twilioWS.send(
            JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload }
            })
          );
        }
      } else if (msg.type === 'response.completed') {
        // mark end of AI turn
        // optional: twilioWS.send(JSON.stringify({event:'mark', ...}))
      } else if (msg.type === 'error') {
        console.log('AI error:', msg.error || msg);
      }
    } catch (e) {
      // not JSON — ignore (OpenAI also streams binary for audio sometimes)
    }
  });

  aiWS.on('close', () => console.log('AI: closed'));
  aiWS.on('error', (err) => console.log('AI: error', err?.message));

  // Handle Twilio inbound media
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
          // let AI know we’re ready for a new turn
          aiWS.readyState === 1 &&
            aiWS.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          break;
        case 'media': {
          // Twilio 8k μ-law -> PCM16 16k -> send to AI
          const pcm16 = twilioPayloadToPCM16k(data.media.payload);
          const b = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
          aiWS.readyState === 1 &&
            aiWS.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: b.toString('base64')
              })
            );
          break;
        }
        case 'stop':
          console.log('WS: stream stopped');
          aiWS.readyState === 1 && aiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          twilioWS.close();
          break;
      }
    } catch (e) {
      // ignore non-JSON
    }
  });

  twilioWS.on('close', () => {
    aiWS.readyState === 1 && aiWS.close();
    console.log('WS: connection closed');
  });
  twilioWS.on('error', (err) => console.log('WS: error', err?.message));
});

// ---------- start ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Trinity gateway listening on :${PORT}`);
});
