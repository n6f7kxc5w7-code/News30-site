// scripts/youtube-cta.js
// 📣 YOUTUBE-ONLY CALL TO ACTION — used by scripts/upload.js, nowhere else.
//
// The site plays the pipeline's render as-is. Only the copy that goes to
// YouTube gets:
//   - a small "news30.live" watermark in the top-left corner (captions
//     sit at the bottom, MarginV=150 in api/generate-video.js, so a top
//     corner can never cover them);
//   - an end card (~2s, stretched to fit the voice line) in the site's
//     colours: "Test yourself →" / "news30.live" / "Quiz on every story";
//   - a spoken line over the card, in the same Fish Audio voice as the
//     narration.
//
// ─── THE SPOKEN CLIP IS GENERATED ONCE ──────────────────────────────
// It lives in the public "media" bucket at CTA_PATH. Every run downloads
// it (once per run, shared by all videos). Fish Audio is only called if
// that object does not exist yet — i.e. the very first run, or after
// CTA_VERSION is bumped because CTA_TEXT changed. The "brand/" folder is
// not in ingest.js's CLEANUP_FOLDERS, so retention never deletes it.
//
// ─── NEVER BREAKS AN UPLOAD ─────────────────────────────────────────
// makeYouTubeVersion() never throws. Any failure (ffmpeg missing, asset
// unavailable, Fish down, encode error, output failing the sanity check)
// logs a warning and returns the ORIGINAL bytes, so the upload proceeds
// exactly as it did before this existed.
//
// ─── SIZE ───────────────────────────────────────────────────────────
// The watermark means a re-encode, so it uses the render pipeline's own
// settings (libx264 superfast, CRF 25, 2500k ceiling — see fix #8 in
// api/generate-video.js) and the original's resolution, frame rate,
// audio sample rate, channels and audio bitrate. Output is typically the
// original size plus a couple of seconds of near-static card.
//
// Temp files go in the runner's temp folder (RUNNER_TEMP on GitHub
// Actions, os.tmpdir() elsewhere) and are deleted afterwards.

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

// Bump CTA_VERSION whenever CTA_TEXT changes: a new path means the next
// run generates (and stores) the new line once.
const CTA_TEXT = "Take the quiz at News thirty dot live.";
const CTA_VERSION = "v1";
const CTA_BUCKET = "media";
const CTA_PATH = "brand/youtube-cta-" + CTA_VERSION + ".mp3";

// Same model as api/generate-audio.js, so the voice matches the videos.
const FISH_MODEL = "s2.1-pro-free";

// End card timing: the voice starts shortly after the cut and the card
// holds a beat after it finishes. Never shorter than MIN, never longer
// than MAX even if the clip is unexpectedly long.
const CARD_MIN_SECONDS = 2.0;
const CARD_MAX_SECONDS = 4.0;
const VOICE_DELAY_SECONDS = 0.15;
const VOICE_TAIL_SECONDS = 0.45;

// Site palette (src/App.jsx :root): --bg, --txt, --blue, --txt2.
const CARD_BG = "0x0f0f0f";
const ASS_WHITE = "&H00F1F1F1";
const ASS_BLUE = "&H00FFA63E"; // #3ea6ff as &HAABBGGRR
const ASS_GREY = "&H00AAAAAA";

// Text is laid out on the pipeline's 720x1280 canvas; libass scales it
// to the real frame if a video is ever a different size.
const PLAY_W = 720;
const PLAY_H = 1280;

const FONT_FILE = fileURLToPath(new URL("../api/LiberationSans-Bold.ttf", import.meta.url));
const FFMPEG_TIMEOUT_MS = 180000;

const warn = (...a) => console.warn("[youtube-cta] ⚠️", ...a);
const log = (...a) => console.log("[youtube-cta]", ...a);

/* ───────────────────────────── ffmpeg ───────────────────────────── */

let ffmpegPathPromise = null;
function getFfmpegPath() {
  // Dynamic import so a missing ffmpeg-static falls back to the original
  // video instead of crashing upload.js at load time.
  if (!ffmpegPathPromise) {
    ffmpegPathPromise = import("ffmpeg-static").then((m) => {
      const p = m.default || m;
      if (!p) throw new Error("ffmpeg-static has no binary for this platform");
      return p;
    });
  }
  return ffmpegPathPromise;
}

