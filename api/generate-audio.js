// /api/generate-audio.js
// 🔌 STEP 2 OF THE VIDEO PIPELINE — produces the script (optionally) and
// turns it into narration audio. Server-side only, so FISH_API_KEY,
// DEEPSEEK_API_KEY and the Supabase service_role key stay out of the
// browser.
//
// Switched to DeepSeek after Gemini's suspension went unanswered for
// over a week and Claude proved too expensive for this project's
// £50/month ceiling. This task — a 70-word script, three search phrases
// and three quiz questions — doesn't need frontier-model reasoning,
// which is what makes DeepSeek's price point a good fit here specifically.
//
// Flow: create a video_jobs row -> (optionally generate the script via
// DeepSeek) -> call Fish Audio TTS -> upload the MP3 to Supabase
// Storage -> save the public URL back onto the job row -> return it.
//
// ─── WHY IMAGE QUERIES COME FROM HERE, NOT THE KEYWORD MAP ───────────
// generate-video.js has a hardcoded keyword map for picking stock photo
// search terms, but it can only recognise vocabulary it was written
// for — headlines like "Israel and Hamas agree ceasefire framework"
// score zero triggers and fall through to generic photos.
//
// So this endpoint asks DeepSeek for the script AND three stock-photo
// search phrases in the SAME call — no extra API round-trip, which
// matters against Vercel's 60s function limit. The phrases are stored
// on the job row and read directly by generate-video.js. The keyword
// map stays there as a fallback for when this returns nothing usable.
//
// ─── WHY QUIZ QUESTIONS COME FROM HERE TOO ───────────────────────────
// Same argument, same call. The front end's fallback generator can only
// ask about metadata already visible on the card — which outlet ran the
// story, which category it sits in — so a user could score full marks
// without watching. Questions written from the script test whether the
// video actually landed. Riding along in the existing request keeps
// this effectively free: one call produces narration, visuals and
// comprehension.
//
// Setup in Vercel → Settings → Environment Variables:
//   FISH_API_KEY, FISH_VOICE_ID, SUPABASE_SERVICE_ROLE_KEY,
//   DEEPSEEK_API_KEY
// Reuses VITE_SUPABASE_URL (just the project URL, not a secret).
//
// Requires: alter table video_jobs add column if not exists quiz jsonb;

import { createClient } from "@supabase/supabase-js";
import { enforceRateLimit } from "./_rate-limit.js";

const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
// Raised from 700: the response now carries three questions with four
// options each on top of the script, and a truncated response fails the
// JSON parse outright rather than degrading gracefully.
const MAX_TOKENS = 1400;

const ALLOWED_ORIGINS = [
  "https://news30.live",
  "https://www.news30.live",
  "http://localhost:5173",
];

// Used if DeepSeek returns nothing usable — generate-video.js then
// falls back to its own keyword map, which is the pre-existing behaviour.
const EMPTY_QUERIES = [];

const SCRIPT_PROMPT = `You write short vertical news videos.

Return ONLY valid JSON. No markdown fences, no preamble, no trailing text.
Exact shape:
{"script":"...","imageQueries":["...","...","..."],"quiz":[{"q":"...","opts":["...","...","...","..."],"correct":0}]}

script: 65-75 words of spoken narration for a 30-second vertical news
video, based on the headline below. Plain spoken sentences only — no
headings, no bullet points, no stage directions, no speaker labels.
Open with the news itself. Write numbers as words where it reads more
naturally aloud ("four point two five percent", not "4.25%"), since
this text is sent straight to a text-to-speech engine. Only narrate
what is stated in the headline — do not invent specific facts, figures,
or outcomes that are not given to you.

imageQueries: exactly 3 stock-photo search phrases that visually
represent this story on Pexels. Rules:
- 2 to 4 words each.
- GENERIC and PHOTOGRAPHABLE. Stock libraries hold no photos of
  specific named events, named people, or specific buildings. Convert
  the subject into a visual concept instead.
- The 3 phrases must be visually DIFFERENT from each other, so the
  finished video does not show three near-identical shots.
- No proper nouns. No dates. No numbers.

quiz: exactly 3 multiple-choice questions testing whether someone
actually took in the script you just wrote. Rules:
- Every question must be answerable from the script alone. Do not ask
  about anything the script does not state.
- Ask about substance: what happened, to whom, what figure was given,
  what happens next. NEVER ask which outlet reported it, what category
  it belongs to, or what the headline was — those test the interface,
  not the news, and can be answered without watching.
- Exactly 4 options each. All four must be plausible to someone who
  half-watched: same type of thing, same rough magnitude. An option
  that is obviously absurd gives the answer away for free.
- "correct" is the 0-based index of the right option.
- Vary which index is correct across the three questions.

Example for the headline "Israel and Hamas agree ceasefire framework":
{"script":"...","imageQueries":["diplomatic negotiation table","united nations flags","handshake formal meeting"],"quiz":[{"q":"What have the two sides agreed to?","opts":["A ceasefire framework","A prisoner exchange","A permanent peace treaty","A redrawing of the border"],"correct":0},{"q":"What stage has the agreement reached?","opts":["Fully ratified","A framework, not yet final","Rejected by both sides","Awaiting a public vote"],"correct":1},{"q":"Who is described as involved?","opts":["Israel and Hamas","Israel and Egypt","Hamas and Jordan","Egypt and Qatar"],"correct":0}]}

Example for the headline "Norway's sovereign wealth fund posts record returns":
{"script":"...","imageQueries":["financial district skyline","stock chart screen","bank vault interior"],"quiz":[{"q":"What did the fund report?","opts":["Its first annual loss","A change of leadership","Record returns","A new ethical mandate"],"correct":2},{"q":"Which country's fund is this?","opts":["Sweden","Norway","Denmark","Finland"],"correct":1},{"q":"How do the returns compare with previous years?","opts":["The highest on record","Roughly average","Slightly down","The worst in a decade"],"correct":0}]}`;

