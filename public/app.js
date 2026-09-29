'use strict';

// ---------- tiny helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TABS = ['today', 'goals', 'calendar', 'setup'];
const METRICS = { dsa: 'DSA problems', pyq: 'GATE PYQs', hours: 'study hours' };

function todayISO() {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
}
const nowHM = () => new Date().toTimeString().slice(0, 5);
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diffDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const weekday = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const fmt = (iso, opts = { day: 'numeric', month: 'short' }) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pct = (x) => Math.round(x * 100) + '%';
const num = (v) => (Number.isInteger(v) ? v : Math.round(v * 10) / 10);
function eachDay(from, to, fn) { for (let d = from; d <= to; d = addDays(d, 1)) fn(d); }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Login required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------- state ----------
let S = null;
let tab = 'today';
let selDay = todayISO();
let checkMap = new Map(); // "day|ruleId" -> 'done' | 'skip'
let schedule = [];
let focusAfter = null;
let carriedFor = null;
try { tab = localStorage.getItem('ct_tab') || 'today'; } catch {}
if (TABS.includes(location.hash.slice(1))) tab = location.hash.slice(1);

function parseSchedule(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(\w+)\s*(.*)$/i);
    if (!m) continue;
    const pad = (t) => t.padStart(5, '0');
    out.push({ wd: WD.findIndex((d) => d.toLowerCase() === m[1].toLowerCase().slice(0, 3)),
      start: pad(m[2]), end: pad(m[3]), type: m[4].toLowerCase(), label: m[5] || m[4] });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

async function load() {
  S = await api('GET', '/api/state');
  checkMap = new Map(S.checks.map((c) => [c.day + '|' + c.rule_id, c.skip ? 'skip' : 'done']));
  schedule = parseSchedule(S.schedule);
  if (await autoCarry()) return load();
  render();
}

// Unfinished targets from the last 2 weeks move to today automatically.
async function autoCarry() {
  const t = todayISO();
  if (carriedFor === t) return false;
  carriedFor = t;
  const stale = S.todos.filter((x) => !x.done && x.day < t && x.day >= addDays(t, -14));
  if (!stale.length) return false;
  await Promise.all(stale.map((x) => api('PATCH', `/api/todos/${x.id}`, { day: t })));
  toast(`Moved ${stale.length} unfinished target${stale.length > 1 ? 's' : ''} to today`);
  return true;
}

// Run a mutation, then reload; show errors instead of failing silently.
async function act(fn) {
  try { await fn(); await load(); } catch (e) { toast(e.message); }
}

// Counter saves are queued so rapid taps are written in order; one reload after the taps stop.
let saveChain = Promise.resolve();
let reloadTimer = null;
function queueSave(fn) {
  saveChain = saveChain.then(fn).catch((e) => toast(e.message));
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => saveChain.then(load), 900);
}

// ---------- derived data ----------
const emptyDay = (day) => ({ day, minimum: false, hours: null, note: '', dsa: 0, pyq: 0 });
const dayRow = (day) => S.days.find((d) => d.day === day) || emptyDay(day);
function setDayLocal(day, patch) {
  const i = S.days.findIndex((d) => d.day === day);
  if (i >= 0) S.days[i] = { ...S.days[i], ...patch };
  else S.days.push({ ...emptyDay(day), ...patch });
}

const ruleActive = (r, day) => r.created_on <= day && (!r.archived_on || r.archived_on > day) && r.days.includes(weekday(day));
const isSkipped = (day, r) => checkMap.get(day + '|' + r.id) === 'skip';
const autoDone = (day, r) => !!r.metric && r.min_value != null && Number(dayRow(day)[r.metric] || 0) >= r.min_value;
const ruleDone = (day, r) => checkMap.get(day + '|' + r.id) === 'done' || autoDone(day, r);
const rulesFor = (day) => S.rules.filter((r) => ruleActive(r, day) && !isSkipped(day, r));

function minimumMet(day) {
  const m = S.minimum, d = dayRow(day);
  if (!m.dsa && !m.pyq) return false;
  return (d.dsa || 0) >= m.dsa && (d.pyq || 0) >= m.pyq;
}

function dayStatus(day) {
  const t = todayISO();
  if (day > t) return 'future';
  const rules = rulesFor(day);
  const done = rules.filter((r) => ruleDone(day, r)).length;
  if (rules.length && done === rules.length) return 'complete';
  if (minimumMet(day)) return 'minimum';
  const d = dayRow(day);
  if (day === t) return done || d.dsa || d.pyq || d.hours ? 'progress' : 'open';
  return done ? 'partial' : 'missed';
}
const counts = (st) => st === 'complete' || st === 'minimum';
const STATUS_LABEL = {
  complete: 'All rules done', minimum: 'Minimum day (counts)', partial: 'Partial (missed)', missed: 'Missed',
  open: 'Not started', progress: 'In progress', future: 'Upcoming',
};

function bestStreak(from, to) {
  let run = 0, best = 0;
  eachDay(from, to, (d) => { if (counts(dayStatus(d))) best = Math.max(best, ++run); else if (d !== todayISO()) run = 0; });
  return best;
}

function challengeStats() {
  const { start, end } = S.challenge;
  const t = todayISO();
  const last = t < end ? t : end;
  let complete = 0, minimum = 0, missed = 0, doubleMiss = 0, prevMiss = false;
  eachDay(start, last, (d) => {
    const st = dayStatus(d);
    if (st === 'complete') complete++;
    if (st === 'minimum') minimum++;
    if (counts(st)) prevMiss = false;
    else if (st === 'missed' || st === 'partial') { missed++; if (prevMiss) doubleMiss++; prevMiss = true; }
  });
  // current streak: walk back from today; an unfinished today doesn't break it
  let cur = 0, d = t > end ? end : t;
  if (!counts(dayStatus(d)) && d === t) d = addDays(d, -1);
  while (d >= start && counts(dayStatus(d))) { cur++; d = addDays(d, -1); }
  const total = diffDays(start, end) + 1;
  const dayNum = Math.min(total, Math.max(0, diffDays(start, t) + 1));
  const elapsedPast = Math.max(0, Math.min(total, diffDays(start, t)));
  return { total, dayNum, cur, best: bestStreak(start, last), complete, minimum, missed, doubleMiss,
    rate: elapsedPast ? (complete + minimum) / elapsedPast : null };
}

