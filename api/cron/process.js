// /api/cron/process.js
// 🎬 STAGE 2 OF THE AUTOMATED PIPELINE — turns one queued story into a
// finished, published video.
//
// Handles exactly ONE story per invocation, then calls itself for the
// next. That design is forced by Vercel's function time limit: nine
// renders cannot happen in one request, and a loop would be killed
// partway through leaving rows stuck in `generating`.
//
// ─── WHY SELF-CHAINING RATHER THAN A FREQUENT CRON ───────────────
// The obvious alternative is a cron that fires every few minutes and
// takes one job each time. Vercel's Hobby plan restricts how often cron
// can run, so nine stories could take days to clear. Chaining sidesteps
// the frequency limit entirely: each invocation is a fresh function
// with a fresh time budget, and the queue drains in minutes.
//
// The chain terminates on its own — there is no next call when nothing
// is pending. MAX_CHAIN is a second guard so a bug cannot produce an
// endless loop spending money.
//
// Security: requires CRON_SECRET, same as ingest.

import { createClient } from "@supabase/supabase-js";

const MAX_ATTEMPTS = 2;   // one retry, then leave it alone
const MAX_CHAIN = 12;     // hard stop; 9 stories plus headroom

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[process] CRON_SECRET not configured");
    res.status(500).json({ error: "Not configured" });
    return;
  }
  if (req.headers.authorization !== "Bearer " + secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (process.env.PIPELINE_ENABLED === "false") {
    res.status(503).json({ error: "Pipeline is currently disabled" });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: "Server is not configured" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const base = "https://" + (req.headers.host || "news30.live");
  const chainDepth = parseInt(req.headers["x-chain-depth"] || "0", 10);

  if (chainDepth >= MAX_CHAIN) {
    console.warn("[process] chain depth limit reached — stopping");
    res.status(200).json({ ok: true, stopped: "chain limit" });
    return;
  }

  try {
    // Rows stuck in `generating` mean a previous invocation died
    // mid-render — a timeout, a crash, a deploy. Without this they
    // would block the queue forever. Ten minutes is comfortably longer
    // than any successful render.
    await supabase
      .from("published_stories")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("status", "generating")
      .lt("updated_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

    // Oldest pending story first, so the queue is fair and a repeatedly
    // failing story cannot starve the others.
    const { data: story, error: pickErr } = await supabase
      .from("published_stories")
      .select("*")
      .eq("status", "pending")
      .lt("attempts", MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (pickErr) throw pickErr;

    if (!story) {
      console.log("[process] queue empty");
      res.status(200).json({ ok: true, done: true });
      return;
    }

    // Claim it immediately. If two invocations ever overlap, whichever
    // writes second finds the row already claimed on its next poll.
    await supabase
      .from("published_stories")
      .update({
        status: "generating",
        attempts: story.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", story.id);

    console.log("[process] starting:", story.category, "—", story.headline.slice(0, 70));

    let jobId = null;

    try {
      // ── Script + narration ──────────────────────────────────────
      // Passing headline and category (not a script) is what triggers
      // the Gemini path, which returns the script AND the stock-photo
      // search phrases in one call.
      const audioRes = await fetch(base + "/api/generate-audio", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pipeline-secret": secret, // bypasses the public rate limit
        },
        body: JSON.stringify({
          storyId: story.id,
          headline: story.headline,
          category: story.category,
        }),
      });

      const audioData = await audioRes.json();
      if (!audioRes.ok) throw new Error(audioData.error || "audio failed");
      jobId = audioData.jobId;

      // ── Render ──────────────────────────────────────────────────
      const videoRes = await fetch(base + "/api/generate-video", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pipeline-secret": secret,
        },
        body: JSON.stringify({
          jobId,
          headline: story.headline,
          category: story.category,
        }),
      });

      const videoData = await videoRes.json();
      if (!videoRes.ok) throw new Error(videoData.error || "render failed");

      // ── Publish ─────────────────────────────────────────────────
      // Only now does the story appear on the site: status flips to
      // `ready`, which is the exact condition the RLS read policy and
      // the front-end query both check. There is no window where a
      // half-finished story is visible.
      await supabase
        .from("published_stories")
        .update({
          status: "ready",
          script: audioData.script,
          image_queries: audioData.imageQueries || null,
          audio_url: audioData.audioUrl,
          video_url: videoData.videoUrl,
          thumbnail_url: videoData.thumbnailUrl || null,
          duration_seconds: videoData.durationSeconds || null,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", story.id);

      console.log("[process] published:", story.headline.slice(0, 70));
    } catch (e) {
      const message = String(e.message || e).slice(0, 500);
      console.error("[process] story failed:", story.id, message);

      // Below MAX_ATTEMPTS it goes back to pending and will be retried
      // on a later pass; at the limit it is marked failed and skipped,
      // so one broken story cannot consume the whole budget.
      const exhausted = story.attempts + 1 >= MAX_ATTEMPTS;
      await supabase
        .from("published_stories")
        .update({
          status: exhausted ? "failed" : "pending",
          error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", story.id);
    }

    // Chain to the next story. Fire-and-forget — waiting would nest the
    // whole remaining queue inside this one request's time budget.
    fetch(base + "/api/cron/process", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret,
        "x-chain-depth": String(chainDepth + 1),
      },
    }).catch(() => {});

    res.status(200).json({ ok: true, processed: story.id });
  } catch (e) {
    console.error("[process] fatal:", e);
    res.status(500).json({ error: "Worker failed" });
  }
}
