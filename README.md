# News30

AI-condensed news in 30 seconds — pre-alpha web build. YouTube-parity dark UI, vertical story player, AI summaries with a tune menu, per-story quizzes with points and streaks, bias + fact-check tags on every story, Google sign-in flow with email capture, and infinite scroll into a dated archive. Fully responsive (desktop and iPhone).

## Run locally

```bash
npm install
npm run dev
```

Open the printed localhost URL. `npm run build` produces the production bundle in `dist/`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project → Import** the repo.
3. Vercel auto-detects Vite. Keep the defaults (build `npm run build`, output `dist`) and hit **Deploy**.

Nothing else is required — the app uses hash-based deep links (`/#/story/<id>`), so no rewrite rules are needed.

### Optional: live AI answers

Without a key, every AI feature (Ask AI, story chat, Simplify) degrades gracefully to clearly-labelled sample responses — the UI never breaks.

To switch on live answers, add an environment variable in Vercel → Project → **Settings → Environment Variables**:

```
VITE_ANTHROPIC_API_KEY = sk-ant-...
```

then redeploy. For local dev, put the same line in a `.env.local` file (already git-ignored).

**Security note:** a `VITE_*` variable is bundled into the client — anyone can extract it. Fine for private testing; before a public launch, proxy the call in `callClaude()` (src/App.jsx) through your own backend so the key never ships to browsers.

## Connection points

Search `src/App.jsx` for the 🔌 marker. Everything external is isolated in `CONFIG` and a small service layer at the top of the file:

| 🔌 | What | Where |
| --- | --- | --- |
| AI API | Ask AI, Summary chat, Simplify | `CONFIG.AI` + `callClaude()` |
| Google OAuth | Real sign-in (mock chooser until then) | `CONFIG.GOOGLE_OAUTH` + `GoogleModal` |
| Email capture | Mailchimp / Resend re-engagement flows | `CONFIG.EMAIL` + `emailService` |
| News data | NewsAPI-shaped story objects | `CONFIG.NEWS_API` + data layer |
| Database | Supabase / Firebase writes for tracking | `CONFIG.DATABASE` + `db` service |

All user activity (watches, likes, saves, quiz answers, login streaks) flows through one reducer + tracking store, so wiring a real database means editing the `db` service only.

## Project structure

```
news30/
├── index.html          Vite entry
├── package.json
├── vite.config.js
└── src/
    ├── main.jsx        React mount
    └── App.jsx         The entire app (UI, data, services, styles)
```

## Live data (NewsAPI + Supabase)

Both integrations follow the same rule as Google OAuth: **configured → live, unconfigured or failing → sample/local fallback.** The app never breaks on a missing key.

| Env variable | Enables |
| --- | --- |
| `VITE_NEWSAPI_KEY` | Real top headlines (Geopolitics ← general, Finance ← business, Sports ← sports) mapped onto the app's story shape |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | Persistent quiz results, login streaks, likes, saves and video engagement per Google account |

**NewsAPI caveat:** the free Developer tier only permits browser requests from `localhost`. On your deployed domain the request will fail (the app quietly falls back to samples) until you either upgrade the plan or proxy the call through a serverless function — the fetch lives in `newsService.load()`.

**Supabase setup:** run this once in Supabase → SQL editor:

```sql
create table if not exists user_state (
  user_email text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists events (
  id bigint generated always as identity primary key,
  user_email text,
  event text not null,
  payload jsonb,
  at timestamptz default now()
);
```

How persistence works: on Google sign-in the app loads `user_state` for that email and hydrates the local store, then recomputes the login streak; every subsequent change is upserted back (debounced 800 ms), and each engagement action also appends to `events`. Guests stay local-only by design.

**Security note (pre-alpha):** with only the anon key and open tables, anyone could write rows. Fine for testing — before launch, move to Supabase Auth (verify the Google ID token server-side) and add per-user RLS policies.
