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
app.use(express.urlencoded({ extended: false, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));

app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/stream-status', (req, res) => {
  try {
    const b = req.body || {};
    console.log(
      'STREAM STATUS:',
      'event=', b.Event || b.event,
      'streamSid=', b.StreamSid || b.streamSid,
      'callSid=', b.CallSid || b.callSid,
      'startTime=', b.StartTime || b.startTime,
      'stopReason=', b.StopReason || b.stopreason || b.stopReason
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

// ✅ default cache 20 seconds (env override supported)
const CONFIG_TTL_MS = Math.max(1000, Number(process.env.CONFIG_TTL_MS || 20000));

async function fetchConfigFresh() {
  // ✅ Cache-buster avoids intermediary caching on Google Apps Script
  const url = CONFIG_URL + (CONFIG_URL.includes('?') ? '&' : '?') + 't=' + Date.now();

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Cache-Control': 'no-store' }
  });

  if (!res.ok) throw new Error(`Config HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.ok) throw new Error(`Config error: ${JSON.stringify(json)}`);

  const system_prompt = String(json.system_prompt || '');
  const vips = Array.isArray(json.vips) ? json.vips : [];
  const businesses = Array.isArray(json.businesses) ? json.businesses : [];
  console.log(`Config OK: prompt=${system_prompt.length} chars, vips=${vips.length}, businesses=${businesses.length}`);
  return { system_prompt, vips, businesses };
}

async function getConfigCached({ forceFresh = false } = {}) {
  const now = Date.now();
  if (!forceFresh && _configCache.data && now - _configCache.when < CONFIG_TTL_MS) return _configCache.data;
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
    await getConfigCached({ forceFresh: true });
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

// Normalize anything to digits only
function normalizeDigits(p){ return String(p ?? '').replace(/\D/g, ''); }
// Normalize to last-10 digits (US-friendly). Fixes +1 / 1 / dashes / etc.
function normalizeLast10(p){
  const d = normalizeDigits(p);
  if (!d) return '';
  return d.length <= 10 ? d : d.slice(-10);
}

function last4Of(phone='') {
  const d = normalizeDigits(phone);
  if (!d) return '';
  return d.slice(-4);
}

// ✅ Add cedar to allowed voices
const ALLOWED_VOICES = new Set([
  'marin','cedar','echo','alloy','ash','ballad','coral','fable','onyx','nova','sage','shimmer','verse'
]);

function chooseVoice(defaultVoice, vip) {
  const def = (defaultVoice || 'marin').toLowerCase();
  const safeDefault = ALLOWED_VOICES.has(def) ? def : 'marin';

  if (!vip) return safeDefault;

  const raw = String(vip?.voice_override || '').trim().toLowerCase();
  if (!raw) return safeDefault;

  // Back-compat: "male" / "female"
  if (raw === 'male') {
    const male = String(process.env.MALE_VOICE || 'ballad').toLowerCase();
    return ALLOWED_VOICES.has(male) ? male : 'ballad';
  }
  if (raw === 'female') return safeDefault;

  // Named voice override
  if (ALLOWED_VOICES.has(raw)) return raw;

  return safeDefault;
}

// Returns true ONLY if VIP explicitly set a usable override (named voice OR male/female)
function hasVipVoiceOverride(vip) {
  const raw = String(vip?.voice_override || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'male' || raw === 'female') return true;
  return ALLOWED_VOICES.has(raw);
}

// Display name for announcing voice (Ballad, Sage, etc.)
function displayVoiceName(voice) {
  const v = String(voice || '').trim();
  if (!v) return 'Trinity';
  const lower = v.toLowerCase();
  // Title-case the voice name
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/* === Strict last-4 policy & “no hallucination” rules === */
const DIGIT_PAUSE_POLICY =
  'WHEN CALLER RECITES DIGITS (like a phone number or code), DO NOT INTERRUPT. ' +
  'Stay silent until they finish; wait ~2 seconds after their last digit before replying.';

const NO_HALLUCINATION_LAST4 =
  'CALLER-ID LAST-4 POLICY: Use ONLY the server-provided last four digits when confirming a number. ' +
  'You will see [CALL CONTEXT] lines: "CallerID_AVAILABLE: true|false" and "CallerID_LAST4_VERIFIED: ####". ' +
  'If CallerID_AVAILABLE is true, say exactly: “I have your number ending in {####} — is that right?”. ' +
  'If CallerID_AVAILABLE is false, say: “Caller ID didn’t show a number on my end.” DO NOT GUESS or invent digits. ' +
  'NEVER transform or infer digits beyond what is provided. If unsure, state that Caller ID did not appear.';

const CALLBACK_POLICY =
  'CLOSING CAPTURE: Do NOT ask the caller to read their number. Confirm the server-provided last four as above. ' +
  'Then confirm their name (use what they already gave if possible) and ask for the best DATE and TIME to call back. ' +
  'If they say the number is different, politely collect their correct number ONCE and move on.';

const HARD_BANS =
  'NEVER ASK: “What’s your number?”, “Can I get your phone number?”, or similar, unless the caller says caller ID is wrong. ' +
  'If you begin to ask, stop and use the last-4 confirmation flow.';

// IMPORTANT: DO NOT greet using phone numbers.
function safeVipName(vip){
  const n = String(vip?.name || '').trim();
  if (!n) return '';
  return n.split(/\s+/)[0]; // first name token
}

// optional “tone/vibe” column support
function safeVipVibe(vip){
  const v = String(vip?.vibe || vip?.tone || '').trim();
  return v;
}

/**
 * Build the base instruction block.
 * NOTE: identity stickiness is enforced by a separate IDENTITY_LOCK block appended later.
 */
function buildInstructions(system_prompt, vips, callerNumberRaw, callerVip, extraCallContext = '') {
  const vipMap = (Array.isArray(vips) ? vips : [])
    .filter(v => v && v.phone != null)
    .map(v => `${normalizeLast10(v.phone)}=${String(v.name || '').trim()}`)
    .join(', ');

  const BREVITY_RULES =
    'BREVITY: Keep each reply to 1–2 short sentences (≤ ~40 words). Answer concisely, then pause.';
  const INTERRUPT_RULES =
    'INTERRUPTIONS: Stop speaking immediately if the caller talks. Keep phrases tight so barge-in feels natural.';

  const lines = [
    system_prompt || 'You are Trinity.',
    ENGLISH_GUARD,
    DIGIT_PAUSE_POLICY,
    NO_HALLUCINATION_LAST4,
    CALLBACK_POLICY,
    HARD_BANS,
    BREVITY_RULES,
    INTERRUPT_RULES,
    vipMap ? `VIP numbers (last-10): ${vipMap}.` : ''
  ];

  const norm10 = normalizeLast10(callerNumberRaw || '');
  const last4 = norm10.slice(-4);
  const available = Boolean(last4);
  lines.push(`[CALL CONTEXT] CallerID_AVAILABLE: ${available}`);
  if (available) {
    lines.push(`[CALL CONTEXT] CallerID_LAST10: ${norm10}.`);
    lines.push(`[CALL CONTEXT] CallerID_LAST4_VERIFIED: ${last4}.`);
  }

  if (callerVip) {
    lines.push(`[CALL CONTEXT] Recognized VIP: ${String(callerVip.name)} (${String(callerVip.relationship || 'VIP')}).`);
  }

  if (extraCallContext) lines.push(extraCallContext);

  return lines.filter(Boolean).join('\n');
}

/* ====== Friendly opening variety ====== */
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

/* ================= Greeting filter ================= */
function normalizeGreetingText(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ');
}

function isGreeting(line) {
  const t = normalizeGreetingText(line);

  // Trinity variants (old + new)
  if (t.includes("this is trinity")) return true;
  if (t.includes("it's trinity")) return true;
  if (t.includes("dan herlihy") && t.includes("ai") && t.includes("assistant")) return true;

  // New “Dan hasn’t picked up yet” intros
  if (t.includes("dan hasn't picked up") && (t.includes("it's trinity") || t.includes("this is trinity"))) return true;

  // VIP Assistant intros (any voice name)
  if (t.includes("dan hasn't picked up") && t.includes("vip assistant")) return true;

  // Legacy prefixes you had
  const LEGACY_PREFIXES = [
    "hi, this is trinity, dan herlihy's a.i. assistant",
    "hi, this is trinity, dan hurley ai assistant",
    "hi, this is trinity, dan herlihy ai assistant",
    "hi this is trinity, dan herlihy",
  ];
  return LEGACY_PREFIXES.some(p => t.startsWith(p));
}

/* ============== Transcript store + idle + DNC + number-mode state ============== */
const transcripts = new Map();

/* ================= Telegram helper + time formatting ================= */
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

async function sendTelegramAudio(buffer, filename = 'call-recording.mp3', caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('Telegram env not set; skipping audio send.'); return false; }

  const endpoint = `https://api.telegram.org/bot${token}/sendAudio`;

  try {
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption);

    const blobType =
      filename.toLowerCase().endsWith('.wav') ? 'audio/wav' :
      filename.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' :
      'application/octet-stream';

    const blob = new Blob([buffer], { type: blobType });
    form.set('audio', blob, filename);

    const resp = await fetch(endpoint, { method: 'POST', body: form });
    const txt = await resp.text();
    if (!resp.ok) {
      console.log('Telegram sendAudio failed:', resp.status, txt.slice(0, 400));
      return false;
    }
    return true;
  } catch (e) {
    console.log('Telegram sendAudio exception:', e?.message);
    return false;
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

const TELEGRAM_TZ = process.env.TELEGRAM_TZ || 'America/New_York';
function formatLocalDateTime(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TELEGRAM_TZ,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit'
    }).format(d);
  } catch {
    return new Date(d).toLocaleString('en-US', { hour12: true });
  }
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
const IDLE_HANGUP_SECS = Math.max(1, Number(process.env.IDLE_HANGUP_SECS || 180));
const IDLE_SEND_GOODBYE = String(process.env.IDLE_SEND_GOODBYE || 'true').toLowerCase() === 'true';
const GOODBYE_LINE = process.env.IDLE_GOODBYE_LINE || "Thanks for calling — happy to help next time. Goodbye!";

/* ================= Auto-Press (DNC/opt-out) env & helpers ================= */
const AUTO_DNC_ENABLE       = String(process.env.AUTO_DNC_ENABLE || 'true').toLowerCase() === 'true';
const AUTO_DNC_ON_CNAM      = String(process.env.AUTO_DNC_ON_CNAM || 'true').toLowerCase() === 'true';
const AUTO_DNC_ONLY_PHRASE  = String(process.env.AUTO_DNC_ONLY_ON_PHRASE || 'false').toLowerCase() === 'true';

// Back-compat: default digits to press when we CANNOT extract a specific digit (e.g., CNAM spam)
const AUTO_DNC_DIGITS       = (process.env.AUTO_DNC_DIGITS || '9,8').split(',').map(s => s.trim()).filter(Boolean);

const AUTO_DNC_GAP_MS       = Math.max(0, Number(process.env.AUTO_DNC_GAP_MS || 250));
const DNC_HANGUP_AFTER      = String(process.env.DNC_HANGUP_AFTER || 'true').toLowerCase() === 'true';
const DNC_SAY_LINE          = process.env.DNC_SAY_LINE || 'Please remove this number from your call list. Thank you.';

// ✅ NEW: confidence threshold (requested 0.90 default)
const AUTO_PRESS_CONFIDENCE = Math.max(0, Math.min(1, Number(process.env.AUTO_PRESS_CONFIDENCE || 0.90)));

// ✅ NEW: rate limit window (seconds)
const AUTO_PRESS_RATE_LIMIT_SECS = Math.max(60, Number(process.env.AUTO_PRESS_RATE_LIMIT_SECS || 6 * 60 * 60)); // default 6 hours
const pressRateLimit = new Map(); // key -> timestamp

// Word to digit for spoken numbers 0–9
const PRESS_WORD_TO_DIGIT = {
  'zero':'0','oh':'0','o':'0',
  'one':'1','two':'2','three':'3','four':'4','for':'4','five':'5',
  'six':'6','seven':'7','eight':'8','nine':'9'
};

// Core “removal intent” terms
const REMOVAL_KEYWORDS = [
  'remove', 'removed', 'do not call', 'donotcall', 'dnc',
  'opt out', 'optout', 'unsubscribe', 'stop calling', 'stop contact',
  'call list', 'mailing list', 'marketing list', 'contact list'
];

// Strong phrases (these boost confidence)
const STRONG_REMOVAL_PATTERNS = [
  /\bpress\s+(?:\d|zero|one|two|three|four|five|six|seven|eight|nine)\b.*\b(to\s*)?(?:be\s*)?(removed|opt\s*out|unsubscribe|stop|do\s*not\s*call)\b/i,
  /\b(?:to|please)\s*(?:be\s*)?(removed|opt\s*out|unsubscribe)\b/i,
  /\bdo\s*not\s*call\b/i,
  /\bopt[-\s]*out\b/i,
  /\bunsubscribe\b/i
];

function isCnamSpam(name='') {
  const t = String(name || '').toLowerCase();
  return /spam|scam/.test(t);
}

function buildDigitsString(digitsArr, gapMs) {
  const waits = Math.max(1, Math.round(gapMs / 500));
  const sep = 'w'.repeat(waits);
  return digitsArr.join(sep);
}

/**
 * Extract a single 0–9 digit from "press X" style text.
 * Supports: "press 9", "press nine", "dial 2", "hit zero", "enter 1"
 */
function extractPressDigit(text = '') {
  const t = String(text || '').toLowerCase();

  // numeric form
  let m = t.match(/\b(press|dial|hit|enter|push|tap)\s*([0-9])\b/i);
  if (m && m[2] != null) return String(m[2]);

  // word form
  m = t.match(/\b(press|dial|hit|enter|push|tap)\s*(zero|oh|o|one|two|three|four|for|five|six|seven|eight|nine)\b/i);
  if (m && m[2]) return PRESS_WORD_TO_DIGIT[m[2]] || null;

  return null;
}

function hasRemovalIntent(text='') {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  for (const rx of STRONG_REMOVAL_PATTERNS) {
    if (rx.test(t)) return true;
  }
  for (const kw of REMOVAL_KEYWORDS) {
    if (t.includes(kw)) return true;
  }
  return false;
}

function inferAutoPressAction({ text, callerName }) {
  const digit = extractPressDigit(text);
  if (!digit) return { digit: null, confidence: 0.0, reason: 'no-press-digit' };

  const t = String(text || '');
  const removal = hasRemovalIntent(t);
  const strong = STRONG_REMOVAL_PATTERNS.some(rx => rx.test(t));

  let confidence = 0.25;
  let reason = 'press-digit-only';

  if (strong) {
    confidence = 0.97;
    reason = 'strong-press-to-remove';
  } else if (removal) {
    confidence = 0.94;
    reason = 'press+removal-intent';
  } else if (isCnamSpam(callerName || '')) {
    confidence = 0.90;
    reason = 'press+cnam-spam';
  } else {
    confidence = 0.35;
    reason = 'press-without-removal';
  }

  confidence = Math.max(0, Math.min(1, confidence));
  return { digit, confidence, reason };
}

function canAutoPressNow({ from, digit }) {
  const n10 = normalizeLast10(from || '');
  const key = `${n10 || 'unknown'}:${String(digit)}`;
  const now = Date.now();
  const prev = pressRateLimit.get(key) || 0;
  const windowMs = AUTO_PRESS_RATE_LIMIT_SECS * 1000;
  if (now - prev < windowMs) return { ok: false, key, waitMs: windowMs - (now - prev) };
  pressRateLimit.set(key, now);
  return { ok: true, key, waitMs: 0 };
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

/** Retry-friendly sleep */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/** Download Twilio Recording URL (retries because Twilio can POST before media is ready) */
async function downloadTwilioRecording(recordingUrl) {
  const auth = twilioAuthHeader();
  if (!auth) throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars');

  const url = String(recordingUrl || '').trim();
  if (!url) throw new Error('Missing RecordingUrl');

  const candidates = [
    url.endsWith('.mp3') ? url : (url + '.mp3'),
    url.endsWith('.wav') ? url : (url + '.wav'),
  ];

  let lastErr = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const u of candidates) {
      try {
        const resp = await fetch(u, {
          method: 'GET',
          headers: { Authorization: auth.basic }
        });
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status} for ${u} :: ${t.slice(0,200)}`);
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        const ext = u.endsWith('.wav') ? 'wav' : 'mp3';
        return { buffer: buf, ext };
      } catch (e) {
        lastErr = e;
        console.log(`Recording download attempt failed (attempt ${attempt}):`, String(e?.message || e));
      }
    }
    await sleep(1000 * Math.pow(2, attempt - 1)); // 1s,2s,4s
  }

  throw lastErr || new Error('Failed to download recording');
}

async function twilioUpdateCallTwiml(callSid, twiml) {
  const auth = twilioAuthHeader();
  if (!auth) { console.log('Missing Twilio creds; cannot update call TwiML'); return false; }
  const path = `/2010-04-01/Accounts/${auth.accountSid}/Calls/${encodeURIComponent(callSid)}.json`;
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

/* ============== Outbound-only Telegram bot (webhook) + Outbound Calls ============== */
function normalizeChatId(x){ return String(x ?? '').trim(); }
const OUT_TG_TOKEN = process.env.TELEGRAM_OUTBOUND_BOT_TOKEN || '';
const OUT_TG_CHAT_ID = process.env.TELEGRAM_OUTBOUND_CHAT_ID || '';
const OUT_TG_ALLOWED = process.env.TELEGRAM_OUTBOUND_ALLOWED_CHAT_ID || '';
const OUT_TG_WEBHOOK_PATH = process.env.TELEGRAM_OUTBOUND_WEBHOOK_PATH || '/telegram-outbound-webhook';
const OUT_TG_SECRET = process.env.TELEGRAM_OUTBOUND_WEBHOOK_SECRET || '';

/**
 * outboundPending:
 * code -> { to, display, theme, recipientName, createdAt, requestedByChatId }
 */
const outboundPending = new Map();
const OUTBOUND_CODE_TTL_MS = Math.max(30_000, Number(process.env.OUTBOUND_CODE_TTL_MS || 2 * 60 * 1000)); // default 2 minutes

function isAllowedOutboundChat(chatId){
  const a = normalizeChatId(OUT_TG_ALLOWED);
  if (!a) return false;
  return normalizeChatId(chatId) === a;
}

async function sendOutboundTelegramMessage(text) {
  if (!OUT_TG_TOKEN || !OUT_TG_CHAT_ID) {
    console.log('Outbound Telegram env not set; skipping outbound send.');
    return;
  }
  const endpoint = `https://api.telegram.org/bot${OUT_TG_TOKEN}/sendMessage`;
  const MAX = 3800;
  for (let i = 0; i < text.length; i += MAX) {
    const part = text.slice(i, i + MAX);
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: OUT_TG_CHAT_ID, text: part })
      });
    } catch (e) {
      console.log('Outbound Telegram send failed:', e?.message);
    }
  }
}

