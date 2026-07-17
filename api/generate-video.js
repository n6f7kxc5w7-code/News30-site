// /api/generate-video.js
// 🔌 STEP 3 OF THE VIDEO PIPELINE — FFmpeg version (free, self-hosted,
// replaces Shotstack). Downloads real Pexels images + the Fish Audio
// narration into /tmp, uses FFmpeg (via ffmpeg-static, a bundled free
// binary — no paid API) to assemble a 1080x1920 video with a gentle
// Ken Burns zoom on each image and BURNED-IN captions generated from
// the script itself, muxes in the narration audio, then uploads the
// finished MP4 to Supabase Storage.
//
// ⚠️ HONEST FLAG: running FFmpeg inside a Vercel serverless function is
// a known rough edge — several developers report it working locally
// then failing in production with "binary not found," or hitting
// function size/time limits. This is written as carefully as
// reasonably possible, but if it fails on first deploy, the error
// message will tell us which of these it is, and there are fallbacks
// (see comments below) rather than starting over from scratch.
//
// Required Vercel env vars (server-only, no "VITE_" prefix):
//   PEXELS_API_KEY
//   SUPABASE_SERVICE_ROLE_KEY   (already added for generate-audio.js)
// Reuses VITE_SUPABASE_URL. SHOTSTACK_API_KEY is no longer needed —
// safe to remove once this is confirmed working.
//
// Because FFmpeg renders synchronously inside this one function call
// (unlike Shotstack's async webhook), this function does the ENTIRE
// job in one request: fetch images -> download -> render -> upload ->
// mark the job "done" -> return. If the video_jobs row is still stuck
// on "rendering" a while after this call returns, it means the
// function hit Vercel's time limit before finishing (see maxDuration
// in vercel.json) — the fix there is fewer/shorter images, not more
// code here.

import { createClient } from "@supabase/supabase-js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const FALLBACK_DURATION_SECONDS = 30; // only used if duration detection somehow fails
const IMAGE_COUNT = 5; // 30s / 5 = 6s per image
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 25;

// Turns a specific news headline into broad, generic keywords a stock
// photo library can actually match. Pexels doesn't have photos of
// specific real events ("Iran USA strikes") — searching the literal
// headline either returns almost nothing (forcing the same-image-
// repeated fallback) or something thematically unrelated. Asking
// Gemini for the underlying visual THEME (e.g. "military aircraft",
// "government building", "flag") instead of the literal event fixes
// both problems at once, since they were really the same root cause.
async function getStockKeywords(headline, category, geminiKey) {
  if (!geminiKey) return category || "news"; // graceful fallback, no hard dependency
  try {
    const prompt =
      "Convert this news headline into 3-4 broad, generic English keywords " +
      "suitable for searching a GENERIC STOCK PHOTO library (like Pexels or Shutterstock). " +
      "Focus on visual THEMES and CONCEPTS a stock library would actually have photos of " +
      "(e.g. 'military aircraft', 'government building', 'stock market', 'courtroom') " +
      "— NOT specific real people, countries, or named events, since stock libraries don't " +
      "have those. Output ONLY the comma-separated keywords, nothing else.\n\n" +
      "Category: " + (category || "general") + "\n" +
      "Headline: " + headline;

    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=" + encodeURIComponent(geminiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) return category || "news";
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return (text && text.trim()) || category || "news";
  } catch (e) {
    return category || "news"; // never let a keyword-extraction hiccup break the whole pipeline
  }
}

async function fetchPexelsImages(query, count, apiKey, category) {
  const search = async (q) => {
    const url =
      "https://api.pexels.com/v1/search?query=" +
      encodeURIComponent(q) +
      "&per_page=" + count +
      "&orientation=portrait";
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) throw new Error("Pexels request failed: " + res.status);
    const data = await res.json();
    return (data.photos || []).map((p) => p.src.large2x || p.src.large || p.src.original);
  };

  let photos = await search(query);

  // If the specific headline search didn't return enough UNIQUE photos,
  // broaden with a more generic query instead of repeating the same
  // image over and over (which is what happened before this fix).
  if (photos.length < count) {
    const broader = await search(category || "news").catch(() => []);
    for (const p of broader) {
      if (photos.length >= count) break;
      if (!photos.includes(p)) photos.push(p);
    }
  }
  // Last-resort fallback only if Pexels genuinely has nothing at all.
  if (photos.length === 0) throw new Error("Pexels returned no images for: " + query);
  while (photos.length < count) photos.push(photos[photos.length % photos.length]);

  return photos.slice(0, count);
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to download " + url + ": " + res.status);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

