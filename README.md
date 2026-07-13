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