function makePublicHttpBase() {
  // REQUIRED for outbound call creation & TwiML URL.
  // Example: https://trinity-voice-gateway.onrender.com
  const u = String(process.env.WEBHOOK_URL || '').trim().replace(/\/+$/,'');
  return u;
}

function makePublicWsMediaUrl() {
  const httpBase = makePublicHttpBase();
  if (!httpBase) return '';
  if (httpBase.startsWith('https://')) return httpBase.replace(/^https:\/\//i, 'wss://') + '/media';
  if (httpBase.startsWith('http://'))  return httpBase.replace(/^http:\/\//i,  'ws://') + '/media';
  return httpBase + '/media';
}

function xmlEscape(s=''){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function looksLikePhoneDigits(phone=''){
  const d = normalizeDigits(phone);
  return d.length >= 10; // 10+ digits
}

function normalizeToE164US(phone=''){
  const raw = String(phone || '').trim();
  const d = normalizeDigits(raw);
  if (!d) return '';
  if (raw.startsWith('+') && d.length >= 10) return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+'.concat(d);
  return '+' + d;
}

function purgeExpiredOutboundCodes() {
  const now = Date.now();
  for (const [code, rec] of outboundPending.entries()) {
    if (!rec || now - rec.createdAt > OUTBOUND_CODE_TTL_MS) outboundPending.delete(code);
  }
}

function makeShortCode() {
  const n = Math.floor(Math.random() * 900000) + 100000;
  return String(n);
}

function safeTheme(theme='') {
  const t = String(theme || '').trim();
  if (!t) return '';
  return t.replace(/\s+/g,' ').slice(0, 280);
}

function parseCallCommand(text='') {
  const raw = String(text || '').trim();
  if (!raw.toLowerCase().startsWith('/call ')) return null;

  const after = raw.slice(6).trim();
  if (!after) return null;

  const parts = after.split('|');
  const left = String(parts[0] || '').trim();
  const theme = safeTheme(parts.slice(1).join('|'));

  const tokens = left.split(/\s+/).filter(Boolean);

  if (tokens.length === 1 && looksLikePhoneDigits(tokens[0])) {
    return { directPhone: tokens[0], nameQuery: '', last4: '', theme };
  }

  if (tokens.length < 2) return null;

  const last = tokens[tokens.length - 1];
  const l4 = normalizeDigits(last).slice(-4);
  if (l4.length !== 4) return null;

  const nameQuery = tokens.slice(0, -1).join(' ').trim();
  if (!nameQuery) return null;

  return { directPhone: '', nameQuery, last4: l4, theme };
}

function normalizeName(s='') {
  return String(s || '').toLowerCase().trim().replace(/\s+/g,' ');
}

function vipMatchesNameAndLast4(vip, nameQuery, last4) {
  const vipName = normalizeName(vip?.name || '');
  const q = normalizeName(nameQuery || '');
  if (!vipName || !q) return false;
  if (!vipName.includes(q)) return false;
  const vipL4 = last4Of(vip?.phone || '');
  return vipL4 === String(last4 || '');
}

async function resolveOutboundRecipient({ nameQuery, last4, directPhone }) {
  if (directPhone && looksLikePhoneDigits(directPhone)) {
    const to = normalizeToE164US(directPhone);
    return { ok: true, to, display: to, recipientName: '', source: 'direct' };
  }

  const cfg = await getConfigCached({ forceFresh: true });
  const vips = Array.isArray(cfg?.vips) ? cfg.vips : [];

  const matches = vips.filter(v => vipMatchesNameAndLast4(v, nameQuery, last4));

  if (matches.length === 0) {
    return { ok: false, error: `No VIP match for "${nameQuery} ${last4}". (Check VIP list name/phone.)` };
  }

  const picked = matches[0];
  const to = normalizeToE164US(picked.phone || '');
  const display = `${picked.name || nameQuery} (${to})`;

  return {
    ok: true,
    to,
    display,
    recipientName: safeVipName(picked) || (picked.name || ''),
    source: matches.length > 1 ? `vip-multi(${matches.length})` : 'vip'
  };
}

async function twilioCreateOutboundCall({ to, reason = 'telegram', theme = '', recipientName = '' }) {
  const auth = twilioAuthHeader();
  if (!auth) throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars');

  const from = String(process.env.TWILIO_OUTBOUND_FROM || '').trim();
  if (!from) throw new Error('Missing TWILIO_OUTBOUND_FROM env var');

  const httpBase = makePublicHttpBase();
  if (!httpBase) throw new Error('Missing WEBHOOK_URL env var (must be your public https base)');

  const url =
    `${httpBase}/outbound-twiml` +
    `?to=${encodeURIComponent(to)}` +
    `&reason=${encodeURIComponent(reason)}` +
    `&theme=${encodeURIComponent(safeTheme(theme))}` +
    `&recipientName=${encodeURIComponent(String(recipientName || '').trim())}` +
    `&t=${Date.now()}`;

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from);
  form.set('Url', url);

  form.set('StatusCallback', `${httpBase}/outbound-status`);
  form.set('StatusCallbackEvent', 'initiated ringing answered completed');
  form.set('StatusCallbackMethod', 'POST');

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}/Calls.json`, {
    method: 'POST',
    headers: {
      'Authorization': auth.basic,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Twilio create call failed HTTP ${resp.status}: ${txt.slice(0, 500)}`);

  let json = {};
  try { json = JSON.parse(txt); } catch {}
  return json;
}

