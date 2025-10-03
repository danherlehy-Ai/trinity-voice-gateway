import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import https from 'node:https';

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
// Increased limits to avoid 413s from transcription payloads
app.use(express.urlencoded({ extended: false, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));

app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Stream status callback (from <Stream statusCallback="...">)
app.post('/stream-status', (req, res) => {
  try {
    const b = req.body || {};
    console.log(
      'STREAM STATUS:',
      'event=', b.Event || b.event,
      'streamSid=', b.StreamSid || b.streamSid,
      'callSid=', b.CallSid || b.callSid,
      'startTime=', b.StartTime || b.startTime,
      'stopReason=', b.StopReason || b.stopReason
    );
  } catch (e) {
    console.log('STREAM STATUS parse error:', e?.message);
  }
  res.status(204).end();
});

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

/* ============== Transcript store + idle + DNC state ============== */
// Map<CallSid, { events: Array<{role:'assistant'|'caller', text:string, ts:number}>, greetingSkipped:boolean,
//   meta:{from,to,callerName}, lastActivityAt:number, idleTimer:any, aiWS?:WebSocket, twilioWS?:WebSocket,
//   dnc: { attempted:boolean, reason?:string } }>
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
const COALESCE_WINDOW_MS = 2000;
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

/* ================= Idle hang-up settings ================= */
const IDLE_HANGUP_SECS = Math.max(1, Number(process.env.IDLE_HANGUP_SECS || 30));
const IDLE_SEND_GOODBYE = String(process.env.IDLE_SEND_GOODBYE || 'true').toLowerCase() === 'true';
const GOODBYE_LINE = process.env.IDLE_GOODBYE_LINE || "Thanks for calling — happy to help next time. Goodbye!";

/* ================= Auto-DNC env & helpers ================= */
const AUTO_DNC_ENABLE       = String(process.env.AUTO_DNC_ENABLE || 'true').toLowerCase() === 'true';
const AUTO_DNC_ON_CNAM      = String(process.env.AUTO_DNC_ON_CNAM || 'true').toLowerCase() === 'true';
const AUTO_DNC_ONLY_PHRASE  = String(process.env.AUTO_DNC_ONLY_ON_PHRASE || 'false').toLowerCase() === 'true';
const AUTO_DNC_DIGITS       = (process.env.AUTO_DNC_DIGITS || '9,8').split(',').map(s => s.trim()).filter(Boolean);
const AUTO_DNC_GAP_MS       = Math.max(0, Number(process.env.AUTO_DNC_GAP_MS || 250));
const DNC_HANGUP_AFTER      = String(process.env.DNC_HANGUP_AFTER || 'true').toLowerCase() === 'true';
const DNC_SAY_LINE          = process.env.DNC_SAY_LINE || 'Please remove this number from your call list. Thank you.';

const DNC_PHRASES = [
  /press\s*(9|nine)\b.*(remove|do\s*not\s*call|opt[-\s]*out|unsubscribe|do\s*not\s*contact)/i,
  /(to|please)\s*(be\s*)?(removed|remove\s*me)\b.*(list|database|call)/i,
  /\bopt[-\s]*out\b/i,
  /\bdo\s*not\s*call\b/i,
  /\bunsubscribe\b/i,
  /to\s*be\s*removed\b/i
];
function isRemovalPhrase(text='') {
  const t = String(text || '');
  return DNC_PHRASES.some(rx => rx.test(t));
}
function isCnamSpam(name='') {
  const t = String(name || '').toLowerCase();
  return /spam|scam/.test(t);
}
function buildDigitsString(digitsArr, gapMs) {
  // 'w' ≈ 0.5s wait in Twilio <Play digits="">
  const waits = Math.max(1, Math.round(gapMs / 500));
  const sep = 'w'.repeat(waits);
  return digitsArr.join(sep);
}

/* ================= Twilio REST helpers ================= */
function twilioAuthHeader() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return {
    accountSid,
    basic: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  };
}
async function twilioUpdateCallTwiml(callSid, twiml) {
  const auth = twilioAuthHeader();
  if (!auth) { console.log('Missing Twilio creds; cannot update call TwiML'); return false; }
  const path = `/2010-04-01/Accounts/${auth.accountSid}/Calls/${encodeURIComponent(callSid)}.json`;
  // Try fetch
  try {
    const url = `https://api.twilio.com${path}`;
    const form = new URLSearchParams();
    form.set('Twiml', twiml);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': auth.basic,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: form.toString()
    });
    const bodyText = await resp.text();
    console.log('Twilio update (Twiml) via fetch:', resp.status, bodyText.slice(0,200));
    return resp.ok;
  } catch (e) {
    console.log('Twilio update fetch failed, falling back to https:', e?.message);
  }
  // Fallback
  return await new Promise((resolve) => {
    const postData = 'Twiml=' + encodeURIComponent(twiml);
    const options = {
      hostname: 'api.twilio.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Authorization': auth.basic,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        console.log('Twilio update (Twiml) via https:', res.statusCode, data.slice(0,200));
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
    });
    req.on('error', (err) => { console.log('HTTPS Twiml update error:', err?.message); resolve(false); });
    req.write(postData);
    req.end();
  });
}
async function hangupCall(callSid) {
  const auth = twilioAuthHeader();
  if (!auth) { console.log('Missing Twilio creds; cannot hang up.'); return false; }
  const path = `/2010-04-01/Accounts/${auth.accountSid}/Calls/${encodeURIComponent(callSid)}.json`;
  try {
    const url = `https://api.twilio.com${path}`;
    const form = new URLSearchParams();
    form.set('Status', 'completed');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': auth.basic,
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
  return await new Promise((resolve) => {
    const postData = 'Status=completed';
    const options = {
      hostname: 'api.twilio.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Authorization': auth.basic,
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
    req.on('error', (err) => { console.log('HTTPS fallback error:', err?.message); resolve(false); });
    req.write(postData);
    req.end();
  });
}

/* ============== Idle helpers ============== */
function getState(callSid) {
  if (!transcripts.has(callSid)) {
    transcripts.set(callSid, {
      events: [],
      greetingSkipped: false,
      meta: { from: '', to: '', callerName: '' },
      lastActivityAt: Date.now(),
      idleTimer: null,
      aiWS: undefined,
      twilioWS: undefined,
      dnc: { attempted: false, reason: '' }
    });
  }
  return transcripts.get(callSid);
}
function bumpActivity(callSid, _reason) {
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
  if (s.dnc.attempted) return; // DNC flow will own the end

  console.log(`IDLE timeout for ${callSid} after ${IDLE_HANGUP_SECS}s`);
  try {
    if (IDLE_SEND_GOODBYE && s.aiWS && s.aiWS.readyState === 1) {
      s.aiWS.send(JSON.stringify({ type: 'response.create', response: { instructions: GOODBYE_LINE } }));
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) { console.log('Idle goodbye send failed:', e?.message); }

  const ok = await hangupCall(callSid);
  if (!ok) console.log('Hangup REST still failed; sockets will close when Twilio ends the call.');

  try { s.aiWS?.close?.(); } catch {}
  try { s.twilioWS?.close?.(); } catch {}
}

/* ============== Auto-DNC: core action ============== */
async function sendDncDigitsAndMaybeHangup(callSid, reason, digitsArr = AUTO_DNC_DIGITS) {
  const s = getState(callSid);
  if (s.dnc.attempted) return; // avoid double-fire
  s.dnc.attempted = true;
  s.dnc.reason = reason;

  // Build digits string with 'w' waits (≈0.5s) between digits
  const digits = buildDigitsString(digitsArr, AUTO_DNC_GAP_MS);

  const sayLine = `<Say language="en-US" voice="Polly.Joanna">${escapeXml(DNC_SAY_LINE)}</Say>`;
  const playDigits = `<Play digits="${escapeXml(digits)}"/>`;
  const hang = DNC_HANGUP_AFTER ? '<Hangup/>' : '';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>${sayLine}${playDigits}${hang}</Response>`;

  console.log(`AUTO-DNC firing for ${callSid} reason=${reason} digits=${digits}`);

  // Stop idle timer; DNC flow controls the rest of the call
  if (s.idleTimer) { try { clearTimeout(s.idleTimer); } catch {} s.idleTimer = null; }

  // Redirect the live call to the TwiML above
  const ok = await twilioUpdateCallTwiml(callSid, twiml);
  if (!ok) console.log('Auto-DNC Twiml update failed; call may continue.');

  // Log to Google Sheet
  try {
    const form = new URLSearchParams();
    form.set('CallSid', callSid);
    form.set('From', s.meta.from || '');
    form.set('To', s.meta.to || '');
    form.set('CallerName', s.meta.callerName || '');
    form.set('dnc_attempted', 'true');
    form.set('dnc_result', `auto:${reason}; digits:${digits}`);
    await fetch(GOOGLE_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
  } catch (e) { console.log('Apps Script DNC log failed:', e?.message); }

  // Close sockets shortly after redirect
  setTimeout(() => {
    try { s.aiWS?.close?.(); } catch {}
    try { s.twilioWS?.close?.(); } catch {}
  }, 2000);
}
function escapeXml(s='') {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
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
      } catch {}
      if (!text && req.body.TranscriptionText) text = req.body.TranscriptionText;

      const line = (text || '').trim();
      if (!line) { bumpActivity(callSid, 'empty'); return res.status(200).send('ok'); }

      const track = (req.body.Track || req.body.track || '').toLowerCase(); // inbound_track | outbound_track

      // Skip our fixed Twilio greeting
      if (track === 'outbound_track' && !buf.greetingSkipped && isGreeting(line)) {
        buf.greetingSkipped = true;
        bumpActivity(callSid, 'greeting-skip');
        return res.status(200).send('ok');
      }

      // Save event (timeline)
      let role = null;
      if (track === 'inbound_track') role = 'caller';
      else if (track === 'outbound_track') role = 'assistant';
      if (role) buf.events.push({ role, text: line, ts: Date.now() });
      else      buf.events.push({ role: 'caller', text: line, ts: Date.now() });

      bumpActivity(callSid, 'speech');

      // Aggressive auto-DNC: phrase detector (caller or assistant text)
      if (AUTO_DNC_ENABLE && isRemovalPhrase(line)) {
        await sendDncDigitsAndMaybeHangup(callSid, 'phrase');
      }

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
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
      } catch (e) { console.log('Apps Script POST failed:', e?.message); }

      const header =
        `📞 New Call\n` +
        `From: ${displayNameAndNumber(buf.meta.callerName, buf.meta.from)}\n` +
        `To: ${buf.meta.to || 'Unknown'}\n` +
        `CallSid: ${callSid}\n\n`;
      await sendTelegramMessage(header + (transcript || '(empty)'));

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
  let callerName = null;
  const counters = { frames: 0, sentChunks: 0 };

  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  const aiWS = new WebSocket(OPENAI_URL, { headers, perMessageDeflate: false });

  let aiReady = false;
  let latestConfig = null;
  let currentCallSid = null;

  async function applySessionConfig(reason) {
    if (!aiReady) return;
    if (!latestConfig) latestConfig = await getConfigCached();

    if (callerFrom && latestConfig.vips?.length) {
      const norm = normalizePhone(callerFrom);
      const found = latestConfig.vips.find(v => normalizePhone(v.phone) === norm);
      if (found) callerVip = found;
    }

    const selectedVoice = chooseVoice(process.env.DEFAULT_VOICE || 'marin', callerVip);
    const base = buildInstructions(latestConfig.system_prompt, latestConfig.vips, callerFrom, callerVip);

    const opening = pickOpening();
    const nameHint = safeName({ callerVip, callerName, callerFrom });
    const vipNotes = callerVip?.persona_notes
      ? `If appropriate, you may naturally reference ONE brief, appropriate detail from VIP notes: "${String(callerVip.persona_notes)}". Do not over-share; keep it tasteful and relevant.`
      : '';
    const openingDirective =
      `OPENING STYLE: ${opening}\n` +
      `After the phone greeting has played, begin with a short, varied first line. ` +
      `Address the caller by name if known (e.g., "Hi ${nameHint}!"). Keep it conversational and concise (≈1 sentence). ` +
      `Vary your phrasing each call; avoid repeating the exact same words within a call. ${vipNotes}`;

    const finalInstructions = [base, openingDirective].filter(Boolean).join('\n');

    console.log(`Applying session config (${reason}) -> voice=${selectedVoice}` +
      (callerVip ? `, VIP=${callerVip.name}` : '') + `, instr len=${finalInstructions.length}`);

    aiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: selectedVoice,
        turn_detection: { type: 'server_vad', threshold: 0.6 },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions: finalInstructions
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

    // assistant audio is "activity"
    if (isBinary) {
      sendPcm16kBinaryToTwilioAsUlaw(raw, twilioWS, streamSid, counters);
      if (currentCallSid) bumpActivity(currentCallSid, 'ai-binary');
      return;
    }
    try {
      const msg = JSON.parse(raw.toString());
      if (!['response.audio.delta', 'response.output_audio.delta'].includes(msg?.type)) {
        console.log('AI event:', msg?.type);
      }
      if (msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta') {
        const b64 = msg.delta || msg.audio;
        if (b64) {
          chunkAndSendUlawBase64ToTwilio(b64, twilioWS, streamSid, counters);
          if (currentCallSid) bumpActivity(currentCallSid, 'ai-delta');
        }
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
            const callerNameParam = getP('callerName');
            const callSid = getP('callSid');

            currentCallSid = callSid || currentCallSid;
            if (from) console.log('CallerID (From) received:', from);
            callerFrom = from;
            callerName = callerNameParam || callerName;

            if (currentCallSid) {
              const s = getState(currentCallSid);
              s.aiWS = aiWS;
              s.twilioWS = twilioWS;
              if (from && !s.meta.from) s.meta.from = from;
              if (to && !s.meta.to) s.meta.to = to;
              if (callerNameParam && !s.meta.callerName) s.meta.callerName = callerNameParam;
              resetIdleTimer(currentCallSid);
            }

            // Aggressive auto-DNC on CNAM if allowed and not phrase-only
            if (AUTO_DNC_ENABLE && AUTO_DNC_ON_CNAM && !AUTO_DNC_ONLY_PHRASE) {
              const s = getState(currentCallSid);
              if (isCnamSpam(s.meta.callerName)) {
                await sendDncDigitsAndMaybeHangup(currentCallSid, 'cnam');
              }
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
            if (currentCallSid) bumpActivity(currentCallSid, 'caller-media');
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
    console.log('WS: connection closed');
  });
  twilioWS.on('error', (err) => console.log('WS: error', err?.message));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Trinity gateway listening on :${PORT}`));
