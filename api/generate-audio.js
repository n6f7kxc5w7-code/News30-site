// /api/generate-audio.js
// 🔌 STEP 2 OF THE VIDEO PIPELINE — produces the script (optionally) and
// turns it into narration audio. Server-side only, so FISH_API_KEY,
// GEMINI_API_KEY and the Supabase service_role key stay out of the browser.
//
// Flow: create a video_jobs row -> (optionally generate the script via
// Gemini) -> call Fish Audio TTS -> upload the MP3 to Supabase Storage
// -> save the public URL back onto the job row -> return it.
//
// ─── WHAT'S NEW: IMAGE QUERIES COME FROM GEMINI ──────────────────────
// Stock photo selection used to rely on a hardcoded keyword map in
// generate-video.js, matching trigger words in the headline. That map
// can only recognise vocabulary it was written for, so headlines like
// "Israel and Hamas agree ceasefire framework" or "Norway's sovereign
// wealth fund posts record returns" scored zero triggers and fell
// through to generic newspaper photos.
//
// Feeding the SCRIPT into that same map instead of the headline doesn't
// help — the script is written from the headline, so it uses the same
// vocabulary, and its extra length just adds more chances for a stray
// "war" or "attack" to score a bucket the story isn't about.
//
// So: Gemini now returns the script AND three stock-photo search phrases
// in a single JSON response, in the call we were already making. No
// extra API round-trip, no added latency against Vercel's 60s limit —
// which is what made the earlier "ask Gemini for keywords in step 3"
// approach untenable. The phrases are stored on the job row and read
// directly by generate-video.js.
//
// The keyword map stays in generate-video.js as a fallback, so a bad or
// unparseable Gemini response degrades to the old behaviour rather than
// failing the render.
//
// ─── REQUIRED: ADD THIS COLUMN TO video_jobs ─────────────────────────
//   alter table video_jobs add column if not exists image_queries jsonb;
//
// Required Vercel env vars (all server-only, NO "VITE_" prefix):
//   FISH_API_KEY, FISH_VOICE_ID, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
// Reuses VITE_SUPABASE_URL (just the project URL, not a secret).

import { createClient } from "@supabase/supabase-js";

// Gemini 2.0 Flash and 2.0 Flash-Lite were shut down on 1 June 2026 and
// now return 404 — do not put them back. 2.5 Flash-Lite is Google's
// recommended replacement and the cheapest capable option; the work here
// (a 70-word script plus three search phrases) needs speed and low cost
// far more than deep reasoning.
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";

const ALLOWED_ORIGINS = [
  "https://news30.live",
  "https://www.news30.live",
  "http://localhost:5173",
];

// Used if Gemini returns nothing usable — generate-video.js will then
// fall back to its own keyword map, which is the pre-existing behaviour.
const EMPTY_QUERIES = [];

const SCRIPT_PROMPT = `You write short vertical news videos.

Return ONLY valid JSON. No markdown fences, no preamble, no trailing text.
Exact shape:
{"script":"...","imageQueries":["...","...","..."]}

script: 65-75 words of spoken narration for a 30-second vertical news
video, based on the headline below. Plain spoken sentences only — no
headings, no bullet points, no stage directions, no speaker labels.
Open with the news itself. Write numbers as words where it reads more
naturally aloud ("four point two five percent", not "4.25%"), since
this text is sent straight to a text-to-speech engine.

imageQueries: exactly 3 stock-photo search phrases that visually
represent this story on Pexels. Rules:
- 2 to 4 words each.
- GENERIC and PHOTOGRAPHABLE. Stock libraries hold no photos of
  specific named events, named people, or specific buildings. Convert
  the subject into a visual concept instead.
- The 3 phrases must be visually DIFFERENT from each other, so the
  finished video does not show three near-identical shots.
- No proper nouns. No dates. No numbers.

Example for the headline "Israel and Hamas agree ceasefire framework":
{"script":"...","imageQueries":["diplomatic negotiation table","united nations flags","handshake formal meeting"]}

Example for the headline "Norway's sovereign wealth fund posts record returns":
{"script":"...","imageQueries":["financial district skyline","stock chart screen","bank vault interior"]}`;

// Gemini sometimes wraps JSON in fences or adds a stray sentence despite
// being told not to, so parse defensively and never throw — a failure
// here should cost us the image queries, not the whole render.
function parseScriptResponse(raw) {
  if (!raw) return null;

  let cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

  // If there's leading/trailing prose, grab the outermost JSON object.
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

  return { script: parsed.script.trim(), imageQueries: queries };
}

async function generateScript(headline, category, apiKey) {
  const prompt =
    SCRIPT_PROMPT +
    "\n\nHeadline: " + headline +
    "\nCategory: " + (category || "news");

  const upstream = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Header, not a ?key= query string — query strings end up in logs.
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 600,
        temperature: 0.7,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    // Logged, never returned — Gemini error payloads can echo the request back.
    console.error("[generate-audio] Gemini error", upstream.status, JSON.stringify(data));
    throw new Error("Script generation failed (" + upstream.status + ")");
  }

  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const raw = parts.map((p) => p.text || "").join("").trim();

  const parsed = parseScriptResponse(raw);
  if (!parsed) {
    console.error("[generate-audio] could not parse Gemini response:", raw.slice(0, 400));
    throw new Error("Script generation returned an unusable response");
  }

  if (!parsed.imageQueries.length) {
    console.warn("[generate-audio] Gemini returned no usable imageQueries; falling back to keyword map");
  }

  return parsed;
}

export default async function handler(req, res) {
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

  // Two accepted call shapes:
  //   { storyId, script }                       — script supplied (test harness)
  //   { storyId, headline, category }           — generate script + queries via Gemini
  // Passing a script explicitly always wins, so the test page keeps
  // working exactly as before and stays useful for isolating TTS issues
  // without spending a Gemini call.
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
  const geminiKey = process.env.GEMINI_API_KEY;

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
  if (!providedScript && !geminiKey) {
    console.error("[generate-audio] GEMINI_API_KEY missing but script generation was requested");
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
    // 1) Script + image queries.
    let script = providedScript;
    let imageQueries = Array.isArray(providedQueries) ? providedQueries.slice(0, 3) : [];

    if (!script) {
      const generated = await generateScript(headline, category, geminiKey);
      script = generated.script;
      if (!imageQueries.length) imageQueries = generated.imageQueries;
    }

    // Persist both before TTS — if narration fails, the script and
    // queries survive on the row and the job can be retried cheaply
    // without paying for another Gemini call.
    await supabase
      .from("video_jobs")
      .update({
        script,
        image_queries: imageQueries.length ? imageQueries : null,
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

    res.status(200).json({ jobId: job.id, audioUrl, script, imageQueries });
  } catch (e) {
    console.error("[generate-audio] failed:", e);
    await supabase
      .from("video_jobs")
      .update({ status: "failed", error: String(e).slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", job.id);

    res.status(500).json({ error: e.message || "Audio generation failed", jobId: job.id });
  }
}
