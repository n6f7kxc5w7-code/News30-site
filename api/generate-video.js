// /api/generate-video.js
// 🔌 STEP 3 OF THE VIDEO PIPELINE — FFmpeg version (free, self-hosted).
// Downloads real Pexels images + the Fish Audio narration into /tmp,.
// uses FFmpeg (via ffmpeg-static) to assemble a 720x1280 video with a
// gentle Ken Burns zoom per image and burned-in captions, muxes in the
// narration, then uploads the finished MP4 to Supabase Storage.
//
// Required Vercel env vars (server-only, no "VITE_" prefix):
//   PEXELS_API_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   PIPELINE_ENABLED           (set to "false" to kill all rendering
//                               instantly without a redeploy — see below)
// Reuses VITE_SUPABASE_URL.
//
// ─── FIXES IN THIS VERSION ──────────────────────────────────────────
// 1. THE "SAME IMAGE FOR THE WHOLE VIDEO" BUG. zoompan's `d` parameter
//    is the number of output frames generated PER INPUT FRAME, not the
//    total length of the segment. Inputs here are `-loop 1 -t 6 -i img`,
//    which already produce ~150 frames each, so `d=150` was asking for
//    150 x 150 = ~22,500 frames from image 1 alone. `-shortest` then cut
//    the video at the audio length, so the finished video showed only
//    the first image, crawling, start to finish. Fixed by using `d=1`
//    (one output frame per input frame) and driving the zoom off `on`,
//    the output frame counter, so the Ken Burns effect still ramps
//    smoothly across each segment.
//
// 2. THE PADDING LOOP THAT REPEATED IMAGE ZERO. The old line
//       while (photos.length < count) photos.push(photos[photos.length % photos.length]);
//    computes n % n, which is always 0 — so short result sets were
//    padded with five copies of the same photo. Replaced with a proper
//    multi-query fill that only ever adds genuinely new photos, and
//    accepts a shorter video over a repeated one.
//
// 3. SUBSTRING KEYWORD MATCHING. The old map used `lower.includes(t)`,
//    so "ai" matched Ukraine / aid / campaign / air, "bill" matched
//    billion, "app" matched appeal, "war" matched warning, and "heat"
//    matched wheat. Now matched on word boundaries with a scoring pass
//    across all categories instead of first-match-wins.
//
// 4. IMAGE QUERIES NOW COME FROM GEMINI. The keyword map can only
//    recognise vocabulary it was written for — headlines like "Israel
//    and Hamas agree ceasefire framework" or "Bitcoin falls after ETF
//    outflows" score zero triggers and fall through to generic photos.
//    generate-audio.js now asks Gemini for three stock-photo search
//    phrases in the same call that produces the script (no extra
//    round-trip, which is what made the old step-3 Gemini call
//    untenable against the 60s limit) and stores them on the job row.
//    This function reads job.image_queries first and only falls back to
//    the map below when they're missing or unusable.
//
//    Requires: alter table video_jobs add column if not exists image_queries jsonb;
// ─────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import ffmpegPath from "ffmpeg-static";
import { enforceRateLimit } from "./_rate-limit.js";

const execFileAsync = promisify(execFile);

const FALLBACK_DURATION_SECONDS = 30;
const IMAGE_COUNT = 5;
const MIN_IMAGE_COUNT = 3; // ship a shorter rotation rather than repeat a photo
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 25;

// Only these origins may trigger a render. This endpoint spends real
// money (Pexels quota, Supabase storage, function time), so it must not
// be callable from arbitrary sites.
const ALLOWED_ORIGINS = [
  "https://news30.live",
  "https://www.news30.live",
  "http://localhost:5173",
];

