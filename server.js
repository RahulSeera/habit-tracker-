const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { pool, init } = require('./db');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'ct_session';
const SESSION_DAYS = 60;

if (!PASSWORD) console.warn('APP_PASSWORD not set: the app is open to anyone with the URL.');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set: logins reset on every restart.');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// ---------- auth: signed, expiring cookie ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return false;
  const [exp, mac] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  return !!exp && !!mac && safeEqual(mac, sign(exp)) && Number(exp) > Date.now();
}

const authed = (req) => !PASSWORD || readSession(req);

app.get('/api/me', (req, res) => res.json({ authed: authed(req), needsPassword: !!PASSWORD }));

app.post('/api/login', (req, res) => {
  const given = String(req.body?.password || '');
  if (!PASSWORD || !safeEqual(sign(given), sign(PASSWORD))) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Login required' })));

// ---------- helpers ----------
const q = (text, params) => pool.query(text, params);
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(400).json({ error: e.message });
});
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);

// Build "UPDATE table SET a=$1, b=$2 WHERE id=$n" from whitelisted body fields.
async function patch(table, id, body, allowed) {
  const keys = Object.keys(body).filter((k) => allowed.includes(k));
  if (!keys.length) throw new Error('Nothing to update');
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const { rows } = await q(`UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => body[k]), id]);
  if (!rows.length) throw new Error('Not found');
  return rows[0];
}

// ---------- state ----------
app.get('/api/state', wrap(async (req, res) => {
  const [settings, rules, checks, days, goals, logs, items, todos] = await Promise.all([
    q('SELECT key, value FROM settings'),
    q('SELECT * FROM rules ORDER BY sort, id'),
    q('SELECT day, rule_id, skip FROM checks'),
    q('SELECT * FROM days'),
    q('SELECT * FROM goals ORDER BY sort, id'),
    q('SELECT * FROM goal_logs ORDER BY day, id'),
    q('SELECT * FROM goal_items ORDER BY sort, id'),
    q('SELECT * FROM todos ORDER BY id'),
  ]);
  const s = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
  res.json({
    challenge: s.challenge,
    commandments: s.commandments || [],
    schedule: s.schedule || '',
    minimum: s.minimum || { dsa: 1, pyq: 20 },
    rules: rules.rows,
    checks: checks.rows,
    days: days.rows,
    goals: goals.rows.map((g) => ({
      ...g,
      logs: logs.rows.filter((l) => l.goal_id === g.id),
      items: items.rows.filter((i) => i.goal_id === g.id),
    })),
    todos: todos.rows,
  });
}));

app.get('/api/export', wrap(async (req, res) => {
  const tables = ['settings', 'rules', 'checks', 'days', 'goals', 'goal_logs', 'goal_items', 'todos'];
  const out = { exported_at: new Date().toISOString() };
  for (const t of tables) out[t] = (await q(`SELECT * FROM ${t}`)).rows;
  res.setHeader('Content-Disposition', `attachment; filename="challenge-backup-${today()}.json"`);
  res.json(out);
}));

// ---------- settings ----------
app.put('/api/settings/:key', wrap(async (req, res) => {
  const { key } = req.params;
  if (!['challenge', 'commandments', 'schedule', 'minimum'].includes(key)) throw new Error('Unknown setting');
  const v = req.body.value;
  if (key === 'challenge' && !(v && v.name && isDate(v.start) && isDate(v.end) && v.start <= v.end)) {
    throw new Error('Challenge needs a name and a valid start/end date');
  }
  if (key === 'commandments' && !Array.isArray(v)) throw new Error('Expected a list');
  if (key === 'schedule' && typeof v !== 'string') throw new Error('Expected text');
  if (key === 'minimum' && !(v && v.dsa >= 0 && v.pyq >= 0)) throw new Error('Expected {dsa, pyq}');
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(v)]);
  res.json({ ok: true });
}));

// ---------- rules ----------
app.post('/api/rules', wrap(async (req, res) => {
  const { text, days, created_on, metric = null, min_value = null } = req.body;
  if (!text) throw new Error('Rule text required');
  const { rows } = await q(
    `INSERT INTO rules (text, days, created_on, metric, min_value, sort)
     VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(sort), 0) + 1 FROM rules)) RETURNING *`,
    [text, days || [0, 1, 2, 3, 4, 5, 6], isDate(created_on) ? created_on : today(), metric, min_value]);
  res.json(rows[0]);
}));
app.patch('/api/rules/:id', wrap(async (req, res) => {
  res.json(await patch('rules', req.params.id, req.body, ['text', 'days', 'sort', 'archived_on', 'created_on', 'metric', 'min_value']));
}));
// Hard delete (also removes its past ticks). The UI normally archives instead.
app.delete('/api/rules/:id', wrap(async (req, res) => {
  await q('DELETE FROM rules WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- daily ticks & day info ----------
// state: 'done' (ticked), 'skip' (rule doesn't apply today), 'none' (clear)
app.put('/api/checks', wrap(async (req, res) => {
  const { day, rule_id } = req.body;
  const state = req.body.state || (req.body.done ? 'done' : 'none');
  if (!isDate(day)) throw new Error('Bad date');
  if (state === 'none') {
    await q('DELETE FROM checks WHERE day = $1 AND rule_id = $2', [day, rule_id]);
  } else {
    await q(`INSERT INTO checks (day, rule_id, skip) VALUES ($1, $2, $3)
             ON CONFLICT (day, rule_id) DO UPDATE SET skip = EXCLUDED.skip`, [day, rule_id, state === 'skip']);
  }
  res.json({ ok: true });
}));

app.put('/api/days/:day', wrap(async (req, res) => {
  const { day } = req.params;
  if (!isDate(day)) throw new Error('Bad date');
  // Partial update: only the fields sent are changed.
  const b = { ...req.body };
  if (b.hours === '') b.hours = null;
  for (const k of ['dsa', 'pyq']) if (k in b) b[k] = Math.max(0, Math.round(Number(b[k]) || 0));
  const keys = ['minimum', 'hours', 'note', 'dsa', 'pyq'].filter((k) => k in b);
  await q('INSERT INTO days (day) VALUES ($1) ON CONFLICT DO NOTHING', [day]);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = keys.length
    ? await q(`UPDATE days SET ${sets} WHERE day = $1 RETURNING *`, [day, ...keys.map((k) => b[k])])
    : await q('SELECT * FROM days WHERE day = $1', [day]);
  res.json(rows[0]);
}));

// ---------- goals ----------
const GOAL_FIELDS = ['title', 'category', 'horizon', 'kind', 'unit', 'start_value', 'target_value',
  'start_date', 'end_date', 'done_on', 'why', 'sort', 'auto'];

app.post('/api/goals', wrap(async (req, res) => {
  const g = req.body;
  if (!g.title || !isDate(g.end_date)) throw new Error('Title and end date required');
  const { rows } = await q(
    `INSERT INTO goals (title, category, horizon, kind, unit, start_value, target_value,
       start_date, end_date, why, auto, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT COALESCE(MAX(sort), 0) + 1 FROM goals))
     RETURNING *`,
    [g.title, g.category || 'other', g.horizon || 'short', g.kind || 'checklist', g.unit || '',
      g.start_value ?? null, g.target_value ?? null, isDate(g.start_date) ? g.start_date : today(),
      g.end_date, g.why || '', g.auto || null]);
  res.json(rows[0]);
}));
app.patch('/api/goals/:id', wrap(async (req, res) => {
  res.json(await patch('goals', req.params.id, req.body, GOAL_FIELDS));
}));
app.delete('/api/goals/:id', wrap(async (req, res) => {
  await q('DELETE FROM goals WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/goals/:id/logs', wrap(async (req, res) => {
  const { day, value } = req.body;
  if (!isDate(day) || value === '' || value === null || isNaN(Number(value))) throw new Error('Need a date and a number');
  const { rows } = await q('INSERT INTO goal_logs (goal_id, day, value) VALUES ($1, $2, $3) RETURNING *',
    [req.params.id, day, value]);
  res.json(rows[0]);
}));
app.delete('/api/goal-logs/:id', wrap(async (req, res) => {
  await q('DELETE FROM goal_logs WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/goals/:id/items', wrap(async (req, res) => {
  if (!req.body.text) throw new Error('Text required');
  const { rows } = await q(
    `INSERT INTO goal_items (goal_id, text, sort)
     VALUES ($1, $2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM goal_items WHERE goal_id = $1)) RETURNING *`,
    [req.params.id, req.body.text]);
  res.json(rows[0]);
}));
app.patch('/api/goal-items/:id', wrap(async (req, res) => {
  res.json(await patch('goal_items', req.params.id, req.body, ['text', 'done_on', 'sort']));
}));
app.delete('/api/goal-items/:id', wrap(async (req, res) => {
  await q('DELETE FROM goal_items WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- daily targets ----------
app.post('/api/todos', wrap(async (req, res) => {
  const { day, text } = req.body;
  if (!isDate(day) || !text) throw new Error('Need a date and text');
  const { rows } = await q('INSERT INTO todos (day, text) VALUES ($1, $2) RETURNING *', [day, text]);
  res.json(rows[0]);
}));
app.patch('/api/todos/:id', wrap(async (req, res) => {
  res.json(await patch('todos', req.params.id, req.body, ['text', 'done', 'day']));
}));
app.delete('/api/todos/:id', wrap(async (req, res) => {
  await q('DELETE FROM todos WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

init()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Challenge tracker on http://0.0.0.0:${PORT}`)))
  .catch((e) => {
    console.error('Database init failed:', e);
    process.exit(1);
  });
