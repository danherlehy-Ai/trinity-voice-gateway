import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import https from 'node:https'; // NEW: fallback for Twilio REST

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

/* ====== Varied conversational openings ====== */
const OPENING_VARIANTS = [
  'Warm, upbeat hello; concise and helpful.',
  'Friendly, professional greeting; offer assistance.',
  'Conversational opener; one short clause of small talk.',
  'Confident and to the point; ready to help.',
  'Cheerful but calm; acknowledge returning callers if recognized.'
];
function pickOpening() {
  return OPENING_VARIANTS[Math.floor(Math.random() * OPENING_VARIANTS.length)];
}
function safeName({ callerVip, callerName, callerFrom }) {
  if (callerVip?.name) return callerVip.name;
  if (callerName && String(callerName).trim()) return String(callerName).trim();
  if (callerFrom && String(callerFrom).trim()) return String(callerFrom).trim();
  return 'there';
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

/* ============== Transcript store + idle state (timeline + meta) ============== */
// Map<CallSid, { events: Array<{role:'assistant'|'caller', text:string, ts:number}>, greetingSkipped:boolean, meta:{from,to,callerName}, lastActivityAt:number, idleTimer:any, aiWS?:WebSocket, twilioWS?:WebSocket }>
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
  const sorted = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0));
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
  return merged.map(turn => `${turn.role}:\n${turn.text}`).join('\n\n');
}

/* ================= Idle hang-up settings (env) ================= */
const IDLE_HANGUP_SECS = Math.max(1, Number(process.env.IDLE_HANGUP_SECS || 10));
const IDLE_SEND_GOODBYE = String(process.env.IDLE_SEND_GOODBYE || 'true').toLowerCase() === 'true';
const GOODBYE_LINE = process.env.IDLE_GOODBYE_LINE || "Thanks for calling — happy to help next time. Goodbye!";

/* ================= Twilio hang-up helper (fetch + https fallback) ================= */
async function hangupCall(callSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    console.log('Missing TWILIO_ACCOUNT_SID/AUTH_TOKEN; cannot hang up.');
    return false;
  }
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const path = `/2010-04-01/Accounts/${accountSid}/Calls/${encodeURIComponent(callSid)}.json`;

  // 1) Try fetch
  try {
    const url = `https://api.twilio.com${path}`;
    const form = new URLSearchParams();
    form.set('Status', 'completed');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: form.toString()
    });
    const bodyText = await resp.text();
    console.log('Twilio hangup via fetch:', resp.status, bodyText.slice(0,200));
    return resp.ok;
  } catch (e) {
    console.log('Fetch to Twilio failed, falling back to https:', e?.message);
  }

  // 2) Fallback to core https
  return await new Promise((resolve) => {
    const postData = 'Status=completed';
    const options = {
      hostname: 'api.twilio.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        console.log('Twilio hangup via https:', res.statusCode, data.slice(0,200));
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
    });
    req.on('error', (err) => {
      console.log('HTTPS fallback error:', err?.message);
      resolve(false);
    });
    req.write(postData);
    req.end();
  });
}

/* ================= Idle helpers ================= */
function getState(callSid) {
  if (!transcripts.has(callSid)) {
    transcripts.set(callSid, {
      events: [],
      greetingSkipped: false,
      meta: { from: '', to: '', callerName: '' },
      lastActivityAt: Date.now(),
      idleTimer: null,
      aiWS: undefined,
      twilioWS: undefined
    });
  }
  return transcripts.get(callSid);
}
function bumpActivity(callSid, reason) {
  const s = getState(callSid);
  s.lastActivityAt = Date.now();
  resetIdleTimer(callSid);
}
function resetIdleTimer(callSid) {
  const s = getState(callSid);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => triggerIdle(callSid), IDLE_HANGUP_SECS * 1000);
}
async function triggerIdle(callSid) {
  const s = transcripts.get(callSid);
  if (!s) return;

  console.log(`IDLE timeout for ${callSid} after ${IDLE_HANGUP_SECS}s`);

  try {
    if (IDLE_SEND_GOODBYE && s.aiWS && s.aiWS.readyState === 1) {
      s.aiWS.send(JSON.stringify({
        type: 'response.create',
        response: { instructions: GOODBYE_LINE }
      }));
      await new Promise(r => setTimeout(r, 1500)); // let audio play
    }
  } catch (e) {
    console.log('Idle goodbye send failed:', e?.message);
  }

  const ok = await hangupCall(callSid);
  if (!ok) console.log('Hangup REST still failed; sockets will close when Twilio ends the call.');

  try { s.aiWS?.close?.(); } catch {}
  try { s.twilioWS?.close?.(); } catch {}
}

/* ================= /transcripts webhook ================= */
app.post('/transcripts', async (req, res) => {
  try {
    const ev = req.body.TranscriptionEvent || req.body.transcriptionevent || '';
    const callSid = req.body.CallSid || req.body.callsid || '';
    if (!callSid) { console.log('TRANSCRIPT: missing CallSid'); return res.status(200).send('ok'); }

    const buf = getState(callSid);

    // Meta from query/body
    const q = req.query || {};
    const fromQ = q.from || req.body.From || req.body.from || '';
    const toQ = q.to || req.body.To || req.body.to || '';
    const callerNameQ = q.callerName || req.body.CallerName || req.body.caller_name || '';
    if (fromQ && !buf.meta.from) buf.meta.from = fromQ;
    if (toQ && !buf.meta.to) buf.meta.to = toQ;
    if (callerNameQ && !buf.meta.callerName) buf.meta.callerName = callerNameQ;

    if (ev === 'transcription-started') {
      console.log('TRANSCRIPT started', callSid);
      bumpActivity(callSid, 'start');
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
      if (!line) { bumpActivity(callSid, 'empty'); return res.status(200).send('ok'); }

      const track = (req.body.Track || req.body.track || '').toLowerCase(); // inbound_track | outbound_track

      if (track === 'outbound_track' && !buf.greetingSkipped && isGreeting(line)) {
        buf.greetingSkipped = true;
        bumpActivity(callSid, 'greeting-skip');
        return res.status(200).send('ok');
      }

      let role = null;
      if (track === 'inbound_track') role = 'caller';
      else if (track === 'outbound_track') role = 'assistant';
      if (role) buf.events.push({ role, text: line, ts: Date.now() });
      else      buf.events.push({ role: 'caller', text: line, ts: Date.now() });

      bumpActivity(callSid, 'speech');
      return res.status(200).send('ok');
    }

    if (ev === 'transcription-stopped' || ev === 'transcription-error') {
      console.log('TRANSCRIPT finished', callSid, ev);

      const transcript = buildInterleavedTranscript(buf.events);

      try {
        const form = new URLSearchParams();
        form.set('CallSid', callSid);
        form.set('From', buf.meta.from || '');
        form.set('To', buf.meta.to || '');
        form.set('CallerName', buf.meta.callerName || '');
        form.set('transcript', transcript || '');
        await fetch(GOOGLE_APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-ww