// ---------- goals ----------
function autoValue(g, until) {
  const t = todayISO();
  let to = g.end_date < t ? g.end_date : t;
  if (until && until < to) to = until;
  const base = g.start_value || 0;
  if (to < g.start_date) return base;
  if (g.auto === 'streak') return bestStreak(g.start_date, to);
  if (METRICS[g.auto]) {
    return base + S.days.filter((d) => d.day >= g.start_date && d.day <= to)
      .reduce((a, d) => a + Number(d[g.auto] || 0), 0);
  }
  if (g.auto?.startsWith('rule:')) {
    const r = S.rules.find((x) => x.id === Number(g.auto.slice(5)));
    if (!r) return base;
    let n = 0;
    eachDay(g.start_date, to, (d) => { if (ruleActive(r, d) && !isSkipped(d, r) && ruleDone(d, r)) n++; });
    return base + n;
  }
  return base;
}
const currentValue = (g) => (g.auto ? autoValue(g) : g.logs.length ? g.logs[g.logs.length - 1].value : g.start_value);

function autoLabel(auto) {
  if (!auto) return '';
  if (auto === 'streak') return 'best streak of full/minimum days';
  if (METRICS[auto]) return `your daily ${METRICS[auto]} counter`;
  const r = S.rules.find((x) => x.id === Number(auto.slice(5)));
  return r ? `ticks of "${r.text}"` : 'a removed rule';
}

function goalProgress(g) {
  if (g.kind === 'binary') return g.done_on ? 1 : 0;
  if (g.kind === 'checklist') {
    if (!g.items.length) return g.done_on ? 1 : 0;
    return g.items.filter((i) => i.done_on).length / g.items.length;
  }
  const cur = currentValue(g);
  const start = g.auto ? g.start_value || 0 : g.start_value;
  if (start == null || g.target_value == null || cur == null || start === g.target_value) return null;
  return clamp01((cur - start) / (g.target_value - start));
}

function goalPace(g, p) {
  const t = todayISO();
  if (p === 1 || g.done_on) return ['done', 'Achieved'];
  if (t > g.end_date) return ['overdue', `Overdue by ${diffDays(g.end_date, t)}d`];
  if (p == null) return ['behind', 'Set start & target'];
  if (g.kind === 'binary') return ['ok', ''];
  const span = Math.max(1, diffDays(g.start_date, g.end_date));
  const timeFrac = clamp01(diffDays(g.start_date, t) / span);
  return p + 0.05 >= timeFrac ? ['ok', 'On track'] : ['behind', `Behind (${pct(p)} done, ${pct(timeFrac)} of time used)`];
}
const isActive = (g, day) => g.start_date <= day && day <= g.end_date && goalProgress(g) !== 1 && !g.done_on;

// ---------- auto targets ----------
// DSA: the highest per-day pace any active DSA goal needs, counted from before today.
function dsaTarget(day) {
  if (dayRow(day).minimum) return { need: S.minimum.dsa, why: 'light day' };
  const rule = S.rules.find((r) => r.metric === 'dsa' && ruleActive(r, day));
  let need = rule ? rule.min_value : 0, why = rule ? 'daily rule' : '';
  for (const g of S.goals.filter((x) => x.auto === 'dsa' && x.kind === 'number' && isActive(x, day))) {
    const before = autoValue(g, addDays(day, -1));
    const perDay = Math.ceil((g.target_value - before) / (diffDays(day, g.end_date) + 1));
    if (perDay > need) { need = perDay; why = `pace for "${g.title}"`; }
  }
  return { need, why };
}
function pyqTarget(day) {
  if (dayRow(day).minimum) return { need: S.minimum.pyq, why: 'light day' };
  const rule = S.rules.find((r) => r.metric === 'pyq' && ruleActive(r, day));
  return { need: Math.max(rule ? rule.min_value : 0, S.minimum.pyq), why: rule ? 'daily rule' : 'minimum' };
}
// GATE: next unfinished topic of the active GATE checklist goal that ends soonest.
function gateTopic(day) {
  const goals = S.goals.filter((g) => g.category === 'gate' && g.kind === 'checklist' && isActive(g, day))
    .sort((a, b) => a.end_date.localeCompare(b.end_date));
  for (const g of goals) {
    const item = g.items.find((i) => !i.done_on);
    if (item) return { goal: g, item };
  }
  return null;
}

function weakSpots() {
  const t = todayISO();
  const from = addDays(t, -7) < S.challenge.start ? S.challenge.start : addDays(t, -7);
  const stats = [];
  for (const r of S.rules.filter((x) => !x.archived_on)) {
    let app = 0, done = 0;
    eachDay(from, addDays(t, -1), (d) => { if (ruleActive(r, d) && !isSkipped(d, r)) { app++; if (ruleDone(d, r)) done++; } });
    if (app) stats.push({ r, app, done, rate: done / app });
  }
  return stats.sort((a, b) => a.rate - b.rate).filter((s) => s.rate < 0.8).slice(0, 3);
}

// ---------- rendering ----------
function render() {
  document.title = S.challenge.name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderHeader();
  $('#view').innerHTML = { today: viewToday, goals: viewGoals, calendar: viewCalendar, setup: viewSetup }[tab]();
  if (focusAfter) { const el = $(focusAfter); if (el) el.focus(); focusAfter = null; }
}

