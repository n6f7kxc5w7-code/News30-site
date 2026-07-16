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
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const VIDEO_DURATION_SECONDS = 30;
const IMAGE_COUNT = 5; // 30s / 5 = 6s per image
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 25;

async function fetchPexelsImages(query, count, apiKey) {
  const url =
    "https://api.pexels.com/v1/search?query=" +
    encodeURIComponent(query) +
    "&per_page=" + count +
    "&orientation=portrait";

  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error("Pexels request failed: " + res.status);
  const data = await res.json();

  const photos = (data.photos || []).map((p) => p.src.large2x || p.src.large || p.src.original);
  if (photos.length === 0) throw new Error("Pexels returned no images for: " + query);
  while (photos.length < count) photos.push(photos[photos.length % photos.length || 0]);
  return photos.slice(0, count);
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to download " + url + ": " + res.status);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
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

// Formats seconds as an SRT timestamp: HH:MM:SS,mmm
function srtTimestamp(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  const pad = (n, len) => String(n).padStart(len, "0");
  return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms, 3);
}

// Builds a standard .srt file from the caption chunks — this is what
// gets burned into the video via FFmpeg's `subtitles` filter below.
function buildSrt(captionChunks) {
  return captionChunks.map((c, i) =>
    (i + 1) + "\n" +
    srtTimestamp(parseFloat(c.start)) + " --> " + srtTimestamp(parseFloat(c.end)) + "\n" +
    c.text + "\n"
  ).join("\n");
}

function buildFilterComplex(imagePaths, srtPath) {
  const perImageSeconds = VIDEO_DURATION_SECONDS / imagePaths.length;
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
  // include libass, which is what powers this filter. One filter
  // instead of one-per-caption-chunk, styled to look like our old
  // drawtext boxes (white bold text, semi-opaque black background bar,
  // positioned near the bottom rather than libass's usual bottom-most
  // default via MarginV).
  const style =
    "FontSize=13,Bold=1,PrimaryColour=&H00FFFFFF&,BorderStyle=3," +
    "BackColour=&H60000000&,Outline=0,MarginV=140,Alignment=2";
  parts.push("[vconcat]subtitles=" + srtPath + ":force_style='" + style + "'[vout]");

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

    // 1) Real images matched to the story topic.
    const searchQuery = (category ? category + " " : "") + headline;
    const imageUrls = await fetchPexelsImages(searchQuery, IMAGE_COUNT, pexelsKey);
    const imagePaths = await Promise.all(imageUrls.map(async (url, i) => {
      const dest = path.join(workDir, "img" + i + ".jpg");
      await downloadToFile(url, dest);
      return dest;
    }));

    // 2) Narration audio (already generated in the previous step).
    const audioPath = path.join(workDir, "audio.mp3");
    await downloadToFile(job.audio_url, audioPath);

    // 3) Build the FFmpeg filter graph: zoomed image sequence + burned-in
    //    captions via a real .srt file (subtitles filter, not drawtext).
    const captionChunks = buildCaptionChunks(job.script || headline, VIDEO_DURATION_SECONDS);
    const srtPath = path.join(workDir, "captions.srt");
    await fs.writeFile(srtPath, buildSrt(captionChunks), "utf8");
    const { filterComplex, finalLabel } = buildFilterComplex(imagePaths, srtPath);

    const outputPath = path.join(workDir, "output.mp4");
    const args = [];
    imagePaths.forEach((p) => { args.push("-loop", "1", "-t", String(VIDEO_DURATION_SECONDS / imagePaths.length), "-i", p); });
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