async function run(ffmpeg, args, cwd) {
  return execFileAsync(ffmpeg, args, { cwd, timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 50 });
}

/** `ffmpeg -i file` with no output exits non-zero but prints stream info. */
async function probe(ffmpeg, file, cwd) {
  let stderr = "";
  try {
    ({ stderr } = await run(ffmpeg, ["-hide_banner", "-i", file], cwd));
  } catch (e) {
    stderr = String(e.stderr || "");
  }
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : null;

  const vLine = (stderr.match(/Stream #.*?Video:.*$/m) || [""])[0];
  const aLine = (stderr.match(/Stream #.*?Audio:.*$/m) || [""])[0];
  const size = vLine.match(/,\s*(\d{2,5})x(\d{2,5})/);
  const fps = vLine.match(/(\d+(?:\.\d+)?)\s*fps/);
  const rate = aLine.match(/(\d+)\s*Hz/);
  const aKbps = aLine.match(/(\d+)\s*kb\/s/);

  let channelLayout = null;
  if (/\bmono\b/.test(aLine)) channelLayout = "mono";
  else if (/\bstereo\b/.test(aLine)) channelLayout = "stereo";

  return {
    duration,
    hasVideo: !!vLine,
    hasAudio: !!aLine,
    width: size ? +size[1] : null,
    height: size ? +size[2] : null,
    fps: fps ? parseFloat(fps[1]) : null,
    sampleRate: rate ? +rate[1] : null,
    channelLayout,
    audioKbps: aKbps ? +aKbps[1] : null,
  };
}

/* ───────────────────────────── ASS text ─────────────────────────── */

const ASS_STYLES_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n";
const ASS_EVENTS_FORMAT =
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

function assHeader() {
  return (
    "[Script Info]\nScriptType: v4.00+\n" +
    "PlayResX: " + PLAY_W + "\nPlayResY: " + PLAY_H + "\n" +
    "WrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n" + ASS_STYLES_FORMAT
  );
}

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const pad = (n) => String(n).padStart(2, "0");
  return h + ":" + pad(m) + ":" + pad(s) + "." + pad(cs % 100);
}

/** Small, quiet, persistent: ~75% white with a soft dark edge so it reads
    on bright photos without shouting. Top-left, clear of the captions. */
function buildWatermarkAss() {
  return (
    assHeader() +
    // Alignment 7 = top-left. MarginL/MarginV place it in from the corner.
    "Style: WM,Liberation Sans,28,&H40FFFFFF,&H000000FF,&H90000000,&H00000000,1,0,0,0,100,100,0.5,0,1,1.6,0,7,34,0,46,1\n\n" +
    "[Events]\n" + ASS_EVENTS_FORMAT +
    "Dialogue: 0,0:00:00.00,9:59:59.00,WM,,0,0,0,,news30.live\n"
  );
}

/** End card: same flat, centred, outline-free look as the pipeline's
    text cards, in the site's colours. Text stays above y≈760, i.e. in
    the same band the pipeline's cards use, above where captions sit. */
function buildCardAss(seconds) {
  const end = assTime(seconds + 1);
  const fade = "{\\fad(220,0)}";
  return (
    assHeader() +
    "Style: Big,Liberation Sans,66," + ASS_WHITE + ",&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,40,40,0,1\n" +
    "Style: Url,Liberation Sans,78," + ASS_BLUE + ",&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,40,40,0,1\n" +
    "Style: Sub,Liberation Sans,36," + ASS_GREY + ",&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0.5,0,1,0,0,5,40,40,0,1\n\n" +
    "[Events]\n" + ASS_EVENTS_FORMAT +
    "Dialogue: 0,0:00:00.00," + end + ",Big,,0,0,0,," + fade + "{\\pos(360,515)}Test yourself {\\c&HFFA63E&}→\n" +
    "Dialogue: 0,0:00:00.00," + end + ",Url,,0,0,0,," + fade + "{\\pos(360,612)}news30.live\n" +
    "Dialogue: 0,0:00:00.00," + end + ",Sub,,0,0,0,," + fade + "{\\pos(360,706)}Quiz on every story\n"
  );
}
/* ─────────────────────── spoken clip (asset) ────────────────────── */

async function fishTts(text) {
  const { FISH_API_KEY, FISH_VOICE_ID } = process.env;
  if (!FISH_API_KEY || !FISH_VOICE_ID) {
    throw new Error("CTA clip not stored yet and FISH_API_KEY / FISH_VOICE_ID are not set");
  }
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + FISH_API_KEY,
      "Content-Type": "application/json",
      model: FISH_MODEL,
    },
    body: JSON.stringify({ text, reference_id: FISH_VOICE_ID, format: "mp3" }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("Fish Audio failed (" + res.status + "): " + detail.slice(0, 200));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("Fish Audio returned only " + buf.length + " bytes");
  return buf;
}

async function exists(supabase, objectPath) {
  const dir = path.posix.dirname(objectPath);
  const name = path.posix.basename(objectPath);
  const { data, error } = await supabase.storage.from(CTA_BUCKET).list(dir, { search: name, limit: 100 });
  if (error) throw new Error("could not list " + CTA_BUCKET + "/" + dir + ": " + error.message);
  return (data || []).some((o) => o.name === name);
}

async function download(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(CTA_BUCKET).download(objectPath);
  if (error || !data) throw new Error("could not download " + objectPath + ": " + (error && error.message));
  return Buffer.from(await data.arrayBuffer());
}

/**
 * The stored CTA clip, generating and storing it first if this is the
 * first run ever (or the first since CTA_VERSION changed). Only a
 * confirmed "not there" triggers Fish — a failed lookup never does, so a
 * flaky storage call can't turn into a Fish call on every run.
 */
async function loadCtaClip(supabase) {
  if (!supabase) throw new Error("no Supabase client for the CTA clip");
  if (await exists(supabase, CTA_PATH)) return download(supabase, CTA_PATH);

  log("CTA clip", CTA_PATH, "not found — generating it once with Fish Audio");
  const buf = await fishTts(CTA_TEXT);
  const { error } = await supabase.storage
    .from(CTA_BUCKET)
    .upload(CTA_PATH, buf, { contentType: "audio/mpeg", upsert: false, cacheControl: "31536000" });
  if (error) {
    // Uploads run one at a time (workflow concurrency group), so this is
    // not a race; but if it did already exist, use the stored one.
    if (/exist|duplicate/i.test(error.message || "")) return download(supabase, CTA_PATH);
    // Still usable for this run; next run will try storing it again.
    warn("generated the CTA clip but could not store it:", error.message);
  } else {
    log("stored CTA clip at", CTA_BUCKET + "/" + CTA_PATH, "— later runs reuse it");
  }
  return buf;
}

/* ────────────────────────────── main ────────────────────────────── */

function tempRoot() {
  return process.env.RUNNER_TEMP || os.tmpdir();
}

/**
 * Builds the YouTube copy of one video. Never throws; returns
 * { bytes, applied } where applied=false means `bytes` is the original.
 *
 * opts.getClip: () => Promise<Buffer> — the CTA clip (pass the result of
 *   createCtaClipLoader so every video in a run shares one download).
 */
export async function makeYouTubeVersion(original, opts = {}) {
  let workDir = null;
  try {
    const ffmpeg = await getFfmpegPath();
    const clip = await opts.getClip();

    workDir = await fs.mkdtemp(path.join(tempRoot(), "news30-yt-"));
    await fs.mkdir(path.join(workDir, "fonts"));
    await fs.copyFile(FONT_FILE, path.join(workDir, "fonts", "LiberationSans-Bold.ttf"));
    await fs.writeFile(path.join(workDir, "in.mp4"), original);
    await fs.writeFile(path.join(workDir, "cta.mp3"), clip);

    const src = await probe(ffmpeg, "in.mp4", workDir);
    if (!src.hasVideo || !src.hasAudio || !src.duration || !src.width || !src.height) {
      throw new Error("could not read the original's streams: " + JSON.stringify(src));
    }
    const cta = await probe(ffmpeg, "cta.mp3", workDir);
    if (!cta.hasAudio || !cta.duration) throw new Error("CTA clip is not readable audio");

    const fps = src.fps && src.fps > 0 && src.fps <= 120 ? src.fps : 25;
    const sampleRate = src.sampleRate || 44100;
    const layout = src.channelLayout || "mono";
    const audioKbps = Math.min(192, Math.max(64, src.audioKbps || 96));
    const cardSeconds = Math.min(
      CARD_MAX_SECONDS,
      Math.max(CARD_MIN_SECONDS, VOICE_DELAY_SECONDS + cta.duration + VOICE_TAIL_SECONDS)
    );
    const mainSeconds = src.duration;

    await fs.writeFile(path.join(workDir, "wm.ass"), buildWatermarkAss(), "utf8");
    await fs.writeFile(path.join(workDir, "card.ass"), buildCardAss(cardSeconds), "utf8");

    const afmt = "aformat=sample_fmts=fltp:sample_rates=" + sampleRate + ":channel_layouts=" + layout;
    const vnorm = "setsar=1,fps=" + fps + ",format=yuv420p";
    // Paths are relative to workDir (cwd), so nothing in the filter
    // graph needs escaping whatever the runner's temp path looks like.
    const filter = [
      "[0:v]subtitles=wm.ass:fontsdir=fonts," + vnorm + "[mv]",
      "[1:v]subtitles=card.ass:fontsdir=fonts," + vnorm + "[cv]",
      // Pad/trim the main audio to the video's length so the card's voice
      // can't drift into the story if the narration is a hair short.
      "[0:a]" + afmt + ",apad,atrim=0:" + mainSeconds.toFixed(3) + ",asetpts=N/SR/TB[ma]",
      "[2:a]" + afmt + ",adelay=" + Math.round(VOICE_DELAY_SECONDS * 1000) + ":all=1,apad,atrim=0:" +
        cardSeconds.toFixed(3) + ",asetpts=N/SR/TB[ca]",
      "[mv][ma][cv][ca]concat=n=2:v=1:a=1[v][a]",
    ].join(";");

    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-i", "in.mp4",
      "-f", "lavfi", "-i", "color=c=" + CARD_BG + ":s=" + src.width + "x" + src.height + ":r=" + fps + ":d=" + cardSeconds.toFixed(3),
      "-i", "cta.mp3",
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
      // The render pipeline's own encode settings (api/generate-video.js).
      "-c:v", "libx264", "-preset", "superfast", "-crf", "25",
      "-maxrate", "2500k", "-bufsize", "5000k", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", audioKbps + "k", "-ar", String(sampleRate),
      "-movflags", "+faststart",
      "-y", "out.mp4",
    ], workDir);

    // Sanity check before trusting it with a 1600-unit upload.
    const out = await probe(ffmpeg, "out.mp4", workDir);
    const expected = mainSeconds + cardSeconds;
    if (!out.hasVideo || !out.hasAudio || !out.duration || Math.abs(out.duration - expected) > 0.75) {
      throw new Error("output failed the sanity check (" + (out.duration || "?") + "s, expected ~" + expected.toFixed(2) + "s)");
    }
    const bytes = await fs.readFile(path.join(workDir, "out.mp4"));
    log(
      "YouTube version:", (original.length / 1048576).toFixed(2), "MB →", (bytes.length / 1048576).toFixed(2), "MB,",
      mainSeconds.toFixed(1) + "s + " + cardSeconds.toFixed(1) + "s end card"
    );
    return { bytes, applied: true };
  } catch (e) {
    warn("skipping the YouTube CTA, uploading the original video:", String((e && e.message) || e).slice(0, 400));
    return { bytes: original, applied: false };
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One shared, lazily-loaded CTA clip per run. A failure is cached too,
 * so a broken asset costs one warning per video, not one Fish call each.
 */
export function createCtaClipLoader(supabase) {
  let p = null;
  return () => (p || (p = loadCtaClip(supabase)));
}

export const CTA_ASSET = { bucket: CTA_BUCKET, path: CTA_PATH, text: CTA_TEXT };
