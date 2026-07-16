'use strict';

/**
 * Patriot's Plumbing — chat + lead capture API
 *
 * Endpoints:
 *   GET  /api/health            liveness + warm-up ping
 *   POST /api/chat              SSE-streamed answers from the virtual service advisor
 *   POST /api/lead              multipart lead submission (fields + up to 6 photos)
 *   GET  /leads?key=...         dashboard for the plumber (server-rendered)
 *   GET  /leads.csv?key=...     CSV export
 *   GET  /leads/:id/photo/:idx  photo bytes (key-protected)
 *   POST /leads/:id/status      advance lead status (key-protected)
 */

const crypto = require('crypto');
const express = require('express');
const Busboy = require('busboy');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || '';

const BUSINESS = {
  name: "Patriot's Plumbing",
  phone: '(276) 285-1392',
  phoneHref: 'tel:+12762851392',
  email: 'thepatriotsplumber@gmail.com',
  areas: 'Abingdon, Bristol, Emory, Meadowview, Glade Spring, Damascus, Saltville, Chilhowie, Marion, Atkins and Wytheville, Virginia — the I-81 corridor of Southwest Virginia',
  financing: 'https://app.gethearth.com/partners/patriots-plumbing/bill/apply',
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const useSsl = /render\.com|sslmode=require/i.test(DATABASE_URL);
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined, max: 5 })
  : null;

