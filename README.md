# Level-Up Challenge Tracker

A personal challenge tracker for your phone and laptop, built so you type as little as possible.

**What you do each day (about 1 minute):** tap **+1** on DSA problems / PYQs / study hours as you go, tick the few manual rules (wake-up, gym, protein, sleep…), and optionally add an extra target.

**What the app does by itself:**
- **Daily plan from your timetable**: classes, assignment gaps, gym and study blocks, with the current block marked **NOW**.
- **Auto targets**: today's DSA count comes from the pace your DSA goals need; today's GATE topic is the next unfinished topic on your active GATE goal.
- **Auto-ticked rules**: "3 DSA problems" and "20 PYQs" tick themselves when the counters reach the number.
- **Minimum days**: 1 DSA + 20 PYQs makes the day count for your streak automatically.
- **⚡ Goals that fill themselves**: DSA totals, gym sessions (from gym ticks), contests, study hours, and the no-miss streak.
- **Unfinished targets** move to today automatically.
- **Coach**: weak spots from your last 7 days, goals that are behind schedule, and goals that still need a starting value.
- **Calendar heatmap**, streaks, % of days kept, and "two misses in a row" alerts.

**Room for change:**
- Edit the weekly timetable as plain text in Setup.
- **Skip** a rule for one day (injury, travel).
- **Light day** mode for exams or sickness: targets drop to the minimum and the day still counts.
- Change rule weekdays, auto-tick thresholds, minimum-day criteria, and every goal (dates, targets, what it auto-counts from).
- Password login, dark mode, JSON backup.

Data is stored in **PostgreSQL**, so it persists across deploys and restarts.

---

## Deploy on Railway (about 10 minutes)

### 1. Put the code on GitHub
```bash
cd ~/Documents/challenge-tracker
git add .
git commit -m "Challenge tracker"
# Create an empty PRIVATE repo on github.com (e.g. challenge-tracker), then:
git remote add origin https://github.com/<your-username>/challenge-tracker.git
git branch -M main
git push -u origin main
```

### 2. Create the Railway project
1. Go to <https://railway.com> and log in with GitHub.
2. **New Project → Deploy from GitHub repo →** pick `challenge-tracker`.
   Railway detects Node.js, runs `npm install`, then `npm start`.
   The first deploy will crash with `DATABASE_URL is not set`. That's expected; the next steps fix it.

### 3. Add the database
1. In the project canvas: **+ Create → Database → Add PostgreSQL**.
2. Click your **app service → Variables → New Variable** and add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (type it exactly like this; Railway fills it in) |
| `APP_PASSWORD` | a password you'll use to log in |
| `SESSION_SECRET` | any long random string (run `openssl rand -hex 32` to make one) |

3. Railway redeploys automatically. On first start the app creates its tables and fills in the starter challenge, rules and goals.

### 4. Get a public URL
**App service → Settings → Networking → Generate Domain.** You'll get something like
`https://challenge-tracker-production.up.railway.app`. Open it, log in, and done.

On your phone, open the URL and use **"Add to Home Screen"** so it opens like an app.

### Updating later
Any `git push` to `main` redeploys automatically. Your data stays in Postgres and isn't touched by redeploys.

### Cost note
Railway's free trial gives one-time credits. After that the Hobby plan is about $5/month, and this app plus a small Postgres fits within it. Check Railway's pricing page for current details.

---

## Run locally (optional)

```bash
# Postgres in Docker
docker run -d --name challenge-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=challenge -p 55440:5432 postgres:16-alpine

npm install
DATABASE_URL=postgres://postgres:dev@localhost:55440/challenge APP_PASSWORD=test SESSION_SECRET=dev npm start
# open http://localhost:3000
```

If `APP_PASSWORD` is not set, the app runs without a login (fine locally, **never** on Railway).

---

## Customising

Everything is editable in the app:
- **Setup tab**: challenge name, start date, number of days, daily rules and their weekdays, and the "rules of this challenge" list.
- **Goals tab**: add, edit or delete goals. Set your real starting body fat on the "Reach 15% body fat" goal via **Edit**.

The starter content only gets inserted once, into an empty database (see `seed()` in `db.js`). To start the challenge on a specific date, set `SEED_START_DATE=2026-10-01` before the first deploy, or just change the start date in Setup afterwards.

## Backups
**Setup → Download backup (JSON)** exports every table. Railway also has volume backups for Postgres on paid plans.