// DeepSeek's JSON mode (response_format) makes malformed output less
// likely than plain prompting, but still parse defensively — a failure
// in the extras should cost us the extras, not the whole render.
function parseScriptResponse(raw) {
  if (!raw) return null;

  let cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  cleaned = cleaned.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed.script !== "string" || !parsed.script.trim()) return null;

  const queries = Array.isArray(parsed.imageQueries)
    ? parsed.imageQueries
        .filter((q) => typeof q === "string" && q.trim().length > 1)
        .map((q) => q.trim().toLowerCase())
        .filter((q, i, arr) => arr.indexOf(q) === i) // drop duplicates
        .slice(0, 3)
    : EMPTY_QUERIES;

  // Validate every question rather than trusting the shape. A question
  // with three options, or a `correct` index pointing past the end of
  // the array, would render as a broken quiz in the player — better to
  // drop it here and let the front end fall back to its own questions.
  const quiz = Array.isArray(parsed.quiz)
    ? parsed.quiz
        .filter((item) =>
          item &&
          typeof item.q === "string" && item.q.trim().length > 5 &&
          Array.isArray(item.opts) && item.opts.length === 4 &&
          item.opts.every((o) => typeof o === "string" && o.trim()) &&
          Number.isInteger(item.correct) && item.correct >= 0 && item.correct < 4
        )
        .map((item) => ({
          q: item.q.trim(),
          opts: item.opts.map((o) => o.trim()),
          correct: item.correct,
        }))
        .slice(0, 3)
    : [];

  return { script: parsed.script.trim(), imageQueries: queries, quiz };
}

async function generateScript(headline, category, apiKey) {
  const prompt =
    SCRIPT_PROMPT +
    "\n\nHeadline: " + headline +
    "\nCategory: " + (category || "news");

  const upstream = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey, // header, never a query string
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: MAX_TOKENS,
      // Forces the model to emit a JSON object — the prompt still has
      // to specify the shape, but this cuts down on stray prose around
      // the JSON that the defensive parser would otherwise have to strip.
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    // Logged, never returned — upstream error payloads can echo request
    // context back.
    console.error("[generate-audio] DeepSeek error", upstream.status, JSON.stringify(data));
    throw new Error("Script generation failed (" + upstream.status + ")");
  }

  const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();

  const parsed = parseScriptResponse(raw);
  if (!parsed) {
    console.error("[generate-audio] could not parse DeepSeek response:", raw.slice(0, 400));
    throw new Error("Script generation returned an unusable response");
  }

  if (!parsed.imageQueries.length) {
    console.warn("[generate-audio] DeepSeek returned no usable imageQueries; falling back to keyword map");
  }
  if (!parsed.quiz.length) {
    console.warn("[generate-audio] DeepSeek returned no usable quiz; front end will fall back to generated questions");
  }

  return parsed;
}