async function initDb() {
  if (!pool) { console.warn('DATABASE_URL not set — lead storage disabled'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT,
      problem TEXT,
      details TEXT,
      timing TEXT,
      source TEXT,
      chat TEXT,
      status TEXT NOT NULL DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS lead_photos (
      id SERIAL PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      idx INT NOT NULL,
      mime TEXT NOT NULL,
      bytes BYTEA NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lead_photos_lead ON lead_photos(lead_id);
  `);
  console.log('database ready');
}

// ---------------------------------------------------------------------------
// The virtual service advisor
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the virtual service advisor for Patriot's Plumbing, a professional plumbing company in Southwest Virginia. You answer questions from homeowners and businesses on the company website, help them figure out what is going on with their plumbing, and guide them to the fastest path to getting it fixed.

FACTS ABOUT THE COMPANY (the only facts you may state about it):
- Patriot's Plumbing is run by a Master Plumber, licensed and insured, originally licensed in North Carolina and now proudly serving Virginia. It is a veteran family: his wife Liz served as a Navy Corpsman.
- Service area: ${BUSINESS.areas}. If someone is nearby but not listed, say coverage may be possible and suggest calling to confirm.
- Phone: ${BUSINESS.phone}. Email: ${BUSINESS.email}.
- Services: plumbing repairs; kitchen, bathroom and laundry renovations; sewer and water line repairs; shower and tub installations; water heater repair and replacement; sewage and sump pump installation; rough-ins for new construction and remodels; CPVC-to-PEX repipes; drain problems.
- All work is guaranteed. Technicians are trained, courteous, and clean up after every job. Drug-free workplace.
- Flexible financing is available through the company's partner Hearth (funding decisions in 1-3 days, no home equity required, checking options does not affect credit score). The website has an "Apply for financing" link.
- Hours are not published. Never invent hours or promise a specific arrival time. The company returns calls and website requests quickly during normal working hours.

SERVICE STANDARDS (how you behave, always):
- Start from the customer's problem, not from the company. Acknowledge the situation in one short sentence, then be useful immediately.
- Take ownership. Never answer with the equivalent of "that's not something I can help with." If something is outside plumbing, say what you can do and point to the right next step.
- Bias for action: every reply ends with the single clearest next step. On this website that is usually "tap Request service and send us a photo" or "call ${BUSINESS.phone}".
- Earn trust: never invent prices, availability, discounts, or diagnoses you cannot support. If you are not sure, say so plainly and offer the callback instead. Never exaggerate.
- Highest standards: give correct, safety-first plumbing guidance. Prefer one precise answer over three vague ones.
- Ask at most ONE clarifying question at a time, and only when the answer changes your guidance.

SAFETY TRIAGE — these override everything else:
- Smell of gas: tell them to stop, not touch any switches or flames, leave the building, and call their gas company's emergency line or 911 from outside. Only after that, mention we can help with gas line work afterward.
- Burst pipe or major active leak: first step is always to shut off the main water valve (usually near the water meter, in the crawl space, basement, or where the line enters the house), then call us.
- Leaking or hissing water heater: shut off the cold-water supply to the heater and turn off its power (breaker) or set the gas control to off, then call.
- Sewage backup: stop running water entirely, keep people and pets away from the area, and call. Do not advise DIY on sewage.
- Suspected frozen/burst line in winter: shut off main, open a faucet to relieve pressure, do not use open flame to thaw.

WHAT YOU ARE:
- You are a virtual assistant, not a human and not the owner. If asked, say so directly and without apology, and offer the phone number for a human.
- You never quote prices or estimates, even ballparks. Explain that honest pricing requires seeing the job first — that is exactly what the photo request form is for — and that a real person will follow up with them after they send it.
- You do not book appointments yourself. The two booking paths are the Request service form on this page and the phone number.
- Do not discuss competitors, and do not give advice about other companies.
- For unrelated topics (politics, news, coding, anything non-plumbing), politely bring the conversation back to plumbing in one sentence.

DIY CALIBRATION:
- Freely give safe, simple guidance: plunging technique, checking a garbage-disposal reset button, checking the water heater breaker or pilot status, locating shutoff valves, silencing a running toilet by closing its supply valve.
- Recommend a professional for anything involving gas, main lines, sewer, soldering, water heater replacement, anything behind walls, or anything requiring permits. Explain the risk in one honest sentence, not with fear tactics.

FORMAT:
- Plain text only. No markdown symbols, no asterisks, no headers, no emoji.
- Keep replies under about 110 words unless safety instructions require more. Short paragraphs. Use simple hyphen lists only when listing steps.
- Warm, plainspoken, professional. Sound like a capable person at the front desk of a well-run shop, not like a marketing brochure.`;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function keyOk(k) {
  if (!ADMIN_KEY) return false;
  try { return crypto.timingSafeEqual(sha(k || ''), sha(ADMIN_KEY)); } catch { return false; }
}

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return b.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(d) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : (origin && ALLOWED_ORIGINS.includes(origin) ? origin : null);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/', (_req, res) => res.json({ service: 'patriots-plumbing-api', ok: true }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// POST /api/chat — streamed advisor replies
// ---------------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`chat-min:${ip}`, 20, 60_000) || !rateLimit(`chat-day:${ip}`, 300, 86_400_000)) {
    return res.status(429).json({ error: 'Too many requests. Please call us at ' + BUSINESS.phone });
  }

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!raw || raw.length === 0) return res.status(400).json({ error: 'messages required' });

  const messages = raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-24)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'last message must be from user' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    });
    stream.on('text', (delta) => send({ t: delta }));
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      send({ t: `I'd rather have a real person help with that one. Give us a call at ${BUSINESS.phone}.` });
    }
    send({ done: true });
  } catch (err) {
    console.error('chat error:', err?.status || '', err?.message);
    send({ error: `Sorry — I'm having trouble connecting right now. Please call us at ${BUSINESS.phone} or use the Request service form.` });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// POST /api/lead — multipart lead submission
// ---------------------------------------------------------------------------

app.post('/api/lead', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`lead:${ip}`, 12, 3_600_000)) {
    return res.status(429).json({ error: 'Too many requests. Please call ' + BUSINESS.phone });
  }
  if (!pool) return res.status(503).json({ error: 'Lead storage not configured' });

  let bb;
  try {
    bb = Busboy({
      headers: req.headers,
      limits: { files: 6, fileSize: 6 * 1024 * 1024, fields: 24, fieldSize: 24_000 },
    });
  } catch {
    return res.status(400).json({ error: 'Invalid form data' });
  }

  const fields = {};
  const photos = [];
  let tooBig = false;

  bb.on('field', (name, val) => { fields[name] = val; });
  bb.on('file', (_name, file, info) => {
    const mime = (info.mimeType || '').toLowerCase();
    if (!mime.startsWith('image/')) { file.resume(); return; }
    const chunks = [];
    file.on('data', (d) => chunks.push(d));
    file.on('limit', () => { tooBig = true; });
    file.on('end', () => {
      if (!tooBig && photos.length < 6) photos.push({ mime, bytes: Buffer.concat(chunks) });
    });
  });

  bb.on('close', async () => {
    try {
      // Anti-spam: honeypot field must be empty; form must not be filled instantly.
      if ((fields.company || '').trim() !== '') return res.status(200).json({ ok: true, id: 'ok' });
      const elapsed = Number(fields.elapsed_ms || 0);
      if (Number.isFinite(elapsed) && elapsed > 0 && elapsed < 2500) {
        return res.status(200).json({ ok: true, id: 'ok' });
      }
      if (tooBig) return res.status(413).json({ error: 'One of the photos is too large' });

      const name = (fields.name || '').trim().slice(0, 120);
      const phone = (fields.phone || '').trim().slice(0, 40);
      const digits = phone.replace(/\D/g, '');
      if (name.length < 2) return res.status(400).json({ error: 'Please tell us your name' });
      if (digits.length < 7) return res.status(400).json({ error: 'Please enter a valid phone number' });

      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO leads (id, name, phone, email, address, problem, details, timing, source, chat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id, name, phone,
          (fields.email || '').trim().slice(0, 200) || null,
          (fields.address || '').trim().slice(0, 300) || null,
          (fields.problem || '').trim().slice(0, 100) || null,
          (fields.details || '').trim().slice(0, 4000) || null,
          (fields.timing || '').trim().slice(0, 60) || null,
          (fields.source || 'website').trim().slice(0, 40),
          (fields.chat || '').trim().slice(0, 20000) || null,
        ],
      );
      for (let i = 0; i < photos.length; i++) {
        await pool.query(
          'INSERT INTO lead_photos (lead_id, idx, mime, bytes) VALUES ($1,$2,$3,$4)',
          [id, i, photos[i].mime, photos[i].bytes],
        );
      }

      if (NOTIFY_WEBHOOK_URL) {
        fetch(NOTIFY_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `New lead: ${name} — ${phone} — ${fields.problem || 'service request'} (${photos.length} photos)` }),
        }).catch(() => {});
      }

      console.log(`lead ${id}: ${name} / ${fields.problem || 'n/a'} / ${photos.length} photos`);
      res.status(201).json({ ok: true, id });
    } catch (err) {
      console.error('lead error:', err.message);
      res.status(500).json({ error: 'Could not save your request. Please call ' + BUSINESS.phone });
    }
  });

  bb.on('error', () => res.status(400).json({ error: 'Invalid form data' }));
  req.pipe(bb);
});

