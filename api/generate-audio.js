// /api/generate-audio.js
// 🔌 STEP 2 OF THE VIDEO PIPELINE — turns a script into narration audio.
// Runs server-side only (Vercel Node.js function), same reasoning as
// /api/news.js: keeps FISH_API_KEY and the Supabase service_role key
// out of the browser entirely.
//
// Flow: create a video_jobs row -> call Fish Audio TTS -> upload the
// resulting MP3 to Supabase Storage (public "media" bucket) -> save
// the public URL back onto the job row -> return it to the caller.
//
// Required Vercel env vars (all server-only, NO "VITE_" prefix):
//   FISH_API_KEY               — from fish.audio account settings
//   FISH_VOICE_ID               — the "Energetic Male" voice's reference_id
//   SUPABASE_SERVICE_ROLE_KEY   — Settings -> API -> service_role
// Reuses the existing VITE_SUPABASE_URL (safe to reuse — it's just the
// project URL, not a secret).

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // CORS: allows this endpoint to be called from a different origin
  // (needed for the pipeline test harness; harmless for the real app
  // too, since it calls its own domain anyway).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const { storyId, script } = req.body || {};
  if (!storyId || !script) {
    res.status(400).json({ error: "storyId and script are both required" });
    return;
  }

  const fishKey = process.env.FISH_API_KEY;
  const voiceId = process.env.FISH_VOICE_ID;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!fishKey || !voiceId || !supabaseUrl || !serviceKey) {
    res.status(500).json({
      error: "Missing server config",
      missing: {
        FISH_API_KEY: !fishKey,
        FISH_VOICE_ID: !voiceId,
        VITE_SUPABASE_URL: !supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: !serviceKey,
      },
    });
    return;
  }

  // service_role client — full backend access, never expose this key elsewhere.
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1) Create the job row up front, so there's a record even if a later step fails.
  const { data: job, error: insertErr } = await supabase
    .from("video_jobs")
    .insert({ story_id: storyId, status: "generating_audio", script })
    .select()
    .single();

  if (insertErr) {
    res.status(500).json({ error: "Failed to create job: " + insertErr.message });
    return;
  }

  try {
    // 2) Fish Audio TTS — returns raw MP3 bytes directly in the response body.
    const ttsRes = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + fishKey,
        "Content-Type": "application/json",
        model: "s2-pro",
      },
      body: JSON.stringify({
        text: script,
        reference_id: voiceId,
        format: "mp3",
      }),
    });

    if (!ttsRes.ok) {
      const detail = await ttsRes.text().catch(() => "");
      throw new Error("Fish Audio TTS failed: " + ttsRes.status + " " + detail);
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());

    // 3) Upload the MP3 into the public "media" bucket under a unique path.
    const filePath = "narration/" + job.id + ".mp3";
    const { error: uploadErr } = await supabase.storage
      .from("media")
      .upload(filePath, audioBuffer, { contentType: "audio/mpeg", upsert: true });

    if (uploadErr) throw new Error("Storage upload failed: " + uploadErr.message);

    // 4) Get the public URL (bucket is public, so this is a stable, permanent link).
    const { data: publicUrlData } = supabase.storage.from("media").getPublicUrl(filePath);
    const audioUrl = publicUrlData.publicUrl;

    // 5) Mark the job ready for the next pipeline stage (video assembly).
    await supabase
      .from("video_jobs")
      .update({ status: "audio_ready", audio_url: audioUrl, updated_at: new Date().toISOString() })
      .eq("id", job.id);

    res.status(200).json({ jobId: job.id, audioUrl });
  } catch (e) {
    // Record the failure on the job row so the UI/dashboard can show what broke.
    await supabase
      .from("video_jobs")
      .update({ status: "failed", error: String(e), updated_at: new Date().toISOString() })
      .eq("id", job.id);

    res.status(500).json({ error: String(e), jobId: job.id });
  }
}
