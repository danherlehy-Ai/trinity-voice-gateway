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
const TWILIO_ULAW_BYTES_PER_20MS = 160;
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
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

const GOOGLE_APPS_SCRIPT_URL =
  process.env.GOOGLE_APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbxAIANRmjl_FIzeEsbC5UNT64IBYK1ITGalpGH7zKRcDw_9dDViL27ld8fir_lYrTPp/exec';

const CONFIG_URL =
  process.env.GOOGLE_CONFIG_URL ||
  'https://script.google.com/macros/s/AKfycbxAIANRmjl_FIzeEsbC5UNT64IBYK1ITGalpGH7zKRcDw_9dDViL27ld8fir_lYrTPp/exec';

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

function normalizePhone(p){ return (p || '').replace(/\D/g, ''); }
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
  const vipMap = vips.filter(v => v.phone).map(v => `${normalizePhone(v.phone)}=${v.name}`).join(', ');
  const lines = [
    system_prompt || 'You are Trinity.',
    ENGLISH_GUARD,
    VIP_SKIP_NUMBER,
    vipMap ? `VIP numbers: ${vipMap}.` : ''
  ];
  if (callerNumber) lines.push(`[CALL CONTEXT] CallerID: ${normalizePhone(callerNumber)}.`);
  if (callerVip) lines.push(`[CALL CONTEXT] Recognized VIP: ${callerVip.name} (${callerVip.relationship}). Skip number verification.`);
  return lines.filter(Boolean).join('\n');
}

/* ================= Greeting filter ================= */
const GREETING_PREFIXES = [
  "Hi, this is Trinity, Dan Herlihy's A.I. assistant",
  "Hi, this is Trinity, Dan Hurley AI assistant",
  "Hi, this is Trinity, Dan Herlihy AI assistant",
  "Hi this is Trinity, Dan Herlihy",
];
function isGreeting(line) {
  const lower = (line || '').toLowerCase();
  return GREETING_PREFIXES.some(p => lower.startsWith(p.toLowerCase())) ||
         (lower.includes('this is trinity') && lower.includes('assistant'));
}

/* ================= Transcript store (now timeline events) ================= */
// Map<CallSid, {
//   events: Array<{ role:'assistant'|'caller', text:string, ts:number }>,
//   greetingSkipped: boolean,
//   meta: { from: string, to: string, callerName: string }
// }>
const transcripts = new Map();

/* ================= Telegram helper ================= */
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('Telegram env not set; skipping send.'); return; }
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  const MAX = 3800;
  for (let i = 0; i < text.length; i += MAX) {
    const part = text.slice(i, i + MAX);
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: part })
      });
    } catch (e) {
      console.log('Telegram send failed:', e?.message);
    }
  }
}
function displayNameAndNumber(name, num){
  const n = (name || '').trim();
  const p = (num || '').trim();
  if (n && p) return `${n} (${p})`;
  if (n) return n;
  if (p) return p;
  return 'Unknown';
}

/* ================= Interleaved transcript rendering ================= */
const COALESCE_WINDOW_MS = 2000; // merge adjacent same-role chunks within 2s

function buildInterleavedTranscript(events) {
  if (!Array.isArray(events) || events.length === 0) return '';

  // 1) sort by timestamp
  const sorted = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // 2) coalesce adjacent same-role chunks (within window)
  const merged = [];
  for (const e of sorted) {
    const role = e.role === 'assistant' ? 'Assistant' : 'Caller';
    const text = (e.text || '').trim();
    if (!text) continue;

    const last = merged[merged.length - 1];
    if (last && last.role === role && (e.ts - last.tsLast) <= COALESCE_WINDOW_MS) {
      last.text += (last.text.endsWith('-') ? '' : ' ') + text;
      last.tsLast = e.ts;
    } else {
      merged.push({ role, text, tsFirst: e.ts, tsLast: e.ts });
    }
  }

  // 3) render as alternating blocks
  return merged.map(turn => `${turn.role}:\n${turn.text}`).join('\n\n');
}