/* ───────────────────────── KEYWORD MATCHING ─────────────────────────

   Each bucket now carries SEVERAL distinct search phrases rather than
   one. Two reasons:

   (a) Variety. Running one query and taking the top 5 gives five near
       identical photos, because stock libraries cluster visually
       similar results together. Running three different queries and
       taking a couple from each produces a visibly varied sequence.

   (b) Depth. If one phrase returns thin results, the others fill the
       gap with on-topic images instead of falling back to something
       generic.

   Triggers are matched on word boundaries. A trailing `*` means prefix
   match (so "prosecut*" catches prosecuted / prosecution / prosecutors).
*/
const STOCK_KEYWORD_MAP = [
  {
    triggers: ["strike*", "military", "war", "troops", "missile", "attack*", "conflict", "defence", "defense", "army", "navy", "soldier*", "airstrike*"],
    queries: ["military aircraft sky", "soldiers formation uniform", "naval warship sea"],
  },
  {
    triggers: ["election*", "vote*", "parliament", "president", "government", "minister*", "policy", "policies", "law", "laws", "bill", "senate", "congress", "summit", "treaty", "diplomat*"],
    queries: ["government parliament building", "national flags row", "podium press conference"],
  },
  {
    triggers: ["market*", "stock*", "econom*", "inflation", "bank*", "trade", "profit*", "gdp", "interest rate", "currency", "shares", "investor*", "recession", "tariff*"],
    queries: ["stock market trading screen", "financial district skyline", "currency banknotes closeup"],
  },
  {
    triggers: ["court*", "trial", "lawsuit", "judge*", "legal", "sentenc*", "charges", "prosecut*", "verdict", "appeal"],
    queries: ["courtroom interior", "judge gavel desk", "law books library"],
  },
  {
    triggers: ["climate", "weather", "storm*", "flood*", "heat", "heatwave", "hurricane", "wildfire*", "drought", "emissions", "wildlife"],
    queries: ["storm clouds dramatic sky", "flooded street water", "wildfire smoke landscape"],
  },
  {
    triggers: ["football", "soccer", "match", "goal*", "tournament", "championship", "team*", "player*", "coach", "transfer", "league", "olympic*", "cricket", "tennis"],
    queries: ["stadium crowd floodlights", "football pitch aerial", "athlete running track"],
  },
  {
    triggers: ["tech", "ai", "artificial intelligence", "software", "app", "startup*", "chip*", "robot*", "data", "cyber*", "semiconductor*", "algorithm*"],
    queries: ["server room data centre", "circuit board macro", "person coding screen"],
  },
  {
    triggers: ["health", "hospital*", "disease", "vaccine*", "medical", "drug*", "treatment", "patient*", "doctor*", "outbreak", "virus"],
    queries: ["hospital corridor", "medical laboratory research", "doctor stethoscope hands"],
  },
  {
    triggers: ["space", "nasa", "rocket*", "satellite*", "astronaut*", "orbit", "lunar", "mars"],
    queries: ["rocket launch flames", "earth from space", "night sky stars"],
  },
  {
    triggers: ["protest*", "rally", "demonstration", "march", "riot*", "strike action", "union*"],
    queries: ["crowd protest signs", "city street march", "megaphone activist"],
  },
];

// Sensible visuals per category, used when no trigger matches.
const CATEGORY_FALLBACK = {
  geopolitics: ["national flags row", "government building exterior", "world map closeup"],
  finance: ["stock market trading screen", "financial district skyline", "currency banknotes closeup"],
  sports: ["stadium crowd floodlights", "athlete running track", "sports equipment closeup"],
};
const GENERIC_FALLBACK = ["newspaper headlines closeup", "city skyline morning", "newsroom desk"];

// Phrases where a trigger word carries a different meaning than the
// bucket assumes. "EU leaders strike a deal" is not a military story.
const FALSE_POSITIVE_PHRASES = [
  { phrase: /strikes? (a )?deal/, suppress: "strike" },
  { phrase: /struck (a )?deal/, suppress: "strike" },
  { phrase: /hunger strike/, suppress: "strike" },
  { phrase: /price war/, suppress: "war" },
  { phrase: /trade war/, suppress: "war" },
  { phrase: /bidding war/, suppress: "war" },
];