export default async function handler(req, res) {
  /* This endpoint spends money on every call — DeepSeek, then Fish Audio
     narration billed per character — and it's the entry point to the
     whole render chain. It used to be reachable by anyone who found the
     URL, which meant one person with curl could drain the month's budget
     in an afternoon.

     Two callers are legitimate. process.js sends x-pipeline-secret (the
     same header that bypasses the rate limit further down), and anything
     calling in from outside the pipeline would use a bearer token. Accept
     either, reject everything else. */
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[generate-audio] CRON_SECRET not configured — refusing to run");
    res.status(500).json({ error: "Not configured" });
    return;
  }
  const pipelineSecret = process.env.PIPELINE_SECRET || secret;
  const bearerOk = req.headers.authorization === "Bearer " + secret;
  const pipelineOk =
    req.headers["x-pipeline-secret"] === secret ||
    req.headers["x-pipeline-secret"] === pipelineSecret;
  if (!bearerOk && !pipelineOk) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  // Kill switch — set PIPELINE_ENABLED=false in Vercel to stop all
  // generation instantly, no redeploy needed.
  if (process.env.PIPELINE_ENABLED === "false") {
    res.status(503).json({ error: "Pipeline is currently disabled" });
    return;
  }

  // Much tighter than ask-ai: every call spends DeepSeek AND Fish Audio
  // credits, and narration is billed per character. The pipeline worker
  // bypasses this via x-pipeline-secret — see _rate-limit.js.
  if (!(await enforceRateLimit(req, res, "generate-audio", 5, 60))) return;

  // Two accepted call shapes:
  //   { storyId, script }                  — script supplied (test harness)
  //   { storyId, headline, category }      — generate script + queries + quiz
  // Passing a script explicitly always wins, so the test page keeps
  // working exactly as before and stays useful for isolating TTS issues
  // without spending an AI call. Note that path produces no quiz — there
  // is no generated script for the model to write questions from.
  const { storyId, script: providedScript, headline, category, imageQueries: providedQueries } = req.body || {};

  if (!storyId) {
    res.status(400).json({ error: "storyId is required" });
    return;
  }
  if (!providedScript && !headline) {
    res.status(400).json({ error: "Either script or headline is required" });
    return;
  }

  const fishKey = process.env.FISH_API_KEY;
  const voiceId = process.env.FISH_VOICE_ID;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  if (!fishKey || !voiceId || !supabaseUrl || !serviceKey) {
    console.error("[generate-audio] missing config", {
      FISH_API_KEY: !!fishKey,
      FISH_VOICE_ID: !!voiceId,
      VITE_SUPABASE_URL: !!supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: !!serviceKey,
    });
    res.status(500).json({ error: "Server is not configured for audio generation" });
    return;
  }
  if (!providedScript && !deepseekKey) {
    console.error("[generate-audio] DEEPSEEK_API_KEY missing but script generation was requested");
    res.status(500).json({ error: "Server is not configured for script generation" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Create the job row up front so there's a record even if a later step fails.
  const { data: job, error: insertErr } = await supabase
    .from("video_jobs")
    .insert({ story_id: storyId, status: "generating_script" })
    .select()
    .single();

  if (insertErr) {
    console.error("[generate-audio] job insert failed:", insertErr);
    res.status(500).json({ error: "Failed to create job" });
    return;
  }

  try {
    // 1) Script + image queries + quiz.
    let script = providedScript;
    let imageQueries = Array.isArray(providedQueries) ? providedQueries.slice(0, 3) : [];
    let quiz = [];

    if (!script) {
      const generated = await generateScript(headline, category, deepseekKey);
      script = generated.script;
      if (!imageQueries.length) imageQueries = generated.imageQueries;
      quiz = generated.quiz;
    }

    // Persist all three before TTS — if narration fails, the script,
    // queries and questions survive on the row and the job can be
    // retried cheaply without paying for another AI call.
    await supabase
      .from("video_jobs")
      .update({
        script,
        image_queries: imageQueries.length ? imageQueries : null,
        quiz: quiz.length ? quiz : null,
        status: "generating_audio",
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    // 2) Fish Audio TTS — returns raw MP3 bytes in the response body.
    const ttsRes = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + fishKey,
        "Content-Type": "application/json",
        model: "s2.1-pro-free", // 🔌 Free under fair use through end of July 2026 — switch to "s2-pro" before real launch (no uptime/latency guarantee on the free tier).
      },
      body: JSON.stringify({
        text: script,
        reference_id: voiceId,
        format: "mp3",
      }),
    });

    if (!ttsRes.ok) {
      const detail = await ttsRes.text().catch(() => "");
      console.error("[generate-audio] Fish Audio failed:", ttsRes.status, detail.slice(0, 400));
      throw new Error("Narration failed (" + ttsRes.status + ")");
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());

    // 3) Upload the MP3 to the public "media" bucket.
    const filePath = "narration/" + job.id + ".mp3";
    const { error: uploadErr } = await supabase.storage
      .from("media")
      .upload(filePath, audioBuffer, { contentType: "audio/mpeg", upsert: true });

    if (uploadErr) {
      console.error("[generate-audio] storage upload failed:", uploadErr);
      throw new Error("Storage upload failed");
    }

    // 4) Public URL — bucket is public, so this link is stable.
    const { data: publicUrlData } = supabase.storage.from("media").getPublicUrl(filePath);
    const audioUrl = publicUrlData.publicUrl;

    // 5) Ready for video assembly.
    await supabase
      .from("video_jobs")
      .update({ status: "audio_ready", audio_url: audioUrl, updated_at: new Date().toISOString() })
      .eq("id", job.id);

    res.status(200).json({ jobId: job.id, audioUrl, script, imageQueries, quiz });
  } catch (e) {
    console.error("[generate-audio] failed:", e);
    await supabase
      .from("video_jobs")
      .update({ status: "failed", error: String(e).slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", job.id);

    res.status(500).json({ error: e.message || "Audio generation failed", jobId: job.id });
  }
}