function renderHeader() {
  const s = challengeStats();
  const { start, end, name } = S.challenge;
  const t = todayISO();
  const daysLeft = Math.max(0, diffDays(t, end));
  const label = t < start ? `Starts in ${diffDays(t, start)}d` : t > end ? 'Finished' : `Day ${s.dayNum} / ${s.total}`;
  $('#header').innerHTML = `
    <div class="header-top"><h1>${esc(name)}</h1><span class="day-count">${label}</span></div>
    <div class="bar"><i style="width:${pct(clamp01(s.dayNum / s.total))}"></i></div>
    <div class="stats">
      <div class="stat"><b>${s.cur}</b><span>current streak</span></div>
      <div class="stat"><b>${s.best}</b><span>best streak</span></div>
      <div class="stat"><b>${s.rate == null ? '–' : pct(s.rate)}</b><span>days kept</span></div>
      <div class="stat ${s.doubleMiss ? 'alert' : ''}"><b>${daysLeft}</b><span>${s.doubleMiss ? `days left · ${s.doubleMiss} double-miss` : 'days left'}</span></div>
    </div>`;
}

function counter(field, label, value, target, steps, why) {
  const done = target ? value >= target : false;
  return `
  <div class="counter ${done ? 'hit' : ''}">
    <div class="counter-label"><b>${label}</b>${target ? `<span class="muted small"> target ${target}${why ? ' · ' + esc(why) : ''}</span>` : ''}</div>
    <div class="counter-row">
      <button class="btn step" data-act="bump" data-f="${field}" data-n="${-steps[0]}" aria-label="Decrease">−</button>
      <span class="counter-val">${num(value)}${target ? `<small>/${target}</small>` : ''}</span>
      ${steps.map((n) => `<button class="btn step plus" data-act="bump" data-f="${field}" data-n="${n}">+${n}</button>`).join('')}
    </div>
    ${target ? `<div class="bar ok thin"><i style="width:${pct(clamp01(value / target))}"></i></div>` : ''}
  </div>`;
}

function planCard(day) {
  const t = todayISO();
  const blocks = schedule.filter((b) => b.wd === weekday(day));
  if (!blocks.length) return `<div class="card"><div class="card-head"><h2>Plan</h2></div><p class="muted small">No timetable for ${WD[weekday(day)]}. Add blocks in Setup.</p></div>`;
  const hm = nowHM();
  const light = dayRow(day).minimum;
  const dsa = dsaTarget(day), pyq = pyqTarget(day), topic = gateTopic(day);
  const d = dayRow(day);
  const gymRule = S.rules.find((r) => /gym/i.test(r.text) && ruleActive(r, day));
  const extra = (b) => {
    if (b.type === 'dsa') return `→ ${d.dsa || 0}/${dsa.need} problems`;
    if (b.type === 'gate') return topic ? `→ ${esc(topic.item.text)} · ${d.pyq || 0}/${pyq.need} PYQs` : `→ ${d.pyq || 0}/${pyq.need} PYQs`;
    if (b.type === 'gym' && gymRule) return ruleDone(day, gymRule) ? '→ done ✓' : isSkipped(day, gymRule) ? '→ skipped' : '';
    return '';
  };
  return `
  <div class="card">
    <div class="card-head"><h2>Plan · ${WD[weekday(day)]}</h2><button class="btn small" data-act="goto-setup">Edit timetable</button></div>
    ${light ? '<p class="light-note">Light day: only the minimum is expected (DSA + PYQ targets reduced). It still counts for your streak.</p>' : ''}
    <ol class="plan">
      ${blocks.map((b) => {
        const now = day === t && hm >= b.start && hm < b.end;
        const past = day < t || (day === t && hm >= b.end);
        return `<li class="blk ${b.type} ${now ? 'now' : ''} ${past ? 'past' : ''}">
          <span class="time">${b.start}–${b.end}</span>
          <span class="what">${esc(b.label)} <span class="extra">${extra(b)}</span></span>
          ${now ? '<span class="now-tag">NOW</span>' : ''}</li>`;
      }).join('')}
    </ol>
  </div>`;
}

