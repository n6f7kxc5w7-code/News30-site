// /api/generate-video.js
// 🔌 STEP 3 OF THE VIDEO PIPELINE — the final assembly step.
// Takes a job that already has narration audio (from /api/generate-audio.js),
// fetches relevant real images from Pexels, builds a Shotstack timeline
// (audio + a sequence of images with a gentle Ken Burns zoom), and submits
// it to Shotstack's render queue.
//
// Rendering is NOT instant — Shotstack renders in the background and
// calls our webhook (/api/video-webhook.js) when it's done. So this
// function only *starts* the render; it doesn't wait for the finished
// video. The video_jobs row moves to status "rendering" here, and the
// webhook moves it to "done" (or "failed") later.
//
// Required Vercel env vars (server-only, no "VITE_" prefix):
//   SHOTSTACK_API_KEY
//   PEXELS_API_KEY
//   SUPABASE_SERVICE_ROLE_KEY   (already added for generate-audio.js)
// Reuses VITE_SUPABASE_URL (safe — it's just the project URL).
//
// IMPORTANT: update PUBLIC_SITE_URL below to your real deployed domain
// once you know it's stable — Shotstack needs a real public URL to
// call back to when the render finishes.

import { createClient } from "@supabase/supabase-js";

const PUBLIC_SITE_URL = "https://news30.live";
const VIDEO_DURATION_SECONDS = 30;
const IMAGE_COUNT = 5; // 30s / 5 = 6s per image

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

  // Pad by repeating if Pexels gave us fewer than requested (rare, but keeps timing simple).
  while (photos.length < count) photos.push(photos[photos.length % photos.length || 0]);
  return photos.slice(0, count);
}

function buildTimeline(audioUrl, images) {
  const clipLength = VIDEO_DURATION_SECONDS / images.length;

  const imageClips = images.map((src, i) => ({
    asset: { type: "image", src },
    start: i * clipLength,
    length: clipLength,
    effect: i % 2 === 0 ? "zoomIn" : "zoomOut", // gentle Ken Burns, alternating for variety
    transition: { in: "fade", out: "fade" },
  }));

  return {
    background: "#000000",
    tracks: [
      { clips: [{ asset: { type: "audio", src: audioUrl }, start: 0, length: VIDEO_DURATION_SECONDS }] },
      { clips: imageClips },
    ],
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const { jobId, headline, category } = req.body || {};
  if (!jobId || !headline) {
    res.status(400).json({ error: "jobId and headline are both required" });
    return;
  }

  const shotstackKey = process.env.SHOTSTACK_API_KEY;
  const pexelsKey = process.env.PEXELS_API_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!shotstackKey || !pexelsKey || !supabaseUrl || !serviceKey) {
    res.status(500).json({
      error: "Missing server config",
      missing: {
        SHOTSTACK_API_KEY: !shotstackKey,
        PEXELS_API_KEY: !pexelsKey,
        VITE_SUPABASE_URL: !supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: !serviceKey,
      },
    });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Load the job — it must already have audio_url from the previous step.
  const { data: job, error: fetchErr } = await supabase
    .from("video_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (fetchErr || !job) {
    res.status(404).json({ error: "Job not found: " + (fetchErr ? fetchErr.message : jobId) });
    return;
  }
  if (!job.audio_url) {
    res.status(400).json({ error: "This job has no audio yet — run /api/generate-audio.js first" });
    return;
  }

  try {
    // 1) Real images matched to the story topic (category gives Pexels
    //    better search context than the headline alone would).
    const searchQuery = (category ? category + " " : "") + headline;
    const images = await fetchPexelsImages(searchQuery, IMAGE_COUNT, pexelsKey);

    // 2) Build and submit the Shotstack render.
    const timeline = buildTimeline(job.audio_url, images);
    const renderBody = {
      timeline,
      output: { format: "mp4", size: { width: 1080, height: 1920 } }, // vertical, matches News30's player
      callback: PUBLIC_SITE_URL + "/api/video-webhook",
    };

    const shotstackRes = await fetch("https://api.shotstack.io/stage/render", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": shotstackKey },
      body: JSON.stringify(renderBody),
    });

    const shotstackData = await shotstackRes.json();
    if (!shotstackRes.ok || !shotstackData.success) {
      throw new Error("Shotstack render request failed: " + JSON.stringify(shotstackData));
    }

    const renderId = shotstackData.response.id;

    // 3) Mark the job as rendering — the webhook will flip this to
    //    "done" (with video_url) or "failed" once Shotstack finishes.
    await supabase
      .from("video_jobs")
      .update({ status: "rendering", shotstack_render_id: renderId, updated_at: new Date().toISOString() })
      .eq("id", jobId);

    res.status(200).json({ jobId, renderId, status: "rendering" });
  } catch (e) {
    await supabase
      .from("video_jobs")
      .update({ status: "failed", error: String(e), updated_at: new Date().toISOString() })
      .eq("id", jobId);

    res.status(500).json({ error: String(e) });
  }
}
