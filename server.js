import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---------- helpers ----------
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

function testPayload(note = 'This is a test summary from /logs/test.') {
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

// ---------- routes ----------
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Pre-warm endpoint (Twilio Function will hit this during greeting)
app.get('/warmup', (_req, res) => res.status(204).end());

// Test webhook posting to Google Sheets (POST)
app.post('/logs/test', async (_req, res) => {
  try {
    const result = await sendToSheet(testPayload());
    return res.json({ ok: true, webhook_status: result.status, body: result.body });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Same tester but for browsers (GET)
app.get('/logs/test', async (_req, res) => {
  try {
    const result = await sendToSheet(testPayload('GET /logs/test appended this row.'));
    // Return a simple human-friendly message
    res
      .status(200)
      .send(`OK — test row appended to your Sheet. Webhook status: ${result.status}`);
  } catch (e) {
    res.status(500).send(`Error: ${String(e)}`);
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Trinity gateway listening on :${PORT}`);
});
