// /api/video-webhook.js
// 🔌 STEP 4 — completes the pipeline. Shotstack calls THIS endpoint
// automatically (server-to-server, no user involved) once a render
// finishes or fails — that's what the "callback" field we set in
// /api/generate-video.js points to. This is what makes the whole
// pipeline "automatic": nobody has to check back and refresh anything.
//
// Required Vercel env vars (already added, reused here):
//   SUPABASE_SERVICE_ROLE_KEY
// Reuses VITE_SUPABASE_URL.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: "Missing server config" });
    return;
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // Shotstack's webhook payload shape (per their docs): the render id
  // and status live at the top level, with the finished asset URL
  // inside `response` once status is "done".
  const body = req.body || {};
  const renderId = body.id;
  const status = body.status; // "queued" | "rendering" | "done" | "failed"

  if (!renderId) {
    res.status(400).json({ error: "No render id in webhook payload" });
    return;
  }

  // Find the job this render belongs to.
  const { data: job, error: findErr } = await supabase
    .from("video_jobs")
    .select("id")
    .eq("shotstack_render_id", renderId)
    .single();

  if (findErr || !job) {
    // Don't error loudly here — Shotstack will retry webhooks, and an
    // unmatched render id isn't actionable on our end.
    res.status(200).json({ received: true, matched: false });
    return;
  }

  if (status === "done") {
    const videoUrl = body.url || (body.response && body.response.url);
    await supabase
      .from("video_jobs")
      .update({ status: "done", video_url: videoUrl, updated_at: new Date().toISOString() })
      .eq("id", job.id);
  } else if (status === "failed") {
    await supabase
      .from("video_jobs")
      .update({ status: "failed", error: JSON.stringify(body.data || body), updated_at: new Date().toISOString() })
      .eq("id", job.id);
  }
  // "queued" / "rendering" intermediate callbacks: nothing to update yet.

  res.status(200).json({ received: true, matched: true });
}