// ---------------------------------------------------------------------------
// Dashboard (key-protected)
// ---------------------------------------------------------------------------

const STATUSES = ['new', 'contacted', 'done'];

app.get('/leads', async (req, res) => {
  if (!keyOk(req.query.key)) return res.status(401).send('Unauthorized');
  const { rows } = await pool.query(
    `SELECT l.*, COALESCE(p.n, 0) AS photo_count
     FROM leads l
     LEFT JOIN (SELECT lead_id, COUNT(*) n FROM lead_photos GROUP BY lead_id) p ON p.lead_id = l.id
     ORDER BY l.created_at DESC LIMIT 500`,
  );
  const key = encodeURIComponent(req.query.key);

  const cards = rows.map(l => {
    const thumbs = Array.from({ length: Number(l.photo_count) }, (_, i) =>
      `<a href="/leads/${l.id}/photo/${i}?key=${key}" target="_blank"><img src="/leads/${l.id}/photo/${i}?key=${key}" alt="photo ${i + 1}" loading="lazy"></a>`,
    ).join('');
    const next = STATUSES[(STATUSES.indexOf(l.status) + 1) % STATUSES.length];
    return `
    <article class="lead s-${esc(l.status)}">
      <header>
        <span class="chip">${esc(l.problem || 'Service request')}</span>
        <span class="when" title="${esc(new Date(l.created_at).toLocaleString('en-US'))}">${timeAgo(l.created_at)}</span>
      </header>
      <h2>${esc(l.name)}</h2>
      <p class="contact">
        <a class="call" href="tel:${esc(l.phone.replace(/[^+\d]/g, ''))}">Call ${esc(l.phone)}</a>
        ${l.email ? `<a class="mail" href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''}
      </p>
      ${l.address ? `<p class="addr">${esc(l.address)}</p>` : ''}
      ${l.timing ? `<p class="meta">Preferred: ${esc(l.timing)}</p>` : ''}
      ${l.details ? `<p class="details">${esc(l.details)}</p>` : ''}
      ${l.chat ? `<details><summary>Chat transcript</summary><pre>${esc(l.chat)}</pre></details>` : ''}
      ${thumbs ? `<div class="photos">${thumbs}</div>` : ''}
      <footer>
        <span class="status">${esc(l.status)}</span>
        <div class="actions">
          <form method="POST" action="/leads/${l.id}/status?key=${key}">
            <button type="submit">Mark ${esc(next)}</button>
          </form>
          <form method="POST" action="/leads/${l.id}/delete?key=${key}"
                onsubmit="return confirm('Delete this request? This cannot be undone.')">
            <button type="submit" class="trash" title="Delete request" aria-label="Delete request">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 4h4m-8 3 1 13h10l1-13M10 11v6m4-6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </form>
        </div>
      </footer>
    </article>`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="120">
<title>Service Requests — Patriot's Plumbing</title>
<style>
  :root { --navy:#14294A; --navy-950:#0A1428; --red:#C02D40; --porcelain:#F4F7FB; --ink:#101B31; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--porcelain); color: var(--ink); }
  .top { background: var(--navy-950); color: #fff; padding: 14px 20px; display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; border-bottom: 3px solid var(--red); }
  .top h1 { font-size: 16px; letter-spacing: .08em; text-transform: uppercase; }
  .top a { color: #B9C4CD; font-size: 13px; text-decoration: none; }
  main { max-width: 780px; margin: 0 auto; padding: 20px 14px 60px; display: grid; gap: 14px; }
  .empty { text-align: center; color: #5A6A85; padding: 60px 0; }
  .lead { background: #fff; border: 1px solid #DCE4EE; border-left: 5px solid var(--red); border-radius: 10px; padding: 14px 16px; }
  .lead.s-contacted { border-left-color: #E5A33B; } .lead.s-done { border-left-color: #3E9A55; opacity: .75; }
  .lead header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .chip { background: var(--navy); color: #fff; font-size: 12px; padding: 3px 10px; border-radius: 99px; letter-spacing: .04em; }
  .when { color: #5A6A85; font-size: 13px; }
  h2 { font-size: 19px; margin: 2px 0 6px; }
  .contact { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  .call { background: var(--red); color: #fff; text-decoration: none; font-weight: 600; padding: 8px 14px; border-radius: 8px; }
  .mail { color: var(--navy); align-self: center; }
  .addr, .meta { color: #33415C; font-size: 14px; }
  .details { margin-top: 8px; background: var(--porcelain); border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; }
  details { margin-top: 8px; font-size: 13px; } details pre { white-space: pre-wrap; background: var(--porcelain); padding: 10px; border-radius: 8px; margin-top: 6px; max-height: 260px; overflow: auto; }
  .photos { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .photos img { width: 92px; height: 92px; object-fit: cover; border-radius: 8px; border: 1px solid #DCE4EE; }
  .lead footer { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; }
  .status { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #5A6A85; }
  .lead footer .actions { display: flex; gap: 8px; align-items: center; }
  .lead footer button { background: var(--navy); color: #fff; border: 0; padding: 7px 12px; border-radius: 7px; font-size: 13px; cursor: pointer; }
  .lead footer button.trash { background: #fff; border: 1px solid #DCE4EE; color: #5A6A85; width: 34px; height: 34px; padding: 0; display: grid; place-items: center; }
  .lead footer button.trash:hover { background: var(--red); border-color: var(--red); color: #fff; }
  .lead footer button.trash svg { width: 16px; height: 16px; }
</style></head>
<body>
<div class="top"><h1>Patriot's Plumbing — Service Requests</h1><a href="/leads.csv?key=${key}">Download CSV</a></div>
<main>${cards || '<p class="empty">No service requests yet. New leads appear here the moment a customer submits the form.</p>'}</main>
</body></html>`);
});