/**
 * TwiML endpoint for outbound calls.
 * ✅ NOW includes: <Start><Recording> + <Start><Transcription>
 * ✅ Callbacks go to: /recordings and /transcripts (same as inbound pipeline)
 */
app.all('/outbound-twiml', (req, res) => {
  try {
    const q = req.query || {};
    const to = String(q.to || '').trim();
    const reason = String(q.reason || 'telegram').trim();
    const theme = safeTheme(q.theme || '');
    const recipientName = String(q.recipientName || '').trim();

    const httpBase = makePublicHttpBase();
    const wsUrl = makePublicWsMediaUrl();

    if (!httpBase || !wsUrl) {
      res.type('text/xml').status(500).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Server misconfigured.</Say><Hangup/></Response>`);
      return;
    }

    // Twilio posts CallSid in the request body (Urlencoded)
    const callSidFromTwilio = String(req.body?.CallSid || req.query?.CallSid || '').trim();
    const fromNumber = String(process.env.TWILIO_OUTBOUND_FROM || '').trim();

    // ✅ IMPORTANT: these callbacks are what make outbound behave like inbound
    // (recording download + Telegram audio, transcription + Telegram text)
    const recordingCb =
      `${httpBase}/recordings` +
      `?from=${encodeURIComponent(to)}` +
      `&to=${encodeURIComponent(fromNumber)}` +
      `&callerName=${encodeURIComponent('OUTBOUND')}` +
      `&reason=${encodeURIComponent(reason)}` +
      `&theme=${encodeURIComponent(theme)}`;

    const transcriptCb =
      `${httpBase}/transcripts` +
      `?from=${encodeURIComponent(to)}` +
      `&to=${encodeURIComponent(fromNumber)}` +
      `&callerName=${encodeURIComponent('OUTBOUND')}` +
      `&reason=${encodeURIComponent(reason)}` +
      `&theme=${encodeURIComponent(theme)}`;

    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +

        // ✅ Start dual-channel recording (same concept as inbound function)
        `<Start>` +
          `<Recording ` +
            `recordingStatusCallback="${xmlEscape(recordingCb)}" ` +
            `recordingStatusCallbackMethod="POST" ` +
            `recordingChannels="dual" ` +
          `/>` +
        `</Start>` +

        // ✅ Start transcription for both tracks
        `<Start>` +
          `<Transcription ` +
            `track="both_tracks" ` +
            `statusCallbackUrl="${xmlEscape(transcriptCb)}" ` +
            `statusCallbackMethod="POST" ` +
          `/>` +
        `</Start>` +

        `<Connect>` +
          `<Stream url="${xmlEscape(wsUrl)}">` +
            `<Parameter name="from" value="${xmlEscape(to)}"/>` +
            `<Parameter name="to" value="${xmlEscape(fromNumber)}"/>` +
            `<Parameter name="callerName" value="${xmlEscape('OUTBOUND')}"/>` +
            `<Parameter name="callSid" value="${xmlEscape(callSidFromTwilio)}"/>` +
            `<Parameter name="reason" value="${xmlEscape(reason)}"/>` +
            `<Parameter name="theme" value="${xmlEscape(theme)}"/>` +
            `<Parameter name="recipientName" value="${xmlEscape(recipientName)}"/>` +
          `</Stream>` +
        `</Connect>` +
      `</Response>`;

    res.type('text/xml').status(200).send(twiml);
  } catch (e) {
    console.log('outbound-twiml error:', e?.message);
    res.type('text/xml').status(500).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});

app.post('/outbound-status', (req, res) => {
  try {
    const b = req.body || {};
    console.log('OUTBOUND STATUS:', {
      CallSid: b.CallSid || b.callsid,
      CallStatus: b.CallStatus || b.callstatus,
      To: b.To || b.to,
      From: b.From || b.from,
      Timestamp: b.Timestamp || b.timestamp
    });
  } catch (e) {
    console.log('outbound-status parse error:', e?.message);
  }
  res.status(204).end();
});

/**
 * Outbound Telegram bot webhook endpoint.
 * You will set Telegram webhook to: {WEBHOOK_URL}{OUT_TG_WEBHOOK_PATH}
 */
app.post(OUT_TG_WEBHOOK_PATH, async (req, res) => {
  res.status(200).send('ok');

  try {
    if (OUT_TG_SECRET) {
      const hdr = String(req.headers['x-telegram-bot-api-secret-token'] || '').trim();
      if (hdr !== OUT_TG_SECRET) {
        console.log('Outbound Telegram webhook: secret token mismatch; ignoring.');
        return;
      }
    }

    purgeExpiredOutboundCodes();

    const update = req.body || {};
    const msg = update.message || update.edited_message || null;
    const text = String(msg?.text || '').trim();
    const chatId = msg?.chat?.id != null ? String(msg.chat.id) : '';
    const fromUser = msg?.from?.username ? `@${msg.from.username}` : (msg?.from?.first_name || 'unknown');

    if (!text) return;

    if (!isAllowedOutboundChat(chatId)) {
      console.log('Outbound Telegram: blocked message from chatId', chatId, 'user', fromUser);
      return;
    }

    const lower = text.toLowerCase();

    if (lower === '/help' || lower === 'help' || lower === '/start') {
      await sendOutboundTelegramMessage(
        `📤 Outbound Call Bot\n\n` +
        `Command:\n` +
        `• /call <name> <last4> | <theme/summary>\n\n` +
        `Examples:\n` +
        `• /call jeff 5680 | follow up about invoice and schedule pickup\n\n` +
        `Confirm:\n` +
        `• YES <code>\n` +
        `Cancel:\n` +
        `• /cancel <code>\n\n` +
        `Notes:\n` +
        `• Name + last4 must match a VIP in your config.\n` +
        `• Two-step confirmation is required.\n`
      );
      return;
    }

    if (lower.startsWith('/call ')) {
      const parsed = parseCallCommand(text);

      if (!parsed) {
        await sendOutboundTelegramMessage(
          `❌ Format not recognized.\n\n` +
          `Use:\n/call <name> <last4> | <theme/summary>\n` +
          `Example:\n/call jeff 5680 | follow up about invoice`
        );
        return;
      }

      const theme = safeTheme(parsed.theme || '');
      if (!theme) {
        await sendOutboundTelegramMessage(
          `❌ Missing theme/summary.\n\n` +
          `Use:\n/call <name> <last4> | <theme/summary>\n` +
          `Example:\n/call jeff 5680 | follow up about invoice`
        );
        return;
      }

      const resolved = await resolveOutboundRecipient({
        nameQuery: parsed.nameQuery,
        last4: parsed.last4,
        directPhone: parsed.directPhone
      });

      if (!resolved.ok) {
        await sendOutboundTelegramMessage(`❌ ${resolved.error || 'Could not resolve recipient.'}`);
        return;
      }

      const code = makeShortCode();
      outboundPending.set(code, {
        to: resolved.to,
        display: resolved.display,
        theme,
        recipientName: String(resolved.recipientName || '').trim(),
        createdAt: Date.now(),
        requestedByChatId: chatId
      });

      const warning = resolved.source && String(resolved.source).startsWith('vip-multi')
        ? `\n⚠️ Multiple VIP matches found; using the first match.\n`
        : '';

      await sendOutboundTelegramMessage(
        `✅ Outbound call request received.\n\n` +
        `To: ${resolved.display}\n` +
        `Theme: ${theme}\n` +
        warning +
        `Confirmation code: ${code}\n\n` +
        `Reply exactly:\nYES ${code}\n\n` +
        `Or cancel:\n/cancel ${code}`
      );
      return;
    }

    if (lower.startsWith('/cancel ')) {
      const code = text.slice(8).trim();
      if (!outboundPending.has(code)) {
        await sendOutboundTelegramMessage(`ℹ️ No pending request found for code ${code}.`);
        return;
      }
      outboundPending.delete(code);
      await sendOutboundTelegramMessage(`🛑 Cancelled pending outbound call (${code}).`);
      return;
    }

    if (lower.startsWith('yes ')) {
      const code = text.slice(4).trim();
      const rec = outboundPending.get(code);
      if (!rec) {
        await sendOutboundTelegramMessage(`❌ That code is not valid (or expired). Send /call again.`);
        return;
      }
      if (Date.now() - rec.createdAt > OUTBOUND_CODE_TTL_MS) {
        outboundPending.delete(code);
        await sendOutboundTelegramMessage(`⌛ That code expired. Send /call again.`);
        return;
      }

      outboundPending.delete(code);

      await sendOutboundTelegramMessage(`📞 Placing outbound call...\nTo: ${rec.display}\nTheme: ${rec.theme}`);

      try {
        const created = await twilioCreateOutboundCall({
          to: rec.to,
          reason: 'telegram',
          theme: rec.theme,
          recipientName: rec.recipientName
        });
        const sid = created?.sid || created?.CallSid || '(unknown)';
        await sendOutboundTelegramMessage(`✅ Call initiated.\nCallSid: ${sid}`);
      } catch (e) {
        await sendOutboundTelegramMessage(`❌ Failed to place call: ${String(e?.message || e).slice(0, 350)}`);
      }
      return;
    }

    await sendOutboundTelegramMessage(`ℹ️ Unknown command. Send /help`);
  } catch (e) {
    console.log('Outbound Telegram webhook handler error:', e?.message);
  }
});

/* ============== Idle + number-mode helpers ============== */
const NUMBER_SILENCE_GRACE_MS = Math.max(1000, Number(process.env.NUMBER_SILENCE_GRACE_MS || 2500));
const NUMBER_MIN_DIGITS = Math.max(7, Number(process.env.NUMBER_MIN_DIGITS || 10));

function getState(callSid) {
  if (!transcripts.has(callSid)) {
    transcripts.set(callSid, {
      events: [],
      greetingSkipped: false,
      meta: {
        from: '',
        to: '',
        callerName: '',
        startedAt: null,

        outbound: {
          isOutbound: false,
          reason: '',
          theme: '',
          recipientName: ''
        }
      },
      lastActivityAt: Date.now(),
      idleTimer: null,
      aiWS: undefined,
      twilioWS: undefined,

      dnc: { attempted: false, reason: '' },

      numberMode: { active: false, digits: '', timer: null, lastDigitAt: 0 },
      muteAssistant: false,

      greetedOnce: false,
      greetingPending: false,
      greetingTimer: null,
      aiSessionReady: false,
      selectedVoice: 'marin',

      assistantName: 'Trinity',

      bargeIn: { active: false, lastAt: 0 },
      aiSpeaking: false
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
  if (s.dnc.attempted) return;

  console.log(`IDLE timeout for ${callSid} after ${IDLE_HANGUP_SECS}s`);
  try {
    if (IDLE_SEND_GOODBYE && s.aiWS && s.aiWS.readyState === 1) {
      s.aiWS.send(JSON.stringify({ type: 'response.create', response: { instructions: GOODBYE_LINE } }));
      await sleep(1500);
    }
  } catch (e) { console.log('Idle goodbye send failed:', e?.message); }

  const ok = await hangupCall(callSid);
  if (!ok) console.log('Hangup REST still failed; sockets will close when Twilio ends the call.');

  try { s.aiWS?.close?.(); } catch {}
  try { s.twilioWS?.close?.(); } catch {}
}

/* ===== Number-mode detection & control ===== */
const WORD_TO_DIGIT = {
  'zero':'0','oh':'0','o':'0',
  'one':'1','two':'2','three':'3','four':'4','for':'4','five':'5',
  'six':'6','seven':'7','eight':'8','nine':'9'
};
function extractDigits(text='') {
  const t = String(text).toLowerCase();
  let digits = t.replace(/[^\d]/g,'');
  const words = t.split(/[\s\-.,/()]+/);
  for (const w of words) if (WORD_TO_DIGIT[w]) digits += WORD_TO_DIGIT[w];
  return digits;
}
function maybeEnterNumberMode(callSid, text) {
  const s = getState(callSid);
  const found = extractDigits(text);
  if (!found) return;

  if (!s.numberMode.active && (found.length >= 3 || /[\-\(\)]/.test(text))) {
    s.numberMode.active = true;
    s.muteAssistant = true;
    s.numberMode.digits = '';
    console.log('Number-mode: ACTIVATED');
  }

  if (s.numberMode.active) {
    if (found.length) {
      s.numberMode.digits += found;
      s.numberMode.lastDigitAt = Date.now();
    }
    if (s.numberMode.timer) clearTimeout(s.numberMode.timer);
    s.numberMode.timer = setTimeout(() => exitNumberMode(callSid, 'silence'), NUMBER_SILENCE_GRACE_MS);

    if (s.numberMode.digits.length >= NUMBER_MIN_DIGITS) {
      exitNumberMode(callSid, 'min-digits');
    }
  }
}
function exitNumberMode(callSid, reason) {
  const s = getState(callSid);
  if (!s.numberMode.active) return;
  s.numberMode.active = false;

  if (!s.bargeIn.active) s.muteAssistant = false;

  if (s.numberMode.timer) { clearTimeout(s.numberMode.timer); s.numberMode.timer = null; }
  console.log(`Number-mode: RELEASE (${reason}); collectedDigits=${s.numberMode.digits.length}`);
}

/* ================= Auto-Press action (formerly Auto-DNC) ================= */
function buildPressTwiml({ digitsToPlay, sayLine, hangup }) {
  const safeDigits = String(digitsToPlay || '').replace(/[^0-9w]/g, '');
  const say = String(sayLine || '').replace(/[<>&]/g, '');
  const hup = hangup ? '<Hangup/>' : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    (safeDigits ? `<Play digits="${safeDigits}"/>` : '') +
    (say ? `<Pause length="1"/><Say>${say}</Say>` : '') +
    hup +
    `</Response>`
  );
}

async function sendAutoPressAndMaybeHangup(callSid, { from, digit, reason }) {
  const s = getState(callSid);
  if (s.dnc.attempted) return;

  const rl = canAutoPressNow({ from, digit });
  if (!rl.ok) {
    console.log('AUTO-PRESS: rate-limited', { callSid, from: normalizeLast10(from), digit, reason, waitMs: rl.waitMs });
    return;
  }

  s.dnc.attempted = true;
  s.dnc.reason = reason || 'auto-press';

  const digitsToPlay = String(digit);
  const twiml = buildPressTwiml({
    digitsToPlay,
    sayLine: DNC_SAY_LINE,
    hangup: DNC_HANGUP_AFTER
  });

  console.log('AUTO-PRESS: updating call TwiML', {
    callSid,
    from: normalizeLast10(from),
    digit,
    reason,
    threshold: AUTO_PRESS_CONFIDENCE
  });

  try {
    await twilioUpdateCallTwiml(callSid, twiml);
  } catch (e) {
    console.log('AUTO-PRESS failed:', e?.message);
  }
}

async function sendDefaultDncDigitsAndMaybeHangup(callSid, reason='default') {
  const s = getState(callSid);
  if (s.dnc.attempted) return;

  const rl = canAutoPressNow({ from: s.meta.from || '', digit: 'default' });
  if (!rl.ok) {
    console.log('AUTO-PRESS(default): rate-limited', { callSid, waitMs: rl.waitMs });
    return;
  }

  s.dnc.attempted = true;
  s.dnc.reason = reason;

  try {
    const digits = buildDigitsString(AUTO_DNC_DIGITS, AUTO_DNC_GAP_MS);
    const twiml = buildPressTwiml({
      digitsToPlay: digits,
      sayLine: DNC_SAY_LINE,
      hangup: DNC_HANGUP_AFTER
    });

    console.log('AUTO-PRESS(default): updating call TwiML', { callSid, reason, digits });
    await twilioUpdateCallTwiml(callSid, twiml);
  } catch (e) {
    console.log('AUTO-PRESS(default) failed:', e?.message);
  }
}

/* ================= /transcripts webhook ================= */
app.post('/transcripts', async (req, res) => {
  try {
    const ev = req.body.TranscriptionEvent || req.body.transcriptionevent || '';
    const callSid = req.body.CallSid || req.body.callsid || '';
    if (!callSid) { console.log('TRANSCRIPT: missing CallSid'); return res.status(200).send('ok'); }

    const buf = getState(callSid);

    const q = req.query || {};
    const fromQ = q.from || req.body.From || req.body.from || '';
    const toQ = q.to || req.body.To || req.body.to || '';
    const callerNameQ = q.callerName || req.body.CallerName || req.body.caller_name || '';
    if (fromQ && !buf.meta.from) buf.meta.from = fromQ;
    if (toQ && !buf.meta.to) buf.meta.to = toQ;
    if (callerNameQ && !buf.meta.callerName) buf.meta.callerName = callerNameQ;

    if (ev === 'transcription-started') {
      console.log('TRANSCRIPT started', callSid);
      if (!buf.meta.startedAt) buf.meta.startedAt = new Date();
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

      const track = (req.body.Track || req.body.track || '').toLowerCase();

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

      if (track === 'inbound_track') maybeEnterNumberMode(callSid, line);

      bumpActivity(callSid, 'speech');

      if (AUTO_DNC_ENABLE && track === 'inbound_track' && !buf.dnc.attempted) {
        const { digit, confidence, reason } = inferAutoPressAction({
          text: line,
          callerName: buf.meta.callerName || ''
        });

        if (digit != null && confidence >= AUTO_PRESS_CONFIDENCE) {
          console.log('AUTO-PRESS decision:', {
            callSid,
            from: normalizeLast10(buf.meta.from),
            callerName: buf.meta.callerName || '',
            digit,
            confidence,
            threshold: AUTO_PRESS_CONFIDENCE,
            reason,
            line: line.slice(0, 180)
          });
          await sendAutoPressAndMaybeHangup(callSid, {
            from: buf.meta.from || '',
            digit,
            reason: `${reason};conf=${confidence.toFixed(2)}`
          });
        }
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

      const when = buf.meta.startedAt || new Date();
      const whenStr = formatLocalDateTime(when);
      const header =
        `📞 New Call — ${whenStr}\n` +
        `From: ${displayNameAndNumber(buf.meta.callerName, buf.meta.from)}\n\n`;
      await sendTelegramMessage(header + (transcript || '(empty)'));

      return res.status(200).send('ok');
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.log('TRANSCRIPT handler error:', e?.message);
    return res.status(200).send('ok');
  }
});

/* ================= Twilio Recording Webhook ================= */
app.post('/recordings', async (req, res) => {
  res.status(200).send('ok');

  try {
    const b = req.body || {};
    const callSid = b.CallSid || b.callsid || '';
    const from = b.From || b.from || '';
    const to = b.To || b.to || '';
    const recordingSid = b.RecordingSid || b.recordingsid || '';
    const recordingUrl = b.RecordingUrl || b.recordingurl || '';

    console.log('RECORDING webhook received:', {
      callSid,
      recordingSid,
      hasUrl: Boolean(recordingUrl),
      from,
      to
    });

    if (!recordingUrl) {
      console.log('RECORDING: missing RecordingUrl (nothing to download)');
      return;
    }

    const { buffer, ext } = await downloadTwilioRecording(recordingUrl);

    const whenStr = formatLocalDateTime(new Date());
    const caption =
      `🎙️ Call Recording — ${whenStr}\n` +
      (from ? `From: ${from}\n` : '') +
      (recordingSid ? `RecSid: ${recordingSid}\n` : '') +
      (callSid ? `CallSid: ${callSid}` : '');

    const filename = `call-${callSid || recordingSid || Date.now()}.${ext}`;

    const ok = await sendTelegramAudio(buffer, filename, caption);
    if (!ok) {
      await sendTelegramMessage(
        caption + `\n\n(Upload to Telegram failed.)\n${recordingUrl}`
      );
    } else {
      console.log('RECORDING: sent audio to Telegram:', filename);
    }
  } catch (e) {
    console.log('RECORDING handler error:', e?.message);
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
  let currentCallSid = null;

  // ✅ outbound extras
  let callReason = '';
  let callTheme = '';
  let callRecipientName = '';

  const counters = { frames: 0, sentChunks: 0 };

  let selectedVoice = 'marin';
  let assistantName = 'Trinity';

  function twilioClearBufferedAudio() {
    try {
      if (!streamSid) return;
      if (!twilioWS || twilioWS.readyState !== 1) return;
      twilioWS.send(JSON.stringify({ event: 'clear', streamSid }));
      console.log('BARGE-IN: Sent Twilio clear (flush buffered outbound audio)');
    } catch (e) {
      console.log('BARGE-IN: Twilio clear failed:', e?.message);
    }
  }

  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  const aiWS = new WebSocket(OPENAI_URL, { headers, perMessageDeflate: false });

  let aiReady = false;
  let latestConfig = null;

  function matchVipByLast10(vips, from) {
    const c10 = normalizeLast10(from);
    if (!c10) return null;
    const found = (Array.isArray(vips) ? vips : []).find(v => normalizeLast10(v?.phone) === c10);
    return found || null;
  }

  function computeAssistantNameForCall(vip, chosenVoice) {
    if (vip && hasVipVoiceOverride(vip)) return displayVoiceName(chosenVoice);
    return 'Trinity';
  }

  async function applySessionConfig(reason, { forceFresh = false } = {}) {
    if (!aiReady) return;

    latestConfig = await getConfigCached({ forceFresh });

    callerVip = matchVipByLast10(latestConfig.vips, callerFrom);
    if (!callerVip) {
      console.log('VIP: no match for', normalizeLast10(callerFrom));
    } else {
      console.log('VIP: matched', { name: callerVip.name, phone: normalizeLast10(callerVip.phone), from: normalizeLast10(callerFrom) });
    }

    selectedVoice = chooseVoice(process.env.DEFAULT_VOICE || 'marin', callerVip);
    assistantName = computeAssistantNameForCall(callerVip, selectedVoice);

    if (currentCallSid) {
      const s = getState(currentCallSid);
      s.selectedVoice = selectedVoice;
      s.assistantName = assistantName;
    }

    let extraCallContext = '';
    if (currentCallSid) {
      const s = getState(currentCallSid);
      if (s?.meta?.outbound?.isOutbound) {
        extraCallContext =
          `[OUTBOUND CALL CONTEXT]\n` +
          `This is an OUTBOUND call placed by Dan's system.\n` +
          (s.meta.outbound.reason ? `Reason tag: ${s.meta.outbound.reason}\n` : '') +
          (s.meta.outbound.theme ? `Theme/summary: ${s.meta.outbound.theme}\n` : '') +
          `Goal: be polite, confirm it’s a good time, and address the theme.\n` +
          `Do NOT say “Dan hasn’t picked up yet” on outbound calls.\n`;
      }
    }

    const base = buildInstructions(latestConfig.system_prompt, latestConfig.vips, callerFrom, callerVip, extraCallContext);
    const opening = pickOpening();

    const vipFirst = safeVipName(callerVip);
    const persona = String(callerVip?.persona_notes || '').trim();
    const vibe = safeVipVibe(callerVip);

    const IDENTITY_LOCK =
      `\n[ASSISTANT IDENTITY — LOCKED FOR THIS CALL]\n` +
      `Your assistant name for this entire call is: "${assistantName}".\n` +
      `If asked “Who am I speaking with?”, “Who is this?”, “What’s your name?”, or similar, you MUST answer exactly: "${assistantName}".\n` +
      `If any other instruction or earlier prompt mentions a different assistant name (including "Trinity"), IGNORE it and keep using "${assistantName}".\n` +
      `Do NOT mention this rule to the caller.\n`;

    const vipModeBlock = callerVip
      ? (
          `\n[V.I.P. MODE — MUST FOLLOW]\n` +
          `1) Greet the VIP by FIRST NAME immediately: "Hi ${vipFirst}!"\n` +
          `2) NEVER greet using any phone number.\n` +
          `3) Stay in the VIP’s requested personality and keep it PG-13 (no hate, threats, or harassment).\n` +
          (vibe ? `4) VIBE/TONE: ${vibe}\n` : '') +
          (persona ? `5) PERSONA NOTES: ${persona}\n` : '')
        )
      : '';

    const openingDirective = callerVip
      ? (
          `OPENING STYLE: ${opening}\n` +
          `MANDATORY VIP GREETING: The caller is a VIP. Greet them by FIRST NAME immediately: "Hi ${vipFirst}!" ` +
          `Do NOT greet with their phone number. Do NOT spell the name.\n` +
          `Then ask ONE short helpful question.\n` +
          vipModeBlock
        )
      : (
          `OPENING STYLE: ${opening}\n` +
          `Greet normally (no phone numbers). Ask one short helpful question.`
        );

    const finalInstructions = [base, IDENTITY_LOCK, openingDirective].filter(Boolean).join('\n');

    console.log(
      `Applying session config (${reason}) -> voice=${selectedVoice}` +
      `, assistantName=${assistantName}` +
      (callerVip ? `, VIP=${callerVip.name}` : '') +
      `, instr len=${finalInstructions.length}` +
      (callerFrom ? `, from=${callerFrom}` : ', from=(missing)')
    );

    aiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: selectedVoice,
        turn_detection: { type: 'server_vad', threshold: 0.55 },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions: finalInstructions
      }
    }));
  }

  function scheduleGreetingAttempt() {
    if (!currentCallSid) return;
    const s = getState(currentCallSid);

    s.greetingPending = true;

    if (s.greetingTimer) { clearTimeout(s.greetingTimer); s.greetingTimer = null; }

    // fallback attempt after 6s
    s.greetingTimer = setTimeout(() => trySendGreetingNow('fallback-timeout'), 6000);

    // immediate attempt
    trySendGreetingNow('schedule');
  }

  function trySendGreetingNow(reason = 'ai-ready') {
    if (!currentCallSid) return;
    const s = getState(currentCallSid);
    if (s.greetedOnce) return;
    if (!s.greetingPending) return;

    const isOutbound = Boolean(s?.meta?.outbound?.isOutbound);

    // ✅ CRITICAL FIX:
    // Outbound should NOT wait for session.updated (callee often says “hello” first otherwise).
    if (!s.aiSessionReady && !isOutbound) return;

    s.greetedOnce = true;
    s.greetingPending = false;
    if (s.greetingTimer) { clearTimeout(s.greetingTimer); s.greetingTimer = null; }

    const vipFirst = safeVipName(callerVip);
    const aName = String(s.assistantName || assistantName || 'Trinity');

    const theme = safeTheme(s?.meta?.outbound?.theme || '');
    const recName = String(s?.meta?.outbound?.recipientName || '').trim();

    let greetLine;

    if (isOutbound) {
      // ✅ OUTBOUND greeting: short hello, immediately state theme/reason
      // If we have a name, use it.
      const who = recName ? `Hi ${recName}` : `Hi`;
      const about = theme ? ` Dan asked me to call about: ${theme}.` : ` Dan asked me to call.`;
      greetLine = `${who} — this is ${aName}, Dan’s VIP AI assistant.${about} Is now a good time?`;
    } else if (callerVip) {
      greetLine = vipFirst
        ? `Hi ${vipFirst} — This is ${aName}, Dan's VIP Assistant. Dan hasn't picked up yet. How can I help?`
        : `Hi — This is ${aName}, Dan's VIP Assistant. Dan hasn't picked up yet. How can I help?`;
    } else {
      greetLine = `Hi — it's ${aName}. How can I help?`;
    }

    console.log('GREETING: sending:', {
      reason,
      outbound: isOutbound,
      theme,
      recipientName: recName || null,
      vip: callerVip ? callerVip.name : null,
      selectedVoice: s.selectedVoice || selectedVoice,
      assistantName: aName,
      greetLine
    });

    try {
      aiWS.send(JSON.stringify({
        type: 'response.create',
        response: { instructions: `Say exactly: "${greetLine}"` }
      }));
    } catch (e) {
      console.log('GREETING: send failed:', e?.message);
    }
  }

  function handleBargeInStart(reason = 'speech_started') {
    if (!currentCallSid) return;
    const s = getState(currentCallSid);

    const now = Date.now();
    if (s.bargeIn.active && (now - (s.bargeIn.lastAt || 0) < 250)) return;

    s.bargeIn.active = true;
    s.bargeIn.lastAt = now;

    s.muteAssistant = true;

    twilioClearBufferedAudio();

    try {
      if (aiWS.readyState === 1) {
        aiWS.send(JSON.stringify({ type: 'response.cancel' }));
        aiWS.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
      }
      console.log('BARGE-IN: response.cancel + output_audio_buffer.clear sent to OpenAI', { reason });
    } catch (e) {
      console.log('BARGE-IN: OpenAI cancel/clear failed:', e?.message);
    }
  }

  function handleBargeInStop(reason = 'speech_stopped') {
    if (!currentCallSid) return;
    const s = getState(currentCallSid);

    s.bargeIn.active = false;

    setTimeout(() => {
      const s2 = getState(currentCallSid);
      if (s2.numberMode.active) return;
      if (s2.bargeIn.active) return;
      s2.muteAssistant = false;
      console.log('BARGE-IN: released mute', { reason });
    }, 200);
  }

  aiWS.on('open', async () => {
    console.log('AI: connected');
    aiReady = true;
    latestConfig = await getConfigCached({ forceFresh: false });
    await applySessionConfig('on-open', { forceFresh: false });
  });

  aiWS.on('message', (raw, isBinary) => {
    if (!streamSid) return;

    const s = currentCallSid ? getState(currentCallSid) : null;

    if (isBinary) {
      if (s?.muteAssistant) return;
      sendPcm16kBinaryToTwilioAsUlaw(raw, twilioWS, streamSid, counters);
      if (currentCallSid) bumpActivity(currentCallSid, 'ai-binary');
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      if (msg?.type === 'session.updated') {
        if (currentCallSid) {
          const st = getState(currentCallSid);
          st.aiSessionReady = true;
          console.log('AI: session.updated => aiSessionReady=true');
          trySendGreetingNow('session.updated');
        }
      }

      if (msg?.type === 'input_audio_buffer.speech_started') {
        handleBargeInStart('input_audio_buffer.speech_started');
        if (currentCallSid) bumpActivity(currentCallSid, 'speech_started');
        return;
      }
      if (msg?.type === 'input_audio_buffer.speech_stopped') {
        handleBargeInStop('input_audio_buffer.speech_stopped');
        if (currentCallSid) bumpActivity(currentCallSid, 'speech_stopped');
        return;
      }

      if (!['response.audio.delta','response.output_audio.delta'].includes(msg?.type)) {
        console.log('AI event:', msg?.type);
      }

      if (msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta') {
        if (s) s.aiSpeaking = true;
        if (s?.muteAssistant) return;

        const b64 = msg.delta || msg.audio;
        if (b64) {
          chunkAndSendUlawBase64ToTwilio(b64, twilioWS, streamSid, counters);
          if (currentCallSid) bumpActivity(currentCallSid, 'ai-delta');
        }
      } else if (msg.type === 'response.done' || msg.type === 'response.completed') {
        if (s) s.aiSpeaking = false;
      } else if (msg.type === 'output_audio_buffer.cleared') {
        console.log('AI: output_audio_buffer.cleared');
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

        case 'start': {
          streamSid = data.start?.streamSid;
          const startCallSid = data.start?.callSid || '';
          console.log('WS: stream started', { streamSid, callSid: startCallSid });
          counters.frames = 0; counters.sentChunks = 0;

          try {
            const params = data.start?.customParameters ?? {};

            const getP = (n) => {
              if (params && typeof params === 'object' && !Array.isArray(params)) return params[n] || '';
              if (Array.isArray(params)) return (params.find(p => p?.name === n)?.value) || '';
              return '';
            };

            const from  = getP('from');
            const to    = getP('to');
            const callerNameParam = getP('callerName');
            const callSidParam = getP('callSid');
            const reasonParam = getP('reason');
            const themeParam = getP('theme');
            const recipientNameParam = getP('recipientName');

            console.log('Start.customParameters raw =', params);
            console.log('Parsed start params =', { from, to, callerName: callerNameParam, callSid: callSidParam, reason: reasonParam, theme: themeParam, recipientName: recipientNameParam });

            currentCallSid = callSidParam || startCallSid || currentCallSid;
            callerFrom = from || callerFrom;
            callerName = callerNameParam || callerName;

            callReason = String(reasonParam || '').trim();
            callTheme = safeTheme(themeParam || '');
            callRecipientName = String(recipientNameParam || '').trim();

            if (currentCallSid) {
              const s = getState(currentCallSid);
              s.aiWS = aiWS;
              s.twilioWS = twilioWS;
              if (from && !s.meta.from) s.meta.from = from;
              if (to && !s.meta.to) s.meta.to = to;
              if (callerNameParam && !s.meta.callerName) s.meta.callerName = callerNameParam;
              if (!s.meta.startedAt) s.meta.startedAt = new Date();
              resetIdleTimer(currentCallSid);

              const isOutbound = String(callerNameParam || '').toUpperCase() === 'OUTBOUND';
              s.meta.outbound.isOutbound = isOutbound;
              s.meta.outbound.reason = callReason || '';
              s.meta.outbound.theme = callTheme || '';
              s.meta.outbound.recipientName = callRecipientName || '';

              s.aiSessionReady = false;
              s.greetedOnce = false;
              s.greetingPending = false;
              if (s.greetingTimer) { clearTimeout(s.greetingTimer); s.greetingTimer = null; }

              s.selectedVoice = 'marin';
              s.assistantName = 'Trinity';
              selectedVoice = 'marin';
              assistantName = 'Trinity';
            }

            if (AUTO_DNC_ENABLE && AUTO_DNC_ON_CNAM && !AUTO_DNC_ONLY_PHRASE) {
              const s = getState(currentCallSid);
              if (isCnamSpam(s.meta.callerName)) {
                await sendDefaultDncDigitsAndMaybeHangup(currentCallSid, 'cnam');
              }
            }
          } catch (e) {
            console.log('Start handler param parse error:', e?.message);
          }

          await applySessionConfig('on-start', { forceFresh: true });

          if (aiWS.readyState === 1) {
            aiWS.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          }

          scheduleGreetingAttempt();
          break;
        }

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
