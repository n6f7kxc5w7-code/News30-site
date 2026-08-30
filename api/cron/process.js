// /api/cron/process.js
// 🎬 STAGE 2 OF THE AUTOMATED PIPELINE — turns one queued story into a
// finished, published video.
//
// Handles exactly ONE story per invocation, then returns. That design is
// forced by Vercel's function time limit: nine renders cannot happen in
// one request, and a loop would be killed partway through leaving rows
// stuck in `generating`.
//
// ─── WHY THIS NO LONGER SELF-CHAINS ──────────────────────────────
// It used to call itself for the next story, awaiting each kick long
// enough to confirm the request was accepted. That was written when
// Vercel Cron drove the pipeline and its Hobby-plan frequency limit
// meant nine stories could otherwise take days to clear.
//
// It broke. Because the parent awaited the kick, each link stayed alive
// while its child ran, so the invocations NESTED rather than running one
// after another — up to MAX_CHAIN deep, with generate-audio and
// generate-video nested inside each level again. Vercel detects a
// function chain that recurses into itself and refuses it, returning a
// 508 whose body is the plain text `Infinite loop detected`. The next
// line here was `await audioRes.json()`, which threw:
//
//     Unexpected token 'I', "Infinite l"... is not valid JSON
//
// That error is what filled the `error` column on published_stories from
// 26 August onward. The stories were never scripted, so they never
// reached `ready`, so the site's feed — which reads `ready` rows —
// froze at the 26th while video_jobs kept happily draining older work
// and looked healthy the whole time.
//
// The original reason for chaining is also gone: the pipeline moved off
// Vercel Cron to GitHub Actions, which has no frequency limit worth
// worrying about. So the loop now lives OUTSIDE the function, in
// .github/workflows/process.yml, which pokes this endpoint once a
// minute. Every poke is a fresh external request, so Vercel never sees
// a function invoking itself and the queue still drains in minutes.
//
// Security: requires CRON_SECRET, same as ingest.
//
// Requires: alter table published_stories add column if not exists quiz jsonb;
//           alter table published_stories add column if not exists description text;

import { createClient } from "@supabase/supabase-js";

const MAX_ATTEMPTS = 2;   // one retry, then leave it alone

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
      // Not an error, and the workflow keeps poking regardless — an
      // empty queue simply means this poke had nothing to do.
      console.log("[process] queue empty");
      res.status(200).json({ ok: true, done: true });
      return;
    }

    // Claim it immediately. The workflow pokes once a minute and a
    // render can outlast that, so overlapping invocations are now
    // NORMAL rather than exceptional: whichever writes second finds the
    // row already claimed and picks up the next one instead.
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
      // the DeepSeek path, which returns the script, the stock-photo
      // search phrases AND the quiz questions in one call.
      //
      // `description` is NewsAPI's own summary of the article, stored by
      // ingest.js. It is the difference between a full-length script and
      // a stub: without it the model has only the headline, and since
      // the prompt forbids inventing detail it simply stops early —
      // measured at 18 to 57 words against a 65-75 target. Rows queued
      // before the column existed send null and fall back to the old
      // headline-only behaviour rather than failing.
      const audioRes = await fetch(base + "/api/generate-audio", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pipeline-secret": secret, // bypasses the public rate limit
        },
        body: JSON.stringify({
          storyId: story.id,
          headline: story.headline,
          description: story.description || null,
          category: story.category,
        }),
      });

      // Read as text first, then parse. A non-JSON body here used to
      // throw a raw SyntaxError whose message ("Unexpected token 'I'…")
      // said nothing about where it came from, and that cost days of
      // looking in the wrong place. Now the status and the first part of
      // the body reach the logs and the error column intact.
      const audioText = await audioRes.text();
      let audioData;
      try {
        audioData = JSON.parse(audioText);
      } catch {
        throw new Error(
          "generate-audio returned non-JSON (" + audioRes.status + "): " +
          audioText.slice(0, 200)
        );
      }
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

      const videoText = await videoRes.text();
      let videoData;
      try {
        videoData = JSON.parse(videoText);
      } catch {
        throw new Error(
          "generate-video returned non-JSON (" + videoRes.status + "): " +
          videoText.slice(0, 200)
        );
      }
      if (!videoRes.ok) throw new Error(videoData.error || "render failed");

      // ── Publish ─────────────────────────────────────────────────
      // Only now does the story appear on the site: status flips to
      // `ready`, which is the exact condition the RLS read policy and
      // the front-end query both check. There is no window where a
      // half-finished story is visible.
      //
      // The quiz is copied onto the story row rather than left on the
      // job row, because the front end only ever reads published_stories
      // — a join would mean a second query on every feed load.
      //
      // script_prompt_version comes back from generate-audio and is
      // stored here too, so a batch of videos can be grouped by which
      // prompt wrote them when comparing retention later. Without it,
      // two weeks of output is indistinguishable and the comparison is
      // unrecoverable.
      await supabase
        .from("published_stories")
        .update({
          status: "ready",
          script: audioData.script,
          script_prompt_version: audioData.scriptPromptVersion || null,
          image_queries: audioData.imageQueries || null,
          quiz: (audioData.quiz && audioData.quiz.length) ? audioData.quiz : null,
          audio_url: audioData.audioUrl,
          video_url: videoData.videoUrl,
          thumbnail_url: videoData.thumbnailUrl || null,
          duration_seconds: videoData.durationSeconds || null,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", story.id);

      /* Word count and resulting duration, logged together. This is the
         pair to watch: if scripts are long but videos are still short,
         the narration is being cut off in the render and the prompt is
         not the problem. */
      const words = (audioData.script || "").split(/\s+/).filter(Boolean).length;
      console.log(
        "[process] published:", story.headline.slice(0, 50),
        "—", words + "w,", (videoData.durationSeconds || "?") + "s,",
        story.description ? "had summary" : "HEADLINE ONLY"
      );
    } catch (e) {
      const message = String(e.message || e).slice(0, 500);
      console.error("[process] story failed:", story.id, message);

      // Below MAX_ATTEMPTS it goes back to pending and will be retried
      // on a later poke; at the limit it is marked failed and skipped,
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

    // One story, then stop. The next one is picked up by the next poke
    // from the workflow — see the header comment for why this is no
    // longer a self-call.
    res.status(200).json({ ok: true, processed: story.id });
  } catch (e) {
    console.error("[process] fatal:", e);
    res.status(500).json({ error: "Worker failed" });
  }
}
