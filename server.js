import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '5mb' }));

// Health check (for Render/UptimeRobot)
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Pre-warm endpoint (Twilio Function will hit this during greeting)
app.get('/warmup', (_req, res) => res.status(204).end());

// Test webhook posting to Google Sheets
app.post('/logs/test', async (req, res) => {
  try {
    const webhook = process.env.WEBHOOK_URL;
    if (!webhook) return res.status(500).json({ ok: false, error: 'WEBHOOK_URL not set' });

    const payload = {
      from: '+10000000000',
      to: '+10000000001',
      call_sid: 'TEST123',
      caller_name: 'Test Caller',
      vip_name: '',
      vip_role: '',
      business: '',
      intent: 'test',
      summary: 'This is a test summary from /logs/test.',
      action_items: ['Example item'],
      spam: false,
      dnc_attempted: false,
      dnc_result: '',
      recording_url: '',
      transcript: 'This is only a test.'
    };

    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    return res.json({ ok: true, webhook_status: resp.status, body: text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Trinity gateway listening on :${PORT}`);
});
