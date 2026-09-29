const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. See README.md.');
  process.exit(1);
}

// Railway's private network (*.railway.internal) and localhost don't use SSL;
// public proxy URLs do.
const needsSsl = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id          SERIAL PRIMARY KEY,
  text        TEXT NOT NULL,
  days        INT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  sort        INT NOT NULL DEFAULT 0,
  created_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  archived_on DATE
);
CREATE TABLE IF NOT EXISTS checks (
  day     DATE NOT NULL,
  rule_id INT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  PRIMARY KEY (day, rule_id)
);
CREATE TABLE IF NOT EXISTS days (
  day     DATE PRIMARY KEY,
  minimum BOOLEAN NOT NULL DEFAULT FALSE,
  hours   NUMERIC,
  note    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS goals (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'other',
  horizon      TEXT NOT NULL DEFAULT 'short',
  kind         TEXT NOT NULL DEFAULT 'checklist' CHECK (kind IN ('number','checklist','binary')),
  unit         TEXT NOT NULL DEFAULT '',
  start_value  NUMERIC,
  target_value NUMERIC,
  start_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date     DATE NOT NULL,
  done_on      DATE,
  why          TEXT NOT NULL DEFAULT '',
  sort         INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS goal_logs (
  id      SERIAL PRIMARY KEY,
  goal_id INT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  value   NUMERIC NOT NULL
);
CREATE TABLE IF NOT EXISTS goal_items (
  id      SERIAL PRIMARY KEY,
  goal_id INT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  text    TEXT NOT NULL,
  done_on DATE,
  sort    INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS todos (
  id   SERIAL PRIMARY KEY,
  day  DATE NOT NULL,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS todos_day_idx ON todos(day);
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_horizon_check;
ALTER TABLE goals ADD CONSTRAINT goals_horizon_check CHECK (horizon IN ('short','mid','long'));
CREATE INDEX IF NOT EXISTS goal_logs_goal_idx ON goal_logs(goal_id, day);
-- v2: automation
ALTER TABLE rules  ADD COLUMN IF NOT EXISTS metric    TEXT;
ALTER TABLE rules  ADD COLUMN IF NOT EXISTS min_value NUMERIC;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS skip      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE days   ADD COLUMN IF NOT EXISTS dsa       INT NOT NULL DEFAULT 0;
ALTER TABLE days   ADD COLUMN IF NOT EXISTS pyq       INT NOT NULL DEFAULT 0;
ALTER TABLE goals  ADD COLUMN IF NOT EXISTS auto      TEXT;
`;

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates,
// so no timezone shifting happens between server and browser.
require('pg').types.setTypeParser(1082, (v) => v);
// NUMERIC -> JS number
require('pg').types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Weekly template: "Day HH:MM-HH:MM type label". Types: class, assign, gym, dsa, gate, walk, free.
const DEFAULT_SCHEDULE = `
Mon 10:30-11:30 class AISD lecture
Mon 11:30-12:30 class MLS / OS
Mon 12:30-14:30 assign Lunch + 1h assignment
Mon 14:30-15:30 class CSD
Mon 15:30-17:30 class NLP Lab
Mon 18:00-19:00 gym Gym
Mon 21:00-22:00 dsa DSA block
Mon 22:15-23:30 gate GATE deep work
Tue 09:30-10:30 class Electrodynamics / Power Electronics
Tue 10:30-13:30 assign Main assignment block
Tue 14:30-16:30 class AISD Lab
Tue 16:30-17:30 class NLP
Tue 18:00-19:00 gym Gym
Tue 21:00-22:00 dsa DSA block
Tue 22:15-23:30 gate GATE deep work
Wed 08:30-09:30 class MLS / OS
Wed 10:30-11:30 class Electrodynamics / Power Electronics
Wed 11:30-13:00 assign Assignment block
Wed 14:30-15:30 class CSD
Wed 15:30-16:30 gate GATE PYQ sprint
Wed 16:30-17:30 class NLP
Wed 18:00-19:00 gym Gym
Wed 21:00-22:00 dsa DSA block
Wed 22:15-23:30 gate GATE deep work
Thu 11:30-12:30 class MLS / OS
Thu 13:30-15:30 class AISD Lab
Thu 15:30-17:30 assign Assignment block
Thu 17:30-18:30 class NLP
Thu 19:00-19:45 walk 45-min walk
Thu 21:00-22:00 dsa DSA block
Thu 22:15-23:30 gate GATE deep work
Fri 10:30-11:30 class Electrodynamics / Power Electronics
Fri 11:30-13:30 assign Finish the week's assignments
Fri 14:30-17:30 class CSD + CSD Lab
Fri 18:00-19:00 gym Gym
Fri 21:00-22:00 dsa DSA block
Fri 22:15-23:30 gate Mistake log + light revision
Sat 09:00-10:15 gym Gym
Sat 10:30-13:30 gate GATE-only subject (TOC / COA / Compilers / Digital Logic)
Sat 15:00-17:00 assign Assignments
Sat 21:00-22:00 dsa DSA block
Sun 08:00-09:30 dsa LeetCode weekly contest
Sun 10:00-11:00 dsa Upsolve contest problems
Sun 11:00-13:00 gate GATE PYQ test
Sun 18:00-18:45 walk 45-min walk
Sun 21:00-21:30 free Weekly review + plan next week
`.trim();

async function ensureDefaults(client) {
  await client.query(
    `INSERT INTO settings (key, value) VALUES ('schedule', $1), ('minimum', $2)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_SCHEDULE), JSON.stringify({ dsa: 1, pyq: 20 })]);
}