// Measures the real duration of the narration audio instead of assuming
// it's always exactly 30 seconds. Fish Audio's actual speaking pace
// varies slightly script to script — basing caption/image timing on a
// fixed assumption is what caused captions to drift out of sync
// ("lagging behind the narrator") on longer scripts. Uses only the
// already-bundled ffmpeg binary (running `ffmpeg -i file` with no
// output prints Duration to stderr before erroring — a standard trick
// that avoids needing to also bundle ffprobe as a second binary).
async function getAudioDuration(audioPath) {
  try {
    await execFileAsync(ffmpegPath, ["-i", audioPath]);
    // Shouldn't reach here — ffmpeg always errors with no output specified.
    return FALLBACK_DURATION_SECONDS;
  } catch (e) {
    const output = (e.stderr || e.message || "").toString();
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return FALLBACK_DURATION_SECONDS;
    const [, h, m, s] = match;
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
  }
}

// Splits the script into short caption chunks (3-5 words each) and
// spreads them evenly across the video's duration, proportional to
// word count. No transcription/timing API needed — this is an
// estimate, same assumption already baked into the script prompt
// (65-75 words ≈ 30 seconds of natural speech).
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

// Formats seconds as an ASS timestamp: H:MM:SS.cc (centiseconds)
function assTimestamp(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
  const pad = (n, len) => String(n).padStart(len, "0");
  return h + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(cs, 2);
}

// Builds a full .ass subtitle file with the style baked directly into
// its own [V4+ Styles] section, instead of relying on FFmpeg's
// `force_style` override on a bare .srt.
//
// ⚠️ WHY: force_style on a plain .srt turned out to be unreliable in
// real testing — captions rendered at the wrong position (mid-frame,
// ignoring MarginV/Alignment entirely) no matter what was set. Baking
// the style into a proper .ass file (with PlayResX/Y declared to match
// our real output resolution) is the standard, more reliable path and
// was verified to position correctly in testing.
//
// Also confirmed by testing: with BorderStyle=3 (opaque box behind the
// text), the "Outline" field must be a nonzero value — that field
// controls the box's padding/thickness in this mode, and with Outline=0
// the box silently collapses to nothing (text still shows, box doesn't).
function buildAss(captionChunks) {
  const header =
    "[Script Info]\n" +
    "ScriptType: v4.00+\n" +
    "PlayResX: " + WIDTH + "\n" +
    "PlayResY: " + HEIGHT + "\n" +
    "ScaledBorderAndShadow: yes\n\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    // BackColour uses full opacity (&H00 alpha) — semi-transparent alpha
    // was tested and silently ignored by this render path, so a solid
    // box is used instead (still clean and highly readable).
    "Style: Default,Liberation Sans,58,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,8,0,2,60,60,140,1\n\n" +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  const events = captionChunks.map((c) =>
    "Dialogue: 0," + assTimestamp(parseFloat(c.start)) + "," + assTimestamp(parseFloat(c.end)) + ",Default,,0,0,0,," + c.text
  ).join("\n");

  return header + events;
}

function buildFilterComplex(imagePaths, assPath, fontsDir, totalSeconds) {
  const perImageSeconds = totalSeconds / imagePaths.length;
  const framesPerImage = Math.round(perImageSeconds * FPS);
  const parts = [];
  const zoomLabels = [];

  imagePaths.forEach((_, i) => {
    // Scale to fill the vertical frame, crop to exact size, then a
    // slow zoom (Ken Burns) over the segment's duration.
    parts.push(
      "[" + i + ":v]scale=" + WIDTH + ":" + HEIGHT + ":force_original_aspect_ratio=increase," +
      "crop=" + WIDTH + ":" + HEIGHT + "," +
      "zoompan=z='min(zoom+0.0015,1.2)':d=" + framesPerImage + ":s=" + WIDTH + "x" + HEIGHT + ":fps=" + FPS +
      "[v" + i + "]"
    );
    zoomLabels.push("[v" + i + "]");
  });

  // Concatenate all the zoomed image segments into one continuous stream.
  parts.push(zoomLabels.join("") + "concat=n=" + imagePaths.length + ":v=1:a=0[vconcat]");

  // Burn in captions via libass's `subtitles` filter instead of
  // `drawtext` — Vercel's bundled static FFmpeg binary doesn't include
  // drawtext (confirmed: "No such filter: 'drawtext'"), but does
  // include libass, which is what powers this filter.
  //
  // `fontsdir` points libass at a font file bundled directly in this
  // repo (api/fonts/LiberationSans-Bold.ttf). Without this, captions
  // render completely invisibly — Vercel's serverless environment has
  // NO system fonts installed at all, so libass silently draws nothing
  // rather than erroring.
  //
  // No `force_style` needed here — the style is already baked into the
  // .ass file itself (see buildAss above).
  parts.push("[vconcat]subtitles=" + assPath + ":fontsdir=" + fontsDir + "[vout]");

  return { filterComplex: parts.join(";"), finalLabel: "vout" };
}


