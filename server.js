import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

/* ================= μ-law helpers (fallback only) ================= */
const SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_SHIFT = 4, SEG_MASK = 0x70;
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
function downsample16kTo8k(int16) {
  const out = new Int16Array(Math.floor(int16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16[i];
  return out;
}
const TWILIO_ULAW_BYTES_PER_20MS = 160; // 8kHz * 0.02s * 1 byte/sample
function chunkAndSendUlawBase64ToTwilio(b64Ulaw, twilioWS, streamSid, counters) {
  const bytes = Buffer.from(b64Ulaw, 'base64');
  for (let off = 0; off < bytes.length; off += TWILIO_ULAW_BYTES_PER_20MS) {
    const slice = bytes.subarray(off, Math.min(off + TWILIO_ULAW_BYTES_PER_20MS, bytes.length));
    if (!slice.length) continue;
    const payload = slice.toString('base64');
    twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    if ((++counters.sentChunks) % 10 === 0) console.log(`Audio → Twilio: sent ${counters.sentChunks} chunks`);
  }
}
function sendPcm16kBinaryToTwilioAsUlaw(binaryBuf, twilioWS, streamSid, counters) {
  const int16 = new Int16Array(binaryBuf.buffer, binaryBuf.byteOffset, binaryBuf.byteLength / 2);
  const pcm8 = downsample16kTo8k(int16);
  const ulaw = Buffer.alloc(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) ulaw[i] = linearToUlaw(pcm8[i]);
  for (let off = 0; off < ulaw.length; off += TWILIO_ULAW_BYTES_PER_20MS) {
    const slice = ulaw.subarray(off, Math.min(off + TWILIO_ULAW_BYTES_PER_20MS, ulaw.length));
    const payload = slice.toString('base64');
    twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    if ((++counters.sentChunks) % 10 === 0) console.log(`Audio → Twilio (fallback): sent ${counters.sentChunks} chunks`);
  }
}

/* ================= App & config ================= */
const app = express();
// Accept Twilio form posts AND JSON
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

const GOOGLE_APPS_SCRIPT_URL =
  process.env.GOOGLE_APPS_SCRIPT_URL ||
  // Keep equal to your Apps Script deployment /exec (used for logging)
  'https://script.google.com/macros/s/AKfycbxAIANRmjl_FIzeEsbC5UNT64IBYK1ITGalpGH7zKRcDw_9dDViL27ld8fir_lYrTPp/exec';

const CONFIG_URL =
  process.env.GOOGLE_CONFIG_URL ||
  'https://script.google.com/macros/s/AKfycbxAIANRmjl_FIzeEsbC5UNT64IBYK1ITGalpGH7zKRcDw_9dDViL27ld8fir_lYrTPp/exec';

// small in-memory cache to remove per-call latency
let _configCache = { when: 0, data: null };
const CONFIG_TTL_MS = 5 * 60 * 1000;

async function fetchConfigFresh() {
  const res = await fetch(CONFIG_URL, { method: 'GET' });
  if (!res.ok) throw new Error(`Config HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.ok) throw new Error(`Config error: ${JSON.stringify(json)}`);
  const system_prompt = String(json.system_prompt || '');
  const vips = Array.isArray(json.vips) ? json.vips : [];
  const businesses = Array.isArray(json.businesses) ? json.businesses : [];
  console.log(`Config OK: prompt=${system_prompt.length} chars, vips=${vips.length}, businesses=${businesses.length}`);
  return { system_prompt, vips, businesses };
}
async function getConfigCached() {
  const now = Date.now();
  if (_configCache.data && now - _configCache.when < CONFIG_TTL_MS) return _configCache.data;
  try {
    const data = await fetchConfigFresh();
    _configCache = { when: now, data };
    return data;
  } catch (e) {
    console.log('Config fetch failed:', e?.message);
    return _configCache.data || { system_prompt: 'You are Trinity.', vips: [], businesses: [] };
  }
}

// Beef up /warmup: prefetch config and warm OpenAI TLS
app.get('/warmup', async (_req, res) => {
  try {
    await getConfigCached();
    try {
      await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      }).catch(() => {});
    } catch {}
  } catch {}
  res.status(204).end();
});

/* ================= Helpers for dynamic instructions & VIPs ================= */
const ENGLISH_GUARD =
  'Default language: English (United States). Always speak in English unless the caller explicitly asks for another language. ' +
  'If the caller begins in Spanish, briefly confirm in English and ask if they prefer Spanish; otherwise continue in English.';

const VIP_SKIP_NUMBER =
  'If the caller’s phone number matches a VIP number listed below, do NOT ask them to confirm their callback number; ' +
  'assume the caller ID is correct unless they provide a different number.';

function normalizePhone(p) { return (p || '').replace(/\D/g, ''); }

function chooseVoice(defaultVoice, vip) {
  const male = process.env.MALE_VOICE || 'alloy';
  const female = defaultVoice || 'marin';
  if (!vip) return female;
  const v = (vip.voice_override || '').toLowerCase();
  if (v === 'male') return male;
  if (v === 'marin' || v === 'female') return female;
  return female;
}

function buildInstructions(system_prompt, vips, callerNumber, callerVip) {
  const vipMap = vips
    .filter(v => v.phone)
    .map(v => `${normalizePhone(v.phone)}=${v.name}`)
    .join(', ');
  const lines = [
    system_prompt || 'You are Trinity.',
    ENGLISH_GUARD,
    VIP_SKIP_NUMBER,
    vipMap ? `VIP numbers: ${vipMap}.` : ''
  ];
  if (callerNumber) lines.push(`[CALL CONTEXT] CallerID: ${normalizePhone(callerNumber)}.`);
  if (callerVip) lines.push(`[CALL CONTEXT] Recognized VIP: ${callerVip.name} (${callerVip.relationship}). Skip number verification.`);
  const text = lines.filter(Boolean).join('\n');
  return text;
}

/* ================= /transcripts webhook (NEW) ================= */
// In-memory transcript buffers keyed by CallSid
const transcripts = new Map();

/**
 * Twilio POSTs these events to statusCallbackUrl:
 *  - TranscriptionEvent = transcription-started | transcription-content | transcription-stopped | transcription-error
 *  - TranscriptionData  = JSON string for content events: {"transcript":"...", "confidence":0.99, "is_final":true}
 *  - Track / inboundTrackLabel / outboundTrackLabel identify who is speaking
 * We buffer per CallSid and send the final transcript to Google Apps Script on "transcription-stopped".
 */
app.post('/transcripts', async (req, res) => {
  try {
    const ev = req.body.TranscriptionEvent || req.body.transcriptionevent || '';
    const callSid = req.body.CallSid || req.body.callsid || '';
    if (!callSid) {
      console.log('TRANSCRIPT: missing CallSid');
      return res.status(200).send('ok');
    }

    // Ensure buffer
    if (!transcripts.has(callSid)) {
      transcripts.set(callSid, { caller: [], assistant: [], raw: [] });
    }
    const buf = transcripts.get(callSid);

    if (ev === 'transcription-started') {
      console.log('TRANSCRIPT started', callSid);
      return res.status(200).send('ok');
    }

    if (ev === 'transcription-content') {
      // Pull text
      let text = '';
      try {
        if (req.body.TranscriptionData) {
          const d = JSON.parse(req.body.TranscriptionData);
          text = d?.transcript || d?.text || '';
        }
      } catch (_) {}
      if (!text && req.body.TranscriptionText) text = req.body.TranscriptionText;

      // Identify speaker if possible
      const track = (req.body.Track || req.body.track || '').toLowerCase(); // 'inbound_track' | 'outbound_track' | 'both_tracks'
      const inLabel = req.body.InboundTrackLabel || req.body.inboundtracklabel || '';
      const outLabel = req.body.OutboundTrackLabel || req.body.outboundtracklabel || '';

      const line = text.trim();
      if (line) {
        if (track === 'inbound_track') buf.caller.push(line);
        else if (track === 'outbound_track') buf.assistant.push(line);
        else buf.raw.push(line);
      }
      return res.status(200).send('ok');
    }

    if (ev === 'transcription-stopped' || ev === 'transcription-error') {
      console.log('TRANSCRIPT finished', callSid, ev);
      // Combine
      let transcript = '';
      if (buf.caller.length || buf.assistant.length) {
        const caller = buf.caller.join(' ');
        const agent  = buf.assistant.join(' ');
        transcript =
          (caller ? `Caller: ${caller}\n` : '') +
          (agent  ? `Assistant: ${agent}\n` : '');
      } else {
        transcript = buf.raw.join(' ');
      }

      // Ship to Google Apps Script (append to Calls)
      try {
        const form = new URLSearchParams();
        form.set('CallSid', callSid);
        form.set('transcript', transcript || '');
        // optional: pass From/To if you have them available in memory via some store
        await fetch(GOOGLE_APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
      } catch (e) {
        console.log('Apps Script POST failed:', e?.message);
      } finally {
        transcripts.delete(callSid);
      }
      return res.status(200).send('ok');
    }

    // Unknown event
    return res.status(200).send('ok');
  } catch (e) {
    console.log('TRANSCRIPT handler error:', e?.message);
    return res.status(200).send('ok');
  }
});

/* ================= HTTP server + /media WebSocket ================= */
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWS, req) => {
  console.log('WS: connection from', req.socket.remoteAddress);

  let streamSid = null;
  let callerFrom = null;
  let callerVip = null;
  let currentVoice = process.env.DEFAULT_VOICE || 'marin';
  const counters = { frames: 0, sentChunks: 0 };

  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1',
  };
  const aiWS = new WebSocket(OPENAI_URL, { headers, perMessageDeflate: false });

  let aiReady = false;
  let latestConfig = null;

  async function applySessionConfig(reason) {
    if (!aiReady) return;
    if (!latestConfig) latestConfig = await getConfigCached();

    if (callerFrom && latestConfig.vips?.length) {
      const norm = normalizePhone(callerFrom);
      const found = latestConfig.vips.find(v => normalizePhone(v.phone) === norm);
      if (found) callerVip = found;
    }

    const selectedVoice = chooseVoice(process.env.DEFAULT_VOICE || 'marin', callerVip);
    const instructions = buildInstructions(latestConfig.system_prompt, latestConfig.vips, callerFrom, callerVip);

    console.log(
      `Applying session config (${reason}) -> voice=${selectedVoice}` +
      (callerVip ? `, VIP=${callerVip.name}` : '') +
      `, instructions length: ${instructions.length}`
    );

    currentVoice = selectedVoice;
    aiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: selectedVoice,
        turn_detection: { type: 'server_vad', threshold: 0.6 },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions
      }
    }));
  }

  aiWS.on('open', async () => {
    console.log('AI: connected');
    aiReady = true;
    latestConfig = await getConfigCached();
    await applySessionConfig('on-open');
  });

  aiWS.on('message', (raw, isBinary) => {
    if (!streamSid) return;

    if (isBinary) {
      sendPcm16kBinaryToTwilioAsUlaw(raw, twilioWS, streamSid, counters);
      return;
    }
    try {
      const msg = JSON.parse(raw.toString());
      if (!['response.audio.delta', 'response.output_audio.delta'].includes(msg?.type)) {
        console.log('AI event:', msg?.type);
      }
      if (msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta') {
        const b64 = msg.delta || msg.audio;
        if (b64) chunkAndSendUlawBase64ToTwilio(b64, twilioWS, streamSid, counters);
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

  twilioWS.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      switch (data.event) {
        case 'connected':
          console.log('WS: connected event');
          break;

        case 'start':
          streamSid = data.start?.streamSid;
          console.log('WS: stream started', { streamSid, callSid: data.start?.callSid });
          counters.frames = 0; counters.sentChunks = 0;

          try {
            const params = data.start?.customParameters || [];
            const fromParam = Array.isArray(params) ? params.find(p => p?.name === 'from') : null;
            const toParam   = Array.isArray(params) ? params.find(p => p?.name === 'to')   : null;
            const callParam = Array.isArray(params) ? params.find(p => p?.name === 'callSid') : null;
            const callSid = callParam?.value || null;
            const from = fromParam?.value || null;

            if (from) console.log('CallerID (From) received:', from);
            if (callSid && !transcripts.has(callSid)) transcripts.set(callSid, { caller: [], assistant: [], raw: [] });
            if (from && callSid) {
              // Optionally seed transcript header
              const buf = transcripts.get(callSid);
              buf.raw.push(`CallerID: ${from}`);
            }
            callerFrom = from;
          } catch {}

          await applySessionConfig('on-start');

          if (aiWS.readyState === 1) {
            aiWS.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          }
          break;

        case 'media':
          counters.frames++;
          if (counters.frames % 100 === 0) console.log('WS: frames', counters.frames);
          if (aiWS.readyState === 1 && data.media?.payload) {
            aiWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
          }
          break;

        case 'stop':
          console.log('WS: stream stopped (frames received:', counters.frames, ')');
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
const server = app.listen(PORT, () => console.log(`Trinity gateway listening on :${PORT}`));