app.post('/leads/:id/status', async (req, res) => {
  if (!keyOk(req.query.key)) return res.status(401).send('Unauthorized');
  const { rows } = await pool.query('SELECT status FROM leads WHERE id = $1', [req.params.id]);
  if (rows.length) {
    const next = STATUSES[(STATUSES.indexOf(rows[0].status) + 1) % STATUSES.length];
    await pool.query('UPDATE leads SET status = $1 WHERE id = $2', [next, req.params.id]);
  }
  res.redirect(303, `/leads?key=${encodeURIComponent(req.query.key)}`);
});

app.post('/leads/:id/delete', async (req, res) => {
  if (!keyOk(req.query.key)) return res.status(401).send('Unauthorized');
  await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]); // photos cascade
  res.redirect(303, `/leads?key=${encodeURIComponent(req.query.key)}`);
});

app.get('/leads/:id/photo/:idx', async (req, res) => {
  if (!keyOk(req.query.key)) return res.status(401).send('Unauthorized');
  const { rows } = await pool.query(
    'SELECT mime, bytes FROM lead_photos WHERE lead_id = $1 AND idx = $2',
    [req.params.id, Number(req.params.idx) || 0],
  );
  if (!rows.length) return res.status(404).send('Not found');
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(rows[0].bytes);
});

app.get('/leads.csv', async (req, res) => {
  if (!keyOk(req.query.key)) return res.status(401).send('Unauthorized');
  const { rows } = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
  const cols = ['created_at', 'name', 'phone', 'email', 'address', 'problem', 'details', 'timing', 'status', 'source'];
  const csv = [cols.join(',')].concat(rows.map(r =>
    cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','),
  )).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="patriots-plumbing-leads.csv"');
  res.send(csv);
});

// ---------------------------------------------------------------------------

initDb()
  .then(() => app.listen(PORT, () => console.log(`patriots-plumbing-api listening on :${PORT}`)))
  .catch((err) => { console.error('db init failed:', err.message); process.exit(1); });