async function seed(client) {
  const { rowCount } = await client.query("SELECT 1 FROM settings WHERE key = 'challenge'");
  if (rowCount) return;

  const start = process.env.SEED_START_DATE || new Date().toISOString().slice(0, 10);
  await client.query('INSERT INTO settings (key, value) VALUES ($1, $2), ($3, $4)', [
    'challenge',
    JSON.stringify({ name: '150-Day Level-Up: Placement → GATE → Shredded', start, end: addDays(start, 149) }),
    'commandments',
    JSON.stringify([
      'Never miss two days in a row. One miss is an accident, two is a new habit.',
      'Bad day = minimum day: 1 DSA problem + 20 GATE PYQs. The app counts it automatically. No zero days.',
      'Solve before you watch. PYQs and problems first, lectures only to fill gaps.',
      'Every wrong answer goes in the mistake log, and the log gets re-read every Friday.',
      'Assignments live in daytime gaps. The 9–11:30 PM block belongs to DSA and GATE.',
      'Train like it matters: progressive overload, and log every session.',
      'Protein every day, junk food at most once a week.',
      'Phone in another room during deep work. Social media only after 10 PM targets are done.',
      'Sunday = contest + weekly review + plan. Adjust the plan; never abandon it.',
      'Apply before you feel ready. Rejections are data.',
      'Log honestly. A red day you admit is worth more than a green day you faked.',
    ]),
  ]);

  const all = [0, 1, 2, 3, 4, 5, 6];
  const weekdays = [1, 2, 3, 4, 5];
  const rules = [
    ['Up by 7:00 (no snooze)', all],
    ['DSA: 3 problems, at least 1 medium (C++)', weekdays, 'dsa', 3],
    ['LeetCode contest + upsolve', [0]],
    ['GATE deep-work block: 2 hours', all],
    ['20+ GATE PYQs, mistakes logged', all, 'pyq', 20],
    ['Gym: log every set', [1, 2, 3, 5, 6]],
    ['10k steps / 45-min walk (rest day)', [0, 4]],
    ['Protein target hit (~1.6 g per kg body weight)', all],
    ['3 L water, no junk food', all],
    ['Re-read mistake log (10 min)', all],
    ['Social media under 45 min', all],
    ['Asleep by 12:00', all],
  ];
  const ruleId = {};
  for (let i = 0; i < rules.length; i++) {
    const [text, days, metric = null, min = null] = rules[i];
    const { rows } = await client.query(
      'INSERT INTO rules (text, days, sort, created_on, metric, min_value) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [text, days, i, start, metric, min]);
    ruleId[text] = rows[0].id;
  }
  const GYM = 'rule:' + ruleId['Gym: log every set'];
  const CONTEST = 'rule:' + ruleId['LeetCode contest + upsolve'];

  // [title, category, horizon, kind, unit, startValue, target, days, why, items, auto?]
  const goals = [
    // ---- short-term: next 30 days ----
    ['Resume v1 shipped and reviewed', 'career', 'short', 'checklist', '', null, null, 10,
      'A resume that sits in drafts gets zero interviews.', [
        'One-page draft (Overleaf / LaTeX)', 'Every project bullet has a number (latency, users, %)',
        'Reviewed by senior #1', 'Reviewed by senior #2', 'Uploaded to CDPC + LinkedIn updated']],
    ['75 DSA problems in 30 days', 'dsa', 'short', 'number', 'problems', 0, 75, 30,
      'Arrays, strings, hashing, two pointers, binary search, stacks, linked lists.', [], 'dsa'],
    ['GATE OS: syllabus + 150 PYQs in 21 days', 'gate', 'short', 'checklist', '', null, null, 21, '', [
      'Processes, threads, system calls', 'CPU scheduling (all numericals)', 'Synchronization & semaphores',
      'Deadlocks (banker\'s algorithm)', 'Memory management & paging', 'Virtual memory & page replacement',
      'File systems & disk scheduling', '150 OS PYQs solved', 'OS subject test score ≥ 70%']],
    ['Ship backend project v1 (deployed)', 'career', 'short', 'checklist', '', null, null, 30,
      'One real project you can defend for 30 minutes in an interview.', [
        'Pick it: URL shortener + rate limiter + analytics', 'REST API + PostgreSQL schema',
        'Redis caching', 'Auth (JWT)', 'Dockerized', 'Deployed with a public URL',
        'README with architecture diagram + load-test numbers']],
    ['30-day no-miss streak', 'habit', 'short', 'number', 'days', 0, 30, 30,
      'Full or minimum day, every day, for 30 days.', [], 'streak'],
    ['18 gym sessions in 30 days', 'fitness', 'short', 'number', 'sessions', 0, 18, 30, '', [], GYM],
    ['25 alumni / referral messages', 'career', 'short', 'number', 'messages', 0, 25, 30,
      'Short, specific, resume attached. Referrals beat cold applications.', []],
    ['4 LeetCode weekly contests', 'dsa', 'short', 'number', 'contests', 0, 4, 28, '', [], CONTEST],

    // ---- mid-term: by ~90 days ----
    ['Offer letter: SDE / backend role', 'career', 'mid', 'checklist', '', null, null, 93,
      'Placement season happens once. This is the #1 priority until December.', [
        'Resume shortlisted by 10+ companies', 'Clear 5 online assessments',
        '5 mock interviews (2 with seniors)', '10 LLD problems practiced (parking lot, BookMyShow, …)',
        'CS fundamentals sheet done (OS / DBMS / CN / OOP)', '60 applications + referrals in total',
        'Reach the final round at 3 companies', 'Offer letter in hand']],
    ['300 DSA problems (120+ medium/hard)', 'dsa', 'mid', 'number', 'problems', 0, 300, 90,
      'Trees, graphs, DP and heaps are where interviews are won.', [], 'dsa'],
    ['LeetCode contest rating 1750+', 'dsa', 'mid', 'number', 'rating', null, 1750, 90,
      'Set your current rating as the start value via Edit.', []],
    ['GATE core CS: first pass + PYQs', 'gate', 'mid', 'checklist', '', null, null, 90, '', [
      'Operating Systems + PYQs', 'DBMS + PYQs', 'Computer Networks + PYQs', 'Algorithms + PYQs',
      'Programming & Data Structures + PYQs', 'Theory of Computation + PYQs', 'COA + PYQs',
      'Digital Logic + PYQs', 'Compiler Design + PYQs', 'Discrete Mathematics + PYQs']],
    ['Body fat down to 18%', 'fitness', 'mid', 'number', '%', null, 18, 90,
      'Set your real starting body fat via Edit. Measure same scale, same time, weekly.', []],
    ['400 focused study hours', 'habit', 'mid', 'number', 'hours', 0, 400, 90,
      '≈ 4.5 hours a day. Counted from the hours you tap in each day.', [], 'hours'],
    ['Semester SGPA 8.5+', 'academics', 'mid', 'number', 'SGPA', null, 8.5, 90,
      'Assignments on time, no all-nighters. CGPA cutoffs still filter resumes.', []],

    // ---- long-term: GATE and beyond ----
    ['GATE 2027: 700+ score / AIR under 1000', 'gate', 'long', 'checklist', '', null, null, 130,
      'Opens IISc / IIT M.Tech and PSU options. A real plan B, or a plan A. Set the end date to the exam day.', [
        'Engineering Math + General Aptitude done', 'Full syllabus revision #1', 'All PYQs (2000–2026) solved',
        'Full syllabus revision #2 with short notes', '20 full-length mocks', 'Mock average ≥ 65 marks',
        'Exam day: slept 7 hours, calm, no new topics in the last 3 days']],
    ['15% body fat', 'fitness', 'long', 'number', '%', null, 15, 180,
      'Set your real starting body fat via Edit.', []],
    ['Visible abs', 'fitness', 'long', 'checklist', '', null, null, 180,
      'Progress photo on the 1st of every month: same light, same time.', [
        'Body fat under 20%', 'Body fat under 18%', 'Body fat under 16%', 'Body fat at 15%',
        'Abs visible in a progress photo']],
    ['Strength standards', 'fitness', 'long', 'checklist', '', null, null, 180, '', [
      'Bench press 1× bodyweight', 'Squat 1.5× bodyweight', 'Deadlift 2× bodyweight',
      '10 strict pull-ups', 'Overhead press 0.66× bodyweight']],
    ['600 DSA problems', 'dsa', 'long', 'number', 'problems', 0, 600, 180, '', [], 'dsa'],
    ['Engineer portfolio', 'career', 'long', 'checklist', '', null, null, 180,
      'Proof you can build, not just solve.', [
        'Backend project #1 deployed', 'Backend project #2 deployed (different stack / problem)',
        'One merged open-source PR', 'System design notes: 10 classic designs',
        'Personal site with projects + resume']],
  ];
  for (let i = 0; i < goals.length; i++) {
    const [title, category, horizon, kind, unit, sv, tv, days, why, items, auto = null] = goals[i];
    const { rows } = await client.query(
      `INSERT INTO goals (title, category, horizon, kind, unit, start_value, target_value,
         start_date, end_date, why, sort, auto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [title, category, horizon, kind, unit, sv, tv, start, addDays(start, days), why, i, auto]);
    for (let j = 0; j < items.length; j++) {
      await client.query('INSERT INTO goal_items (goal_id, text, sort) VALUES ($1, $2, $3)',
        [rows[0].id, items[j], j]);
    }
  }
}

async function init() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await seed(client);
    await ensureDefaults(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
