// /api/job-status.js
// 🔌 Lets the frontend (or this test harness) check a video_jobs row's
// current progress: pending -> generating_audio -> audio_ready ->
// rendering -> done (or failed at any step, see `error`).
// GET /api/job-status?jobId=...

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  const jobId = req.query && req.query.jobId;
  if (!jobId) {
    res.status(400).json({ error: "jobId query param is required" });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: "Missing server config" });
    return;
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data, error } = await supabase
    .from("video_jobs")
    .select("id, status, audio_url, video_url, error, created_at, updated_at")
    .eq("id", jobId)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.status(200).json(data);
}