/* ================= /transcripts webhook ================= */
app.post('/transcripts', async (req, res) => {
  try {
    const ev = req.body.TranscriptionEvent || req.body.transcriptionevent || '';
    const callSid = req.body.CallSid || req.body.callsid || '';
    if (!callSid) { console.log('TRANSCRIPT: missing CallSid'); return res.status(200).send('ok'); }

    // Ensure buffer & meta (prefer query params if present)
    if (!transcripts.has(callSid)) {
      transcripts.set(callSid, { events: [], greetingSkipped: false, meta: { from: '', to: '', callerName: '' } });
    }
    const buf = transcripts.get(callSid);

    // Pick meta from query (Function attached these) or body fallbacks
    const q = req.query || {};
    const fromQ = q.from || req.body.From || req.body.from || '';
    const toQ = q.to || req.body.To || req.body.to || '';
    const callerNameQ = q.callerName || req.body.CallerName || req.body.caller_name || '';

    if (fromQ && !buf.meta.from) buf.meta.from = fromQ;
    if (toQ && !buf.meta.to) buf.meta.to = toQ;
    if (callerNameQ && !buf.meta.callerName) buf.meta.callerName = callerNameQ;

    if (ev === 'transcription-started') {
      console.log('TRANSCRIPT started', callSid);
      return res.status(200).send('ok');
    }

    if (ev === 'transcription-content') {
      let text = '';
      try {
        if (req.body.TranscriptionData) {
          const d = JSON.parse(req.body.TranscriptionData);
          text = d?.transcript || d?.text || '';
        }
      } catch (_) {}
      if (!text && req.body.TranscriptionText) text = req.body.TranscriptionText;

      const line = (text || '').trim();
      if (!line) return res.status(200).send('ok');

      const track = (req.body.Track || req.body.track || '').toLowerCase(); // inbound_track | outbound_track

      // Drop first assistant greeting
      if (track === 'outbound_track' && !buf.greetingSkipped && isGreeting(line)) {
        buf.greetingSkipped = true;
        return res.status(200).send('ok');
      }

      // Determine role
      let role = null;
      if (track === 'inbound_track') role = 'caller';
      else if (track === 'outbound_track') role = 'assistant';

      if (role) {
        buf.events.push({ role, text: line, ts: Date.now() });
      } else {
        // Unknown track; append as caller by default to avoid losing content
        buf.events.push({ role: 'caller', text: line, ts: Date.now() });
      }

      return res.status(200).send('ok');
    }

    if (ev === 'transcription-stopped' || ev === 'transcription-error') {
      console.log('TRANSCRIPT finished', callSid, ev);

      // Build interleaved transcript
      const transcript = buildInterleavedTranscript(buf.events);

      // Post to Google Apps Script with meta so columns fill
      try {
        const form = new URLSearchParams();
        form.set('CallSid', callSid);
        form.set('From', buf.meta.from || '');
        form.set('To', buf.meta.to || '');
        form.set('CallerName', buf.meta.callerName || '');
        form.set('transcript', transcript || '');
        await fetch(GOOGLE_APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
      } catch (e) {
        console.log('Apps Script POST failed:', e?.message);
      }

      // Telegram header now includes From / To / CallerName
      const header =
        `📞 New Call\n` +
        `From: ${displayNameAndNumber(buf.meta.callerName, buf.meta.from)}\n` +
        `To: ${buf.meta.to || 'Unknown'}\n` +
        `CallSid: ${callSid}\n\n`;
      await sendTelegramMessage(header + (transcript || '(empty)'));

      transcripts.delete(callSid);
      return res.status(200).send('ok');
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.log('TRANSCRIPT handler error:', e?.message);
    return res.status(200).send('ok');
  }
});

/* ================= WebSocket bridge ================= */
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWS, req) => {
  console.log('WS: connection from', req.socket.remoteAddress);

  let streamSid = null;
  let callerFrom = null;
  let callerVip = null;
  const counters = { frames: 0, sentChunks: 0 };

  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
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

    console.log(`Applying session config (${reason}) -> voice=${selectedVoice}` + (callerVip ? `, VIP=${callerVip.name}` : '') + `, instructions length: ${instructions.length}`);

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
            const getP = (n) => (Array.isArray(params) ? params.find(p => p?.name === n) : null)?.value || '';
            const from  = getP('from');
            const to    = getP('to');
            const callerName = getP('callerName');
            const callSid = getP('callSid');

            if (from) console.log('CallerID (From) received:', from);
            callerFrom = from;

            if (callSid) {
              if (!transcripts.has(callSid)) {
                transcripts.set(callSid, { events: [], greetingSkipped: false, meta: { from: '', to: '', callerName: '' } });
              }
              const buf = transcripts.get(callSid);
              if (from && !buf.meta.from) buf.meta.from = from;
              if (to && !buf.meta.to) buf.meta.to = to;
              if (callerName && !buf.meta.callerName) buf.meta.callerName = callerName;
            }
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
const server = createServer(app);
server.listen(PORT, () => console.log(`Trinity gateway listening on :${PORT}`));