function viewToday() {
  const day = selDay, t = todayISO();
  const st = dayStatus(day);
  const allRules = S.rules.filter((r) => ruleActive(r, day));
  const rules = allRules.filter((r) => !isSkipped(day, r));
  const skipped = allRules.filter((r) => isSkipped(day, r));
  const done = rules.filter((r) => ruleDone(day, r)).length;
  const row = dayRow(day);
  const todos = S.todos.filter((x) => x.day === day);
  const manualGoals = S.goals.filter((g) => g.kind === 'number' && !g.auto && isActive(g, day));
  const dsa = dsaTarget(day), pyq = pyqTarget(day), topic = gateTopic(day);
  const dayLabel = day === t ? 'Today' : day === addDays(t, -1) ? 'Yesterday' : day === addDays(t, 1) ? 'Tomorrow' : WD[weekday(day)];

  const weak = day === t ? weakSpots() : [];
  const behind = S.goals.filter((g) => isActive(g, t)).map((g) => [g, goalPace(g, goalProgress(g))])
    .filter(([, [c, txt]]) => (c === 'behind' && txt !== 'Set start & target') || c === 'overdue').slice(0, 3);
  const needSetup = S.goals.filter((g) => g.kind === 'number' && !g.auto && g.start_value == null && isActive(g, t));

  return `
  <div class="day-nav">
    <button class="btn" data-act="day" data-n="-1" aria-label="Previous day">&larr;</button>
    <div class="date"><b>${dayLabel}, ${fmt(day, { day: 'numeric', month: 'long' })}</b>
      <span class="pill ${st}">${STATUS_LABEL[st]}</span></div>
    <button class="btn" data-act="day" data-n="1" aria-label="Next day">&rarr;</button>
  </div>
  <div class="day-tools">
    ${day !== t ? '<a href="#" data-act="goto-today">Back to today</a>' : '<span></span>'}
    <button class="btn small ${row.minimum ? 'on' : ''}" data-act="light" title="Exams, sick, travel: targets drop to the minimum">
      ${row.minimum ? 'Light day ✓' : 'Light day (exam / sick / travel)'}</button>
  </div>

  <div class="card">
    <div class="card-head"><h2>Quick log</h2><span class="muted small">Tap as you go. Everything else updates itself.</span></div>
    <div class="counters">
      ${counter('dsa', 'DSA problems', row.dsa || 0, dsa.need, [1], dsa.why)}
      ${counter('pyq', 'GATE PYQs', row.pyq || 0, pyq.need, [1, 5], pyq.why)}
      ${counter('hours', 'Study hours', Number(row.hours || 0), null, [0.5, 1])}
    </div>
    ${topic ? `
      <div class="topic">
        <div><span class="muted small">Today's GATE topic (${esc(topic.goal.title)})</span><br><b>${esc(topic.item.text)}</b></div>
        <button class="btn small" data-act="topic-done" data-id="${topic.item.id}">Topic finished ✓</button>
      </div>` : ''}
  </div>

  ${planCard(day)}

  <div class="card">
    <div class="card-head"><h2>Daily rules · ${done}/${rules.length}</h2>
      <span class="muted small">${minimumMet(day) && st !== 'complete' ? 'Minimum reached ✓' : `Minimum: ${S.minimum.dsa} DSA + ${S.minimum.pyq} PYQs`}</span></div>
    <div class="bar ok" style="margin-top:0"><i style="width:${rules.length ? pct(done / rules.length) : '0%'}"></i></div>
    <ul class="checks">
      ${rules.map((r) => {
        const auto = autoDone(day, r), c = ruleDone(day, r);
        const prog = r.metric ? `<span class="badge">auto · ${num(Number(row[r.metric] || 0))}/${num(r.min_value)}</span>` : '';
        return `
        <li class="${c ? 'done' : ''}"><label><input type="checkbox" data-act="check" data-id="${r.id}" ${c ? 'checked' : ''} ${auto ? 'disabled title="Ticked automatically from your counter"' : ''}>
          <span>${esc(r.text)}</span>${prog}</label>
          ${c ? '' : `<button class="skip-btn" data-act="skip" data-id="${r.id}" title="Doesn't apply today (injury, travel, holiday)">skip</button>`}</li>`;
      }).join('') || '<li class="muted">No rules for this day. Add some in Setup.</li>'}
    </ul>
    ${skipped.length ? `<p class="small muted" style="margin:8px 0 0">Skipped today: ${skipped.map((r) =>
      `${esc(r.text)} <a href="#" data-act="unskip" data-id="${r.id}">undo</a>`).join(' · ')}</p>` : ''}
  </div>

  <div class="card">
    <div class="card-head"><h2>Extra targets</h2><span class="muted small">Unfinished ones move to the next day automatically</span></div>
    <ul class="checks">
      ${todos.map((x) => `
        <li class="${x.done ? 'done' : ''}"><label><input type="checkbox" data-act="todo" data-id="${x.id}" ${x.done ? 'checked' : ''}><span>${esc(x.text)}</span></label>
        <button class="icon-btn" data-act="del-todo" data-id="${x.id}" aria-label="Delete">&times;</button></li>`).join('')
      || '<li class="muted small">Optional. Things outside the plan, e.g. "CSD assignment part 2", "Call alum at Razorpay".</li>'}
    </ul>
    <form class="add-row" data-form="todo"><input id="todo-input" name="text" placeholder="Add a target…" autocomplete="off"><button class="btn primary">Add</button></form>
  </div>

  ${day === t ? `
  <div class="card insights">
    <div class="card-head"><h2>Coach</h2><span class="muted small">Automatic, from your last 7 days</span></div>
    ${weak.length ? `<p><b>Weak spots:</b> ${weak.map((w) => `${esc(w.r.text)} <span class="muted">(${w.done}/${w.app})</span>`).join(' · ')}</p>
      <p><b>Focus today:</b> protect "${esc(weak[0].r.text)}" first. It's your biggest leak.</p>`
      : `<p>${diffDays(S.challenge.start, t) < 2 ? 'Not enough history yet. Check back in a couple of days.' : 'No weak spots in the last 7 days. Keep it exactly like this.'}</p>`}
    ${behind.length ? `<p><b>Behind schedule:</b> ${behind.map(([g, [, txt]]) => `${esc(g.title)} <span class="muted">(${esc(txt)})</span>`).join(' · ')}</p>` : ''}
    ${needSetup.length ? `<p><b>Needs a starting value:</b> ${needSetup.map((g) => `<a href="#" data-act="edit-goal" data-id="${g.id}">${esc(g.title)}</a>`).join(' · ')}</p>` : ''}
  </div>` : ''}

  ${manualGoals.length ? `
  <div class="card">
    <details><summary>Update measurements (only when they change)</summary>
    ${manualGoals.map((g) => `
      <form class="add-row" data-form="log" data-id="${g.id}">
        <label style="flex:1">${esc(g.title)} <span class="muted">(now: ${currentValue(g) == null ? '–' : num(currentValue(g)) + ' ' + esc(g.unit)})</span>
          <input name="value" type="number" step="any" placeholder="New value in ${esc(g.unit || 'units')}"></label>
        <button class="btn" style="align-self:flex-end">Save</button>
      </form>`).join('')}
    </details>
  </div>` : ''}

  <div class="card">
    <label>Note for ${dayLabel.toLowerCase()} (optional)<textarea id="note" placeholder="What broke? One fix for tomorrow.">${esc(row.note)}</textarea></label>
  </div>

  <div class="card">
    <details><summary>The rules of this challenge</summary>
      <ol class="commandments">${S.commandments.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
    </details>
  </div>`;
}