export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const { jobId, headline, category } = req.body || {};
  if (!jobId || !headline) {
    res.status(400).json({ error: "jobId and headline are both required" });
    return;
  }

  const pexelsKey = process.env.PEXELS_API_KEY;
  const geminiKey = process.env.VITE_GEMINI_API_KEY; // already set for the script-generation step
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!pexelsKey || !supabaseUrl || !serviceKey) {
    res.status(500).json({
      error: "Missing server config",
      missing: { PEXELS_API_KEY: !pexelsKey, VITE_SUPABASE_URL: !supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: !serviceKey },
    });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: job, error: fetchErr } = await supabase
    .from("video_jobs").select("*").eq("id", jobId).single();
  if (fetchErr || !job) {
    res.status(404).json({ error: "Job not found: " + (fetchErr ? fetchErr.message : jobId) });
    return;
  }
  if (!job.audio_url) {
    res.status(400).json({ error: "This job has no audio yet — run /api/generate-audio.js first" });
    return;
  }

  const workDir = path.join(os.tmpdir(), "news30-" + jobId);
  await fs.mkdir(workDir, { recursive: true });

  try {
    await supabase.from("video_jobs").update({ status: "rendering", updated_at: new Date().toISOString() }).eq("id", jobId);

    // 1) Real images matched to the story topic, AND 2) the narration
    // audio — these two chains don't depend on each other at all, so
    // running them at the same time (instead of one-after-another, as
    // before) cuts real wall-clock time, which matters given Vercel's
    // 60-second function limit on the free plan.
    const audioPath = path.join(workDir, "audio.mp3");

    const [imagePaths] = await Promise.all([
      (async () => {
        const stockKeywords = await getStockKeywords(headline, category, geminiKey);
        const imageUrls = await fetchPexelsImages(stockKeywords, IMAGE_COUNT, pexelsKey, category);
        return Promise.all(imageUrls.map(async (url, i) => {
          const dest = path.join(workDir, "img" + i + ".jpg");
          await downloadToFile(url, dest);
          return dest;
        }));
      })(),
      downloadToFile(job.audio_url, audioPath),
    ]);

    // 2b) Measure how long the narration ACTUALLY is — this is the fix
    // for captions drifting out of sync. Everything below (caption
    // timing, per-image duration, total video length) now derives from
    // this real number instead of assuming a fixed 30 seconds.
    const realDuration = await getAudioDuration(audioPath);

    // 3) Build the FFmpeg filter graph: zoomed image sequence + burned-in
    //    captions via a real .ass file (subtitles filter, not drawtext).
    const captionChunks = buildCaptionChunks(job.script || headline, realDuration);
    const assPath = path.join(workDir, "captions.ass");
    await fs.writeFile(assPath, buildAss(captionChunks), "utf8");
    const fontsDir = path.dirname(fileURLToPath(new URL("./LiberationSans-Bold.ttf", import.meta.url)));
    const { filterComplex, finalLabel } = buildFilterComplex(imagePaths, assPath, fontsDir, realDuration);

    const outputPath = path.join(workDir, "output.mp4");
    const args = [];
    imagePaths.forEach((p) => { args.push("-loop", "1", "-t", String(realDuration / imagePaths.length), "-i", p); });
    args.push("-i", audioPath);
    args.push(
      "-filter_complex", filterComplex,
      "-map", "[" + finalLabel + "]",
      "-map", imagePaths.length + ":a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      "-y", outputPath
    );

    // Run FFmpeg. If this throws "spawn ENOENT" or similar, ffmpeg-static's
    // binary didn't get bundled correctly — see the honest flag at the
    // top of this file for what that means and how to fall back.
    await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 });

    // 4) Upload the finished video to Supabase Storage.
    const videoBuffer = await fs.readFile(outputPath);
    const filePath = "video/" + jobId + ".mp4";
    const { error: uploadErr } = await supabase.storage
      .from("media")
      .upload(filePath, videoBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadErr) throw new Error("Storage upload failed: " + uploadErr.message);

    const { data: publicUrlData } = supabase.storage.from("media").getPublicUrl(filePath);
    const videoUrl = publicUrlData.publicUrl;

    // 5) Done — no webhook needed, this whole thing just happened synchronously.
    await supabase.from("video_jobs")
      .update({ status: "done", video_url: videoUrl, updated_at: new Date().toISOString() })
      .eq("id", jobId);

    res.status(200).json({ jobId, videoUrl, status: "done" });
  } catch (e) {
    await supabase.from("video_jobs")
      .update({ status: "failed", error: String(e), updated_at: new Date().toISOString() })
      .eq("id", jobId);
    res.status(500).json({ error: String(e) });
  } finally {
    // Clean up /tmp regardless of outcome — Vercel's disk is ephemeral
    // per-invocation anyway, but tidy exits matter under memory pressure.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