function triggerRegex(trigger) {
  if (trigger.endsWith("*")) {
    return new RegExp("\\b" + trigger.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\w*\\b");
  }
  return new RegExp("\\b" + trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
}

// Scores every bucket against the headline and returns the best match's
// query list, rather than taking whichever bucket happens to be listed
// first. A headline hitting three finance words and one military word
// now correctly reads as finance.
function getStockQueries(headline, category) {
  const lower = (headline || "").toLowerCase();

  const suppressed = new Set();
  for (const fp of FALSE_POSITIVE_PHRASES) {
    if (fp.phrase.test(lower)) suppressed.add(fp.suppress);
  }

  let best = null;
  let bestScore = 0;

  for (const bucket of STOCK_KEYWORD_MAP) {
    let score = 0;
    for (const trigger of bucket.triggers) {
      const bare = trigger.replace(/\*$/, "");
      if (suppressed.has(bare)) continue;
      if (triggerRegex(trigger).test(lower)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }

  if (best) return best.queries;
  return CATEGORY_FALLBACK[(category || "").toLowerCase()] || GENERIC_FALLBACK;
}

/* ────────────────────────── PEXELS FETCHING ────────────────────────── */

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fetches a POOL of candidates per query rather than exactly `count`,
// then dedupes by Pexels photo id and shuffles. Pulling a pool is what
// makes genuine variety possible: asking for exactly 5 and taking all 5
// means any duplicate or dud in that set has no replacement available.
async function fetchPexelsImages(queries, count, apiKey, category) {
  const POOL_PER_QUERY = 15;
  const randomPage = () => 1 + Math.floor(Math.random() * 3);

  const search = async (q, orientation) => {
    const url =
      "https://api.pexels.com/v1/search?query=" +
      encodeURIComponent(q) +
      "&per_page=" + POOL_PER_QUERY +
      "&page=" + randomPage() +
      (orientation ? "&orientation=" + orientation : "");
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) throw new Error("Pexels request failed: " + res.status);
    const data = await res.json();
    return (data.photos || []).map((p) => ({
      id: p.id,
      url: p.src.large2x || p.src.large || p.src.original,
    }));
  };

  // Dedupe by photo ID, not URL — the same photo can surface across
  // several of our queries, and ID is the reliable identity.
  const seen = new Set();
  const pool = [];
  const addAll = (photos) => {
    for (const p of photos) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      pool.push(p);
    }
  };

  // Run the topic queries in parallel; a single failing query shouldn't
  // sink the whole render.
  const results = await Promise.all(
    queries.map((q) => search(q, "portrait").catch(() => []))
  );
  results.forEach(addAll);

  // Still thin? Widen in stages before ever considering a repeat.
  if (pool.length < count) {
    const catQueries = CATEGORY_FALLBACK[(category || "").toLowerCase()] || GENERIC_FALLBACK;
    const more = await Promise.all(
      catQueries.map((q) => search(q, "portrait").catch(() => []))
    );
    more.forEach(addAll);
  }

  // Dropping the portrait filter roughly triples the available pool.
  // We scale-and-crop to 720x1280 anyway, so a landscape source is
  // usable — just more aggressively cropped.
  if (pool.length < count) {
    const anyOrientation = await Promise.all(
      queries.map((q) => search(q, null).catch(() => []))
    );
    anyOrientation.forEach(addAll);
  }

  if (pool.length < MIN_IMAGE_COUNT) {
    throw new Error(
      "Pexels returned only " + pool.length + " usable images for: " + queries.join(" / ")
    );
  }

  // Shuffle so two videos on the same topic don't open on the same shot,
  // then take what we need. Note we return however many unique photos we
  // have (down to MIN_IMAGE_COUNT) — a 4-image video is better than a
  // 5-image video with a duplicate in it.
  return shuffle(pool).slice(0, count).map((p) => p.url);
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to download " + url + ": " + res.status);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

/* ─────────────────────────── AUDIO / CAPTIONS ─────────────────────────── */

// Measures the real narration length instead of assuming 30 seconds.
// Running `ffmpeg -i file` with no output prints Duration to stderr
// before erroring — avoids bundling ffprobe as a second binary.
async function getAudioDuration(audioPath) {
  try {
    await execFileAsync(ffmpegPath, ["-i", audioPath]);
    return FALLBACK_DURATION_SECONDS;
  } catch (e) {
    const output = (e.stderr || e.message || "").toString();
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return FALLBACK_DURATION_SECONDS;
    const [, h, m, s] = match;
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
  }
}

function buildCaptionChunks(script, totalSeconds) {
  const words = script.trim().split(/\s+/);
  const chunkSize = 4;
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }
  const perChunk = totalSeconds / chunks.length;
  return chunks.map((text, i) => ({
    text,
    start: (i * perChunk).toFixed(2),
    end: ((i + 1) * perChunk).toFixed(2),
  }));
}

function assTimestamp(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
  const pad = (n, len) => String(n).padStart(len, "0");
  return h + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(cs, 2);
}

// Style is baked into the .ass file's own [V4+ Styles] section rather
// than passed via force_style on a bare .srt — force_style proved
// unreliable in testing (captions ignored MarginV/Alignment entirely).
// PlayResX/Y must match the real output resolution or positioning drifts.
//
// BorderStyle=1 is outline mode: "Outline" is stroke thickness around
// each letter. (In BorderStyle=3, box mode, that same field is box
// padding — and with Outline=0 the box silently collapses to nothing.)
function buildAss(captionChunks) {
  const header =
    "[Script Info]\n" +
    "ScriptType: v4.00+\n" +
    "PlayResX: " + WIDTH + "\n" +
    "PlayResY: " + HEIGHT + "\n" +
    "ScaledBorderAndShadow: yes\n\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    "Style: Default,Liberation Sans,68,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,2,2,40,40,150,1\n\n" +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  const events = captionChunks.map((c) =>
    "Dialogue: 0," + assTimestamp(parseFloat(c.start)) + "," + assTimestamp(parseFloat(c.end)) + ",Default,,0,0,0,," + c.text
  ).join("\n");

  return header + events;
}

/* ──────────────────────────── FFMPEG GRAPH ──────────────────────────── */

function buildFilterComplex(imagePaths, assPath, fontsDir, totalSeconds) {
  const perImageSeconds = totalSeconds / imagePaths.length;
  const framesPerImage = Math.max(1, Math.round(perImageSeconds * FPS));

  // Zoom ramps from 1.0 to ZOOM_MAX across the segment. Derived from the
  // frame count so the pace is identical whatever the segment length.
  const ZOOM_MAX = 1.15;
  const zoomStep = (ZOOM_MAX - 1) / framesPerImage;

  const parts = [];
  const zoomLabels = [];

  imagePaths.forEach((_, i) => {
    parts.push(
      "[" + i + ":v]scale=" + WIDTH + ":" + HEIGHT + ":force_original_aspect_ratio=increase," +
      "crop=" + WIDTH + ":" + HEIGHT + "," +
      "setsar=1," +
      // d=1 — one output frame per input frame. The input is already a
      // looped image stream of the right length, so anything higher
      // multiplies the frame count (this was the whole-video-is-one-image
      // bug). `on` is the output frame index, giving a smooth linear ramp
      // without relying on zoom accumulating between frames.
      "zoompan=z='min(1+" + zoomStep.toFixed(6) + "*on," + ZOOM_MAX + ")'" +
      ":d=1:s=" + WIDTH + "x" + HEIGHT + ":fps=" + FPS +
      "[v" + i + "]"
    );
    zoomLabels.push("[v" + i + "]");
  });

  parts.push(zoomLabels.join("") + "concat=n=" + imagePaths.length + ":v=1:a=0[vconcat]");

  // Captions burned in via libass's `subtitles` filter, not `drawtext` —
  // Vercel's bundled static FFmpeg has no drawtext ("No such filter"),
  // but does include libass.
  //
  // `fontsdir` points libass at the font bundled in this repo. Vercel's
  // serverless environment ships NO system fonts, and libass silently
  // draws nothing rather than erroring when it can't find one.
  parts.push("[vconcat]subtitles=" + assPath + ":fontsdir=" + fontsDir + "[vout]");

  return { filterComplex: parts.join(";"), finalLabel: "vout" };
}

/* ──────────────────────────────  HANDLER  ────────────────────────────── */

export default async function handler(req, res) {
  /* Locked for the same reason as generate-audio: Pexels calls, Supabase
     storage and a full FFmpeg render, all billable, all previously
     reachable by anyone who found the URL.

     process.js calls this internally with x-pipeline-secret (the header
     that also bypasses the rate limit below); a bearer token covers any
     other legitimate caller. Anything else gets a 401. */
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[generate-video] CRON_SECRET not configured — refusing to run");
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

  // Kill switch. Set PIPELINE_ENABLED=false in Vercel to stop every
  // render immediately, with no redeploy, if something starts burning
  // quota or money unexpectedly.
  if (process.env.PIPELINE_ENABLED === "false") {
    res.status(503).json({ error: "Video pipeline is currently disabled" });
    return;
  }

  // Rendering is the most expensive and slowest operation in the stack,
  // so this doubles as protection against concurrent renders piling up
  // against Vercel's function time limit.
  if (!(await enforceRateLimit(req, res, "generate-video", 5, 60))) return;

  const { jobId, headline, category } = req.body || {};
  if (!jobId || !headline) {
    res.status(400).json({ error: "jobId and headline are both required" });
    return;
  }

  const pexelsKey = process.env.PEXELS_API_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!pexelsKey || !supabaseUrl || !serviceKey) {
    console.error("[generate-video] missing config", {
      PEXELS_API_KEY: !!pexelsKey,
      VITE_SUPABASE_URL: !!supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: !!serviceKey,
    });
    res.status(500).json({ error: "Server is not configured for video rendering" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: job, error: fetchErr } = await supabase
    .from("video_jobs").select("*").eq("id", jobId).single();
  if (fetchErr || !job) {
    res.status(404).json({ error: "Job not found: " + jobId });
    return;
  }
  if (!job.audio_url) {
    res.status(400).json({ error: "This job has no audio yet — run /api/generate-audio.js first" });
    return;
  }

  const workDir = path.join(os.tmpdir(), "news30-" + jobId);
  await fs.mkdir(workDir, { recursive: true });

  try {
    await supabase.from("video_jobs")
      .update({ status: "rendering", updated_at: new Date().toISOString() })
      .eq("id", jobId);

    // Images and audio don't depend on each other, so fetch both at once —
    // wall-clock time matters against Vercel's 60s function limit.
    const audioPath = path.join(workDir, "audio.mp3");

    const [imagePaths] = await Promise.all([
      (async () => {
        // Prefer the search phrases Gemini produced alongside the script
        // in generate-audio.js — it understands that "ceasefire framework"
        // should look like a negotiation table, whereas the keyword map
        // below can only recognise vocabulary it was written for.
        // The map remains as a fallback so an unparseable or missing
        // Gemini response degrades to the old behaviour instead of
        // failing the render.
        const fromGemini = Array.isArray(job.image_queries) ? job.image_queries : [];
        const usingGemini = fromGemini.length > 0;
        const queries = usingGemini ? fromGemini : getStockQueries(headline, category);
        console.log(
          "[generate-video] queries (" + (usingGemini ? "gemini" : "keyword map") + "):",
          queries.join(" | ")
        );
        const imageUrls = await fetchPexelsImages(queries, IMAGE_COUNT, pexelsKey, category);
        console.log("[generate-video] unique images fetched:", imageUrls.length);
        return Promise.all(imageUrls.map(async (url, i) => {
          const dest = path.join(workDir, "img" + i + ".jpg");
          await downloadToFile(url, dest);
          return dest;
        }));
      })(),
      downloadToFile(job.audio_url, audioPath),
    ]);

    // Real narration length — everything below (caption timing, per-image
    // duration, total video length) derives from this rather than a fixed
    // 30s assumption, which is what caused captions to drift on longer
    // scripts.
    const realDuration = await getAudioDuration(audioPath);
    const segmentSeconds = realDuration / imagePaths.length;

    const captionChunks = buildCaptionChunks(job.script || headline, realDuration);
    const assPath = path.join(workDir, "captions.ass");
    await fs.writeFile(assPath, buildAss(captionChunks), "utf8");
    const fontsDir = path.dirname(fileURLToPath(new URL("./LiberationSans-Bold.ttf", import.meta.url)));
    const { filterComplex, finalLabel } = buildFilterComplex(imagePaths, assPath, fontsDir, realDuration);

    const outputPath = path.join(workDir, "output.mp4");
    const args = [];
    imagePaths.forEach((p) => {
      // -framerate pins the looped still to our timeline fps, so the
      // input frame count is exactly segmentSeconds * FPS and lines up
      // with the zoom ramp computed in buildFilterComplex.
      args.push("-loop", "1", "-framerate", String(FPS), "-t", segmentSeconds.toFixed(3), "-i", p);
    });
    args.push("-i", audioPath);
    args.push(
      "-filter_complex", filterComplex,
      "-map", "[" + finalLabel + "]",
      "-map", imagePaths.length + ":a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-r", String(FPS),
      "-c:a", "aac",
      "-shortest",
      "-y", outputPath
    );

    await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 });

    // ── Thumbnail ───────────────────────────────────────────────────
    // Grabbed from the finished video rather than reusing a Pexels
    // image, for three reasons: it is guaranteed to match what actually
    // plays, it already carries the Ken Burns crop and burned-in
    // caption so the card previews the real thing, and it sidesteps any
    // question about republishing a stock image as cover art.
    //
    // Taken ~1.5s in — far enough past the first frame to have zoomed
    // slightly and to usually have a caption on screen.
    const thumbPath = path.join(workDir, "thumb.jpg");
    let thumbnailUrl = null;
    try {
      await execFileAsync(ffmpegPath, [
        "-ss", "1.5",
        "-i", outputPath,
        "-frames:v", "1",
        "-q:v", "3",
        "-y", thumbPath,
      ]);

      const thumbBuffer = await fs.readFile(thumbPath);
      const thumbFilePath = "thumb/" + jobId + ".jpg";
      const { error: thumbErr } = await supabase.storage
        .from("media")
        .upload(thumbFilePath, thumbBuffer, { contentType: "image/jpeg", upsert: true });

      if (thumbErr) {
        // A missing thumbnail is a cosmetic problem; a missing video is
        // not. Never fail the render over cover art — the front end
        // falls back to generated artwork.
        console.error("[generate-video] thumbnail upload failed:", thumbErr);
      } else {
        const { data: thumbUrlData } = supabase.storage.from("media").getPublicUrl(thumbFilePath);
        thumbnailUrl = thumbUrlData.publicUrl;
      }
    } catch (e) {
      console.error("[generate-video] thumbnail extraction failed:", e);
    }

    const videoBuffer = await fs.readFile(outputPath);
    const filePath = "video/" + jobId + ".mp4";
    const { error: uploadErr } = await supabase.storage
      .from("media")
      .upload(filePath, videoBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadErr) throw new Error("Storage upload failed: " + uploadErr.message);

    const { data: publicUrlData } = supabase.storage.from("media").getPublicUrl(filePath);
    const videoUrl = publicUrlData.publicUrl;

    await supabase.from("video_jobs")
      .update({
        status: "done",
        video_url: videoUrl,
        thumbnail_url: thumbnailUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    res.status(200).json({
      jobId,
      videoUrl,
      thumbnailUrl,
      durationSeconds: Number(realDuration.toFixed(2)),
      status: "done",
      imageCount: imagePaths.length,
    });
  } catch (e) {
    console.error("[generate-video] render failed:", e);
    await supabase.from("video_jobs")
      .update({ status: "failed", error: String(e).slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", jobId);
    res.status(500).json({ error: "Video render failed" });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
