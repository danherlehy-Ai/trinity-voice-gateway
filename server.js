import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---------- simple HTTP routes ----------
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/warmup', (_req, res) => res.status(204).end());

// Test webhook posting to Google Sheets (GET + POST)
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

// ---------- HTTP server + WebSocket (/media) ----------
const server = createServer(app);

// Twilio <Stream> will connect to wss://.../media
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws, req) => {
  console.log('WS: connection from', req.socket.remoteAddress);
  let frames = 0;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      switch (data.event) {
        case 'connected':
          console.log('WS: connected event');
          break;
        case 'start':
          console.log('WS: stream started',
            { streamSid: data.start?.streamSid, callSid: data.start?.callSid });
          break;
        case 'media':
          frames++;
          // log every ~1s (50 x 20ms frames) so logs stay clean
          if (frames % 50 === 0) console.log(`WS: frames ${frames}`);
          // audio is in data.media.payload (base64 PCM μ-law 8kHz)
          break;
        case 'stop':
          console.log('WS: stream stopped');
          ws.close();
          break;
        default:
          // ignore unknown events
          break;
      }
    } catch (e) {
      // non-JSON or unexpected payload
      console.log('WS: message (raw)', msg.toString().slice(0, 120));
    }
  });

  ws.on('close', () => console.log('WS: connection closed'));
  ws.on('error', (err) => console.log('WS: error', err?.message));
});

// ---------- start ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Trinity gateway listening on :${PORT}`);
});