function sparkline(g) {
  const vals = [g.start_value, ...g.logs.map((l) => l.value)].filter((v) => v != null);
  if (vals.length < 2) return '';
  const w = 120, h = 32, min = Math.min(...vals, g.target_value ?? Infinity), max = Math.max(...vals, g.target_value ?? -Infinity);
  const y = (v) => (max === min ? h / 2 : h - 2 - ((v - min) / (max - min)) * (h - 4));
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${y(v)}`).join(' ');
  const ty = g.target_value != null ? `<line x1="0" x2="${w}" y1="${y(g.target_value)}" y2="${y(g.target_value)}" stroke="currentColor" stroke-dasharray="3 3" opacity=".4"/>` : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${ty}<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function goalCard(g) {
  const t = todayISO();
  const p = goalProgress(g);
  const [paceCls, paceText] = goalPace(g, p);
  const achieved = paceCls === 'done';
  const left = diffDays(t, g.end_date);
  const span = Math.max(1, diffDays(g.start_date, g.end_date));
  const timeFrac = clamp01(diffDays(g.start_date, t) / span);
  let body = '';

  if (g.kind === 'number') {
    const cur = currentValue(g);
    const start = g.auto ? g.start_value || 0 : g.start_value;
    body = `
      <div class="numbers">
        <div class="big">${cur == null ? '–' : num(cur)}<small> ${esc(g.unit)}</small></div>
        <div class="small muted">start ${start == null ? '<b>not set</b>' : num(start)} → target <b>${g.target_value == null ? '–' : num(g.target_value)}</b></div>
        ${g.auto ? '' : sparkline(g)}
      </div>
      ${g.auto ? `<p class="small muted" style="margin:6px 0 0">⚡ Auto-counted from ${esc(autoLabel(g.auto))}.</p>` : `
      <form class="add-row" data-form="log" data-id="${g.id}"><input name="value" type="number" step="any" placeholder="Log new value"><button class="btn">Log</button></form>
      ${g.logs.length ? `<div class="logs">${g.logs.slice(-5).reverse().map((l) => `<span>${fmt(l.day)}: ${num(l.value)}<button class="icon-btn" data-act="del-log" data-id="${l.id}" aria-label="Delete log">&times;</button></span>`).join('')}</div>` : ''}`}`;
  } else if (g.kind === 'checklist') {
    body = `
      <ul class="checks" style="margin-top:8px">
        ${g.items.map((i) => `
          <li class="${i.done_on ? 'done' : ''}"><label><input type="checkbox" data-act="item" data-id="${i.id}" ${i.done_on ? 'checked' : ''}><span>${esc(i.text)}</span></label>
          <button class="icon-btn" data-act="del-item" data-id="${i.id}" aria-label="Delete">&times;</button></li>`).join('')}
      </ul>
      <form class="add-row" data-form="item" data-id="${g.id}"><input name="text" placeholder="Add a step / topic…" autocomplete="off"><button class="btn">Add</button></form>`;
  } else {
    body = `<div style="margin-top:10px"><button class="btn ${g.done_on ? '' : 'primary'}" data-act="binary" data-id="${g.id}">${g.done_on ? `Achieved on ${fmt(g.done_on)} · undo` : 'Mark achieved'}</button></div>`;
  }

  return `
  <div class="card goal ${achieved ? 'achieved' : ''}">
    <div class="goal-top">
      <div><h3>${g.auto ? '<span title="Updates automatically">⚡</span> ' : ''}${esc(g.title)}</h3>
        <div class="meta"><span class="cat ${esc(g.category)}">${esc(g.category)}</span>
          <span>${fmt(g.start_date)} → ${fmt(g.end_date, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          <span>· ${span} days</span>
          ${achieved || left < 0 ? '' : `<span>· ${left} days left</span>`}
          ${paceText ? `<span class="pace ${paceCls}">· ${esc(paceText)}</span>` : ''}</div></div>
      <div class="goal-actions">
        <button class="btn small" data-act="edit-goal" data-id="${g.id}">Edit</button>
        <button class="btn small danger" data-act="del-goal" data-id="${g.id}">Delete</button></div>
    </div>
    ${g.why ? `<div class="why">${esc(g.why)}</div>` : ''}
    ${p != null ? `
      <div class="bar ok" style="margin-bottom:2px"><i style="width:${pct(p)}"></i></div>
      <div class="bar time" title="Time used"><i style="width:${pct(timeFrac)}"></i></div>
      <div class="progress-line"><span>${pct(p)} complete</span><span>${pct(timeFrac)} of time used</span></div>` : ''}
    ${body}
  </div>`;
}

function viewGoals() {
  const group = (h) => S.goals.filter((g) => g.horizon === h).sort((a, b) => {
    const da = goalProgress(a) === 1 || !!a.done_on, db = goalProgress(b) === 1 || !!b.done_on;
    return da - db || a.end_date.localeCompare(b.end_date);
  });
  const sections = [['short', 'Short-term · next 30 days'], ['mid', 'Mid-term · by ~90 days'], ['long', 'Long-term']];
  return `
  <div class="card-head" style="margin-top:12px"><span class="muted small">Green = progress, grey = time used. ⚡ goals update themselves from your daily taps.</span>
    <button class="btn primary" data-act="new-goal">+ New goal</button></div>
  ${sections.map(([h, label]) => `
    <h2 class="section-title">${label}</h2>
    ${group(h).map(goalCard).join('') || '<p class="muted">No goals here yet.</p>'}`).join('')}`;
}

function viewCalendar() {
  const { start, end } = S.challenge;
  const t = todayISO();
  const s = challengeStats();
  const lead = (weekday(start) + 6) % 7; // Monday-first grid
  let cells = '<button class="blank" tabindex="-1"></button>'.repeat(lead);
  eachDay(start, end, (d) => {
    const st = dayStatus(d);
    const cls = st === 'progress' || st === 'open' || st === 'future' ? '' : st;
    const n = diffDays(start, d) + 1;
    const first = d.endsWith('-01') || d === start;
    cells += `<button class="${cls} ${d === t ? 'today' : ''}" data-act="open-day" data-day="${d}" title="${fmt(d)} · ${STATUS_LABEL[st]}">
      ${Number(d.slice(8))}<small>${first ? fmt(d, { month: 'short' }) : 'D' + n}</small></button>`;
  });
  return `
  <div class="card">
    <div class="card-head"><h2>${fmt(start, { day: 'numeric', month: 'short', year: 'numeric' })} → ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}</h2></div>
    <div class="legend"><span><i class="complete"></i>All rules</span><span><i class="minimum"></i>Minimum day</span>
      <span><i class="partial"></i>Partial</span><span><i class="missed"></i>Missed</span></div>
    <div class="cal-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div>${d}</div>`).join('')}</div>
    <div class="cal">${cells}</div>
  </div>
  <div class="card">
    <div class="stats">
      <div class="stat"><b>${s.complete}</b><span>full days</span></div>
      <div class="stat"><b>${s.minimum}</b><span>minimum days</span></div>
      <div class="stat"><b>${s.missed}</b><span>missed days</span></div>
      <div class="stat ${s.doubleMiss ? 'alert' : ''}"><b>${s.doubleMiss}</b><span>two-in-a-row misses</span></div>
    </div>
    <p class="small muted" style="margin-bottom:0">Tap a day to open it. The only rule that really matters: never two misses in a row.</p>
  </div>`;
}

function viewSetup() {
  const c = S.challenge;
  const active = S.rules.filter((r) => !r.archived_on);
  const archived = S.rules.filter((r) => r.archived_on);
  const wdOrder = [1, 2, 3, 4, 5, 6, 0];
  return `
  <div class="card">
    <div class="card-head"><h2>Challenge</h2></div>
    <form data-form="challenge" style="display:grid;gap:10px">
      <label>Name<input name="name" value="${esc(c.name)}" required></label>
      <div class="row3">
        <label>Start<input type="date" name="start" value="${c.start}" required></label>
        <label>Days<input type="number" name="days" min="1" value="${diffDays(c.start, c.end) + 1}"></label>
        <label>End<input type="date" name="end" value="${c.end}" required></label>
      </div>
      <div><button class="btn primary">Save challenge</button></div>
    </form>
  </div>

  <div class="card">
    <div class="card-head"><h2>Weekly timetable</h2></div>
    <p class="small muted" style="margin-top:0">One block per line: <code>Day HH:MM-HH:MM type label</code>. Types:
      <code>class</code> <code>assign</code> <code>gym</code> <code>dsa</code> <code>gate</code> <code>walk</code> <code>free</code>.
      <code>dsa</code> and <code>gate</code> blocks show your live targets. Timetable changed? Just edit it here.</p>
    <form data-form="schedule"><textarea name="text" rows="14" class="mono" spellcheck="false">${esc(S.schedule)}</textarea>
      <div style="margin-top:8px"><button class="btn primary">Save timetable</button> <span class="small muted">${schedule.length} blocks</span></div></form>
  </div>

  <div class="card">
    <div class="card-head"><h2>Minimum day</h2></div>
    <p class="small muted" style="margin-top:0">If you reach this, the day counts for your streak even when other rules are missed.</p>
    <form data-form="minimum" class="add-row">
      <label style="flex:1">DSA problems<input type="number" name="dsa" min="0" value="${S.minimum.dsa}"></label>
      <label style="flex:1">GATE PYQs<input type="number" name="pyq" min="0" value="${S.minimum.pyq}"></label>
      <button class="btn primary" style="align-self:flex-end">Save</button>
    </form>
  </div>

  <div class="card">
    <div class="card-head"><h2>Daily rules</h2></div>
    <p class="small muted" style="margin-top:0">Tap weekdays to choose when a rule applies. "Auto" rules tick themselves when a counter reaches the number. Removing a rule keeps your history.</p>
    ${active.map((r) => `
      <div class="rule-row">
        <input value="${esc(r.text)}" data-act="rule-text" data-id="${r.id}">
        <div class="wd">${wdOrder.map((d) => `<button type="button" class="${r.days.includes(d) ? 'on' : ''}" data-act="rule-day" data-id="${r.id}" data-d="${d}">${WD[d][0]}</button>`).join('')}</div>
        <select data-act="rule-metric" data-id="${r.id}" class="metric-sel">
          <option value="">manual tick</option>
          ${Object.entries(METRICS).map(([k, v]) => `<option value="${k}" ${r.metric === k ? 'selected' : ''}>auto: ${v} ≥</option>`).join('')}
        </select>
        ${r.metric ? `<input type="number" class="min-in" min="0" step="any" value="${r.min_value ?? ''}" data-act="rule-min" data-id="${r.id}">` : ''}
        <button class="icon-btn" data-act="archive-rule" data-id="${r.id}" aria-label="Remove rule">&times;</button>
      </div>`).join('')}
    <form class="add-row" data-form="rule"><input name="text" placeholder="New daily rule…" autocomplete="off"><button class="btn primary">Add</button></form>
    ${archived.length ? `<details style="margin-top:12px"><summary class="small">Removed rules (${archived.length})</summary>
      ${archived.map((r) => `<div class="rule-row"><span style="flex:1" class="muted">${esc(r.text)} · removed ${fmt(r.archived_on)}</span>
        <button class="btn small" data-act="restore-rule" data-id="${r.id}">Restore</button></div>`).join('')}</details>` : ''}
  </div>

  <div class="card">
    <div class="card-head"><h2>Challenge rules (one per line)</h2></div>
    <form data-form="commandments"><textarea name="text" rows="8">${esc(S.commandments.join('\n'))}</textarea>
      <div style="margin-top:8px"><button class="btn primary">Save rules</button></div></form>
  </div>

  <div class="card">
    <div class="card-head"><h2>Data</h2></div>
    <p class="small muted" style="margin-top:0">Everything is stored in your Postgres database. Download a backup now and then anyway.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn" href="/api/export" download>Download backup (JSON)</a>
      <button class="btn" data-act="theme">Theme: ${themeLabel()}</button>
      <button class="btn danger" data-act="logout">Log out</button>
    </div>
  </div>`;
}

// ---------- theme ----------
function themeLabel() { try { return localStorage.getItem('ct_theme') || 'auto'; } catch { return 'auto'; } }
function applyTheme() {
  const t = themeLabel();
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- goal dialog ----------
const dlg = $('#goal-dialog');
const gform = $('#goal-form');
let editingGoal = null;

function openGoalDialog(g) {
  editingGoal = g || null;
  $('#goal-dialog-title').textContent = g ? 'Edit goal' : 'New goal';
  const t = todayISO();
  const v = g || { title: '', horizon: 'short', category: 'fitness', kind: 'checklist', unit: '', start_value: null,
    target_value: null, start_date: t, end_date: addDays(t, 30), why: '', auto: null };
  const sel = gform.elements.auto;
  sel.innerHTML = `<option value="">No, I'll log it myself</option>
    ${Object.entries(METRICS).map(([k, lbl]) => `<option value="${k}">Daily ${lbl} counter</option>`).join('')}
    <option value="streak">Best streak (days)</option>
    ${S.rules.filter((r) => !r.archived_on || `rule:${r.id}` === v.auto).map((r) => `<option value="rule:${r.id}">Ticks of "${esc(r.text)}"</option>`).join('')}`;
  for (const k of ['title', 'horizon', 'category', 'kind', 'unit', 'start_date', 'end_date', 'why']) gform.elements[k].value = v[k] ?? '';
  sel.value = v.auto || '';
  gform.elements.start_value.value = v.start_value ?? '';
  gform.elements.target_value.value = v.target_value ?? '';
  gform.elements.days.value = diffDays(v.start_date, v.end_date);
  syncKind();
  dlg.showModal();
}
function syncKind() { gform.querySelectorAll('.number-only').forEach((el) => (el.hidden = gform.elements.kind.value !== 'number')); }
gform.elements.kind.addEventListener('change', syncKind);
gform.elements.days.addEventListener('input', () => {
  const n = Number(gform.elements.days.value);
  if (n > 0 && gform.elements.start_date.value) gform.elements.end_date.value = addDays(gform.elements.start_date.value, n);
});
for (const k of ['start_date', 'end_date']) gform.elements[k].addEventListener('change', () => {
  const { start_date: s, end_date: e } = gform.elements;
  if (s.value && e.value) gform.elements.days.value = diffDays(s.value, e.value);
});
$('#goal-cancel').addEventListener('click', () => dlg.close());
gform.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = gform.elements;
  const numOrNull = (x) => (x.value === '' ? null : Number(x.value));
  const body = {
    title: f.title.value.trim(), horizon: f.horizon.value, category: f.category.value, kind: f.kind.value,
    unit: f.unit.value.trim(), start_value: numOrNull(f.start_value), target_value: numOrNull(f.target_value),
    start_date: f.start_date.value, end_date: f.end_date.value, why: f.why.value.trim(),
    auto: f.kind.value === 'number' && f.auto.value ? f.auto.value : null,
  };
  if (body.end_date < body.start_date) return toast('End date is before start date');
  dlg.close();
  act(() => (editingGoal ? api('PATCH', `/api/goals/${editingGoal.id}`, body) : api('POST', '/api/goals', body)));
});

// ---------- events ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});
function switchTab(name) {
  tab = name;
  try { localStorage.setItem('ct_tab', tab); } catch {}
  history.replaceState(null, '', '#' + tab);
  render();
  window.scrollTo(0, 0);
}

const view = $('#view');

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.matches('input, select, textarea')) return;
  const id = el.dataset.id;
  const t = todayISO();
  switch (el.dataset.act) {
    case 'day': selDay = addDays(selDay, Number(el.dataset.n)); render(); break;
    case 'goto-today': e.preventDefault(); selDay = t; render(); break;
    case 'goto-setup': switchTab('setup'); break;
    case 'open-day': selDay = el.dataset.day; switchTab('today'); break;
    case 'light': act(() => api('PUT', `/api/days/${selDay}`, { minimum: !dayRow(selDay).minimum })); break;
    case 'bump': {
      const f = el.dataset.f;
      const v = Math.max(0, Math.round((Number(dayRow(selDay)[f] || 0) + Number(el.dataset.n)) * 10) / 10);
      setDayLocal(selDay, { [f]: v });
      render();
      const day = selDay;
      queueSave(() => api('PUT', `/api/days/${day}`, { [f]: v }));
      break;
    }
    case 'topic-done': act(() => api('PATCH', `/api/goal-items/${id}`, { done_on: t })).then(() => toast('Topic done. Next one is up.')); break;
    case 'skip': act(() => api('PUT', '/api/checks', { day: selDay, rule_id: Number(id), state: 'skip' })); break;
    case 'unskip': e.preventDefault(); act(() => api('PUT', '/api/checks', { day: selDay, rule_id: Number(id), state: 'none' })); break;
    case 'del-todo': act(() => api('DELETE', `/api/todos/${id}`)); break;
    case 'del-log': act(() => api('DELETE', `/api/goal-logs/${id}`)); break;
    case 'del-item': act(() => api('DELETE', `/api/goal-items/${id}`)); break;
    case 'binary': {
      const g = S.goals.find((x) => x.id === Number(id));
      act(() => api('PATCH', `/api/goals/${id}`, { done_on: g.done_on ? null : t }));
      break;
    }
    case 'new-goal': openGoalDialog(); break;
    case 'edit-goal': e.preventDefault(); openGoalDialog(S.goals.find((x) => x.id === Number(id))); break;
    case 'del-goal': {
      const g = S.goals.find((x) => x.id === Number(id));
      if (confirm(`Delete "${g.title}" and all its history?`)) act(() => api('DELETE', `/api/goals/${id}`));
      break;
    }
    case 'rule-day': {
      const r = S.rules.find((x) => x.id === Number(id));
      const d = Number(el.dataset.d);
      const days = r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort();
      if (!days.length) return toast('A rule needs at least one day');
      act(() => api('PATCH', `/api/rules/${id}`, { days }));
      break;
    }
    case 'archive-rule': act(() => api('PATCH', `/api/rules/${id}`, { archived_on: t })); break;
    case 'restore-rule': act(() => api('PATCH', `/api/rules/${id}`, { archived_on: null })); break;
    case 'theme': {
      const next = { auto: 'dark', dark: 'light', light: 'auto' }[themeLabel()];
      try { localStorage.setItem('ct_theme', next); } catch {}
      applyTheme(); render(); break;
    }
    case 'logout': api('POST', '/api/logout').then(showLogin, (err) => toast(err.message)); break;
  }
});

view.addEventListener('change', (e) => {
  const el = e.target;
  const id = el.dataset.id;
  const a = el.dataset.act;
  if (a === 'check') {
    const key = selDay + '|' + id;
    el.checked ? checkMap.set(key, 'done') : checkMap.delete(key); // optimistic
    render();
    api('PUT', '/api/checks', { day: selDay, rule_id: Number(id), state: el.checked ? 'done' : 'none' })
      .then(load, (err) => { toast(err.message); load(); });
  } else if (a === 'todo') {
    act(() => api('PATCH', `/api/todos/${id}`, { done: el.checked }));
  } else if (a === 'item') {
    act(() => api('PATCH', `/api/goal-items/${id}`, { done_on: el.checked ? todayISO() : null }));
  } else if (a === 'rule-text') {
    if (el.value.trim()) act(() => api('PATCH', `/api/rules/${id}`, { text: el.value.trim() }));
  } else if (a === 'rule-metric') {
    const r = S.rules.find((x) => x.id === Number(id));
    act(() => api('PATCH', `/api/rules/${id}`, { metric: el.value || null, min_value: el.value ? r.min_value ?? 1 : null }));
  } else if (a === 'rule-min') {
    if (el.value !== '') act(() => api('PATCH', `/api/rules/${id}`, { min_value: Number(el.value) }));
  } else if (el.id === 'note') {
    act(() => api('PUT', `/api/days/${selDay}`, { note: el.value }));
  } else if (el.form?.dataset.form === 'challenge') {
    const f = el.form.elements;
    if (el.name === 'end') f.days.value = diffDays(f.start.value, f.end.value) + 1;
    else if (el.name === 'days' || el.name === 'start') {
      const n = Number(f.days.value);
      if (n > 0) f.end.value = addDays(f.start.value, n - 1);
    }
  }
});

view.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = form.elements;
  const id = form.dataset.id;
  switch (form.dataset.form) {
    case 'todo': {
      const text = f.text.value.trim();
      if (!text) return;
      focusAfter = '#todo-input';
      act(() => api('POST', '/api/todos', { day: selDay, text }));
      break;
    }
    case 'log': {
      if (f.value.value === '') return;
      act(() => api('POST', `/api/goals/${id}/logs`, { day: selDay, value: Number(f.value.value) })).then(() => toast('Saved'));
      break;
    }
    case 'item': {
      const text = f.text.value.trim();
      if (!text) return;
      focusAfter = `form[data-form="item"][data-id="${id}"] input`;
      act(() => api('POST', `/api/goals/${id}/items`, { text }));
      break;
    }
    case 'rule': {
      const text = f.text.value.trim();
      if (!text) return;
      act(() => api('POST', '/api/rules', { text, created_on: S.challenge.start <= todayISO() ? todayISO() : S.challenge.start }));
      break;
    }
    case 'challenge': {
      const value = { name: f.name.value.trim(), start: f.start.value, end: f.end.value };
      if (value.end < value.start) return toast('End date is before start date');
      act(() => api('PUT', '/api/settings/challenge', { value })).then(() => toast('Saved'));
      break;
    }
    case 'commandments': {
      const value = f.text.value.split('\n').map((s) => s.trim()).filter(Boolean);
      act(() => api('PUT', '/api/settings/commandments', { value })).then(() => toast('Saved'));
      break;
    }
    case 'schedule': {
      const text = f.text.value;
      const bad = text.split('\n').filter((l) => l.trim() && !parseSchedule(l).length);
      if (bad.length) return toast(`Can't read: "${bad[0].trim()}"`);
      act(() => api('PUT', '/api/settings/schedule', { value: text.trim() })).then(() => toast('Timetable saved'));
      break;
    }
    case 'minimum': {
      const value = { dsa: Number(f.dsa.value) || 0, pyq: Number(f.pyq.value) || 0 };
      act(() => api('PUT', '/api/settings/minimum', { value })).then(() => toast('Saved'));
      break;
    }
  }
});

// ---------- login / boot ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  try {
    await api('POST', '/api/login', { password: e.target.elements.password.value });
    err.hidden = true;
    boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

async function boot() {
  applyTheme();
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.authed) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  try { await load(); } catch (e) { toast(e.message); }
}

// Every minute: roll over at midnight, and refresh the "NOW" block (unless you're typing).
let lastToday = todayISO();
setInterval(() => {
  if (!S) return;
  if (todayISO() !== lastToday) {
    if (selDay === lastToday) selDay = todayISO();
    lastToday = todayISO();
    carriedFor = null;
    load().catch(() => {});
  } else if (tab === 'today' && !document.activeElement?.matches('input, textarea, select')) {
    render();
  }
}, 60000);

boot();
