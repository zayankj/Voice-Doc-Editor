import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

const PORT = process.env.PORT || 4000;
const AI_URL = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MINUTE) || 20;
const AI_TIMEOUT_MS = 270000; // a little longer than the AI service's own 4-minute budget

// ---------- access keys ("name:key,name2:key2") ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

const clients = (process.env.GATEWAY_API_KEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const i = entry.indexOf(':');
    return i > 0 ? { name: entry.slice(0, i), hash: sha(entry.slice(i + 1)) } : { name: 'app', hash: sha(entry) };
  });

if (!clients.length) {
  console.error('GATEWAY_API_KEYS is missing in gateway/.env');
  process.exit(1);
}
if (!INTERNAL_KEY) {
  console.error('INTERNAL_KEY is missing in gateway/.env (it must be the same value as in server/.env)');
  process.exit(1);
}

// ---------- audit log (who called what, never the content) ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(here, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'gateway.log');

function audit(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  console.log(line);
  fs.appendFile(LOG_FILE, `${line}\n`, () => {});
}

const app = express();
app.disable('x-powered-by');

// request id, so one request can be followed through the gateway and the AI service
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

app.use(helmet());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  })
);

// one log line per finished request
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    audit({
      id: req.id,
      client: req.client?.name || null,
      ip: req.ip,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
      ...(req.meta || {}),
    });
  });
  next();
});

// overall limit per IP (also slows down anyone guessing access keys)
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please slow down.' }),
  })
);

// ---------- health check (no key needed, reveals nothing sensitive) ----------
app.get('/health', async (_req, res) => {
  let ai = 'down';
  try {
    const r = await fetch(`${AI_URL}/health`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
      signal: AbortSignal.timeout(3000),
    });
    ai = r.ok ? 'ok' : 'error';
  } catch {
    /* the AI service is not running */
  }
  res.status(ai === 'ok' ? 200 : 503).json({ gateway: 'ok', ai });
});

// ---------- access key check for everything under /api ----------
function authenticate(req, res, next) {
  const given = sha(req.get('x-api-key') || '');
  const found = clients.find((c) => crypto.timingSafeEqual(c.hash, given));
  if (!found) return res.status(401).json({ error: 'Access denied. The app does not have a valid access key.' });
  req.client = found;
  next();
}
app.use('/api', authenticate);

// ---------- request checks: only known fields, limited sizes, allowed file types ----------
const FILE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
const AUDIO_TYPES = new Set(['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm']);

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function validate(body = {}) {
  const str = (value, max, name) => {
    if (value == null || value === '') return '';
    if (typeof value !== 'string') throw bad(`${name} must be text`);
    if (value.length > max) throw bad(`${name} is too large`);
    return value;
  };

  const out = {
    outline: str(body.outline, 300_000, 'The document'),
    today: str(body.today, 20, 'The date'),
    instruction: str(body.instruction, 4_000, 'The instruction'),
    fileName: str(body.fileName, 200, 'The file name'),
    text: str(body.text, 400_000, 'The file text'),
    base64: str(body.base64, 22_000_000, 'The file'),
    mimeType: str(body.mimeType, 100, 'The file type'),
    audioBase64: str(body.audioBase64, 10_000_000, 'The audio'),
    audioMimeType: str(body.audioMimeType, 100, 'The audio type'),
  };

  if (!out.outline) throw bad('The document is missing');
  if (!/^\d{2}-\d{2}-\d{4}$/.test(out.today)) throw bad('The date is not valid');
  if (!out.base64 && !out.text && !out.instruction.trim() && !out.audioBase64) {
    throw bad('Speak, attach a file or type an instruction');
  }
  if (out.base64 && !FILE_TYPES.has(out.mimeType)) throw bad('This file type is not allowed. Use an image or a PDF.');
  if (out.audioBase64 && !AUDIO_TYPES.has(out.audioMimeType || 'audio/wav')) throw bad('This audio type is not allowed');
  return out;
}

// ---------- forward to the AI service ----------
async function callAi(pathname, body, id) {
  const r = await fetch(`${AI_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY, 'x-request-id': id },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// model requests cost money and quota: limited per client
const extractLimiter = rateLimit({
  windowMs: 60_000,
  limit: LIMIT_PER_MIN,
  keyGenerator: (req) => req.client.name,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({ error: 'Too many requests in a minute. Please wait a moment and try again.' }),
});

app.post('/api/extract-edits', express.json({ limit: '25mb' }), extractLimiter, async (req, res) => {
  let clean;
  try {
    clean = validate(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // what is logged: which kinds of input and roughly how big, never the content
  req.meta = {
    input: [clean.base64 || clean.text ? 'file' : null, clean.audioBase64 ? 'audio' : null, clean.instruction ? 'instruction' : null].filter(Boolean),
    approxKB: Math.round((clean.base64.length + clean.audioBase64.length + clean.text.length) / 1024),
  };

  try {
    const { status, data } = await callAi('/api/extract-edits', clean, req.id);
    if (status >= 200 && status < 300) {
      return res.json({ edits: data.edits || [], summary: data.summary || '', heard: data.heard || '' });
    }
    const passThrough = [400, 429, 503].includes(status) ? status : 502;
    return res.status(passThrough).json({ error: data.error || 'The AI service returned an error' });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return res.status(504).json({ error: 'The AI service took too long to answer. Please try again.' });
    }
    console.error(`[${req.id}]`, e?.cause?.code || e?.message);
    return res.status(502).json({ error: 'The AI service is not reachable. Make sure it is running.' });
  }
});

// anything else is unknown
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// last safety net: clean messages, no internal details
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The file is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read.' });
  if (err.message === 'Origin not allowed') {
    return res.status(403).json({ error: 'This website is not allowed to use the gateway.' });
  }
  console.error(`[${req.id}]`, err);
  res.status(500).json({ error: 'Something went wrong in the gateway.' });
});

app.listen(PORT, () => {
  console.log(`Gateway running on port ${PORT} -> AI service ${AI_URL}`);
  console.log(`Clients: ${clients.map((c) => c.name).join(', ')} | Allowed origins: ${ORIGINS.join(', ')}`);
});