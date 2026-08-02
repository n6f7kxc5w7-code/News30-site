# News30

AI-condensed news in 30 seconds — pre-alpha web build. YouTube-parity dark UI, vertical story player, AI summaries with a tune menu, per-story quizzes with points and streaks, bias + fact-check tags on every story, Google sign-in with email capture, and infinite scroll into a dated archive. Fully responsive (desktop and iPhone).

Also includes an automated short-form video pipeline: script → narration → stock footage → rendered vertical MP4.

---

## Run locally

```bash
npm install
npm run dev
```

Open the printed localhost URL. `npm run build` produces the production bundle in `dist/`.

---

## ⚠️ Read this before adding any API key

**Vite compiles every `VITE_`-prefixed environment variable directly into the public JavaScript bundle at build time.** Anyone who visits the deployed site can open dev tools and read it. This is not a theoretical risk — it is exactly how this project's Gemini key was harvested by an automated scanner in July 2026, resulting in unauthorised API usage and a full Google Cloud project suspension.

The rule, with no exceptions:

| Kind of value | Prefix | Where it lives |
| --- | --- | --- |
| Secret (any API key, any token) | **never** `VITE_` | Server-side env var, read by a function in `api/` |
| Public by design (project URLs, OAuth client IDs, Supabase anon key) | `VITE_` is fine | Client bundle |

"It's only for private testing" is not a safe exemption. A deployed Vercel preview is a public URL, and scanners find them.

---

## Architecture

Every third-party call that requires a secret goes through a Vercel serverless function in `api/`. The browser only ever talks to our own domain.

```
browser  →  /api/ask-ai          →  Gemini
         →  /api/news            →  NewsAPI
         →  /api/generate-audio  →  Gemini (script) + Fish Audio (TTS)
         →  /api/generate-video  →  Pexels + FFmpeg
         →  /api/job-status      →  Supabase
```

### Environment variables

**Server-side only — no `VITE_` prefix.** Set in Vercel → Settings → Environment Variables.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | `ask-ai.js`, `generate-audio.js` | AI features and video script generation |
| `NEWSAPI_KEY` | `news.js` | Live headlines |
| `FISH_API_KEY` | `generate-audio.js` | Text-to-speech narration |
| `FISH_VOICE_ID` | `generate-audio.js` | Which voice to use |
| `PEXELS_API_KEY` | `generate-video.js` | Stock imagery |
| `SUPABASE_SERVICE_ROLE_KEY` | all pipeline functions | Backend DB/storage writes — **full access, never expose** |
| `PIPELINE_ENABLED` | `generate-audio.js`, `generate-video.js` | Kill switch. Set to `false` to halt all rendering instantly with no redeploy |

**Client-side — public by design.**

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL. Not a secret |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key. Public by design — **RLS policies are what actually protect the data** (see below) |

For local dev, put the same lines in `.env.local` (git-ignored, along with `.env` and `.env.*`).

Without `GEMINI_API_KEY`, the AI features degrade to clearly-labelled sample responses rather than breaking. Without `NEWSAPI_KEY`, the app falls back to bundled sample stories.

---

## Connection points

Search `src/App.jsx` for the 🔌 marker. Everything external is isolated in `CONFIG` and a small service layer at the top of the file.

| 🔌 | What | Where |
| --- | --- | --- |
| AI API | Ask AI, Summary chat, Simplify | `CONFIG.AI.ENDPOINT` → `/api/ask-ai` |
| Google OAuth | Sign-in via Supabase Auth | `CONFIG.GOOGLE_OAUTH` + `GoogleModal` |
| Email capture | Mailchimp / Resend (not yet built) | `CONFIG.EMAIL.ENDPOINT` → `/api/send-email` |
| News data | NewsAPI-shaped story objects | `CONFIG.NEWS_API.ENDPOINT` → `/api/news` |
| Database | Supabase reads/writes for tracking | `CONFIG.DATABASE` + `db` service |

Note that `CONFIG.AI`, `CONFIG.NEWS_API` and `CONFIG.EMAIL` hold **endpoint paths, not keys**. There is deliberately no key handling anywhere in client code.

All user activity (watches, likes, saves, quiz answers, login streaks) flows through one reducer + tracking store, so wiring a real database means editing the `db` service only.

---

## Project structure

```
news30/
├── index.html                    Vite entry
├── package.json
├── vercel.json                   Function config (incl. maxDuration)
├── vite.config.js
├── public/
│   └── test-pipeline.html        Manual pipeline test harness ⚠️ see note
├── api/                          Vercel serverless functions (server-side only)
│   ├── ask-ai.js                 Gemini proxy
│   ├── news.js                   NewsAPI proxy
│   ├── generate-audio.js         Script generation + Fish Audio TTS
│   ├── generate-video.js         Pexels + FFmpeg assembly
│   ├── job-status.js             Pipeline job polling
│   ├── video-webhook.js
│   └── LiberationSans-Bold.ttf   Bundled font — Vercel has no system fonts
└── src/
    ├── main.jsx                  React mount
    └── App.jsx                   The entire app (UI, data, services, styles)
```

⚠️ **`public/test-pipeline.html` is publicly reachable** at `/test-pipeline.html` on the deployed site. Anyone who finds that URL can trigger renders that cost real money. Delete it or put it behind a check before any public launch.

---

## Video pipeline

Three stages, tracked in the `video_jobs` table:

1. **`/api/generate-audio`** — takes a headline, asks Gemini for a 65–75 word script *and* three stock-photo search phrases in a single JSON response, then sends the script to Fish Audio and uploads the MP3 to Supabase Storage.
2. **`/api/generate-video`** — reads those search phrases, pulls a deduplicated pool of images from Pexels, and assembles a 720×1280 MP4 with a Ken Burns zoom and burned-in captions via FFmpeg.
3. **`/api/job-status`** — polling endpoint for the front end.

Calling `generate-audio` with an explicit `script` skips Gemini entirely — useful for isolating TTS or FFmpeg problems without spending a call, but it produces no image queries, so image selection falls back to a hardcoded keyword map and the results are noticeably more generic.

### Hard-won FFmpeg notes

Things confirmed by production testing that are easy to get wrong again:

- **`drawtext` is not available** in `ffmpeg-static` on Vercel ("No such filter"). Use the `subtitles` filter, which is backed by libass.
- **Vercel's serverless environment has no system fonts.** libass silently renders *nothing* rather than erroring, so the font must be bundled in the repo and passed via `fontsdir`.
- **`.srt` files position unreliably.** Use a proper `.ass` file with `PlayResX`/`PlayResY` declared to match the real output resolution.
- **With `BorderStyle=3` (opaque box), `Outline` must be nonzero** or the box silently collapses to nothing.
- **`zoompan`'s `d` parameter is output frames *per input frame*, not total.** With a looped image input that already has the right frame count, `d` must be `1` — anything else multiplies the frame count and, combined with `-shortest`, leaves the finished video showing only the first image.

---

## Supabase setup

Run once in Supabase → SQL editor:

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

create table if not exists video_jobs (
  id uuid primary key default gen_random_uuid(),
  story_id text,
  status text,
  script text,
  image_queries jsonb,
  audio_url text,
  video_url text,
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

**Row Level Security is mandatory, not optional.** The anon key is public by design — it is compiled into the client bundle and anyone can read it. RLS policies are the *only* thing standing between that key and your data. See `SECURITY.md` for the policies this project uses.

How persistence works: on sign-in the app loads `user_state` for that email and hydrates the local store, then recomputes the login streak; every subsequent change is upserted back (debounced 800 ms), and each engagement action also appends to `events`. Guests stay local-only by design.

---

## Cost control

This project has a target ceiling of roughly £50/month. The costs that can run away fastest are video rendering and TTS, both of which are triggered by endpoints rather than by user page views.

- Set hard spend caps in the Fish Audio and Pexels dashboards, and budget alerts in Google Cloud.
- `PIPELINE_ENABLED=false` halts all generation immediately without a redeploy.
- Both pipeline endpoints restrict CORS to known origins so other sites cannot spend your quota.
- `test-pipeline.html` should be removed before launch (see above).
