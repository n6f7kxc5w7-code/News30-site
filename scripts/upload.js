// scripts/upload.js
// 📤 STAGE 3 OF THE PIPELINE — takes finished renders and puts them on
// YouTube as PRIVATE videos scheduled to publish themselves
// PUBLISH_DELAY_HOURS later. Run by .github/workflows/upload.yml.
//
// Deliberately NOT a Vercel function. A resumable video upload is a
// multi-megabyte PUT that can take a minute on its own, on top of a
// render that already eats most of the 60s budget. GitHub Actions gets
// six hours, which is the right shape for this.
//
// ─── WHY EVERYTHING GOES UP PRIVATE ─────────────────────────────────
// DeepSeek writes claims about real, named people from a headline
// alone, and the script prompt has been tuned to be punchy — which is
// exactly the condition under which a model hardens a hedge or rounds a
// number. A wrong hook about a politician, published unattended, is a
// different class of problem from a bad retention curve, and it goes
// out under a real name on a real channel.
//
// So every video goes up private with status.publishAt set to
// PUBLISH_DELAY_HOURS (default 3) after upload, and YouTube publishes it
// automatically at that time. That delay IS the safety net now: it is
// the window to watch the draft in Studio and stop a bad one (open it →
// Visibility → Private, which clears the schedule) before it goes out.
// Nothing stops a video that nobody looks at — set PUBLISH_DELAY_HOURS
// to a window you will actually check.
//
// publishAt only works for videos the channel is allowed to make public:
// uploads from an API project that hasn't passed YouTube's API audit are
// locked to private, and then the schedule never takes effect.
//
// ─── QUOTA IS THE BINDING CONSTRAINT ────────────────────────────────
// A videos.insert costs 1600 quota units. The default daily allowance
// is 10,000. That is SIX uploads per day, total, with 400 units of
// headroom for nothing else. There is no clever way around it: a failed
// upload that retries still spends the quota. MAX_PER_RUN exists to
// make that ceiling explicit rather than something you discover at 3am
// via a 403.
//
// Optional repo variable: PUBLISH_DELAY_HOURS (hours from upload to
// automatic publish, default 3; fractions allowed, e.g. 0.5).
//
// Required GitHub repo secrets:
//   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional (only used once, to create the stored spoken CTA clip):
//   FISH_API_KEY, FISH_VOICE_ID
//
// YouTube copies get a watermark + "Test yourself → news30.live" end
// card with a spoken line (scripts/youtube-cta.js). The site's video is
// untouched; if that step fails for any reason, the original is uploaded.
//
// Required migration:
//   alter table published_stories
//     add column if not exists youtube_id text,
//     add column if not exists youtube_uploaded_at timestamptz,
//     add column if not exists youtube_error text;
// plus youtube_title / entities — see api/_optional-columns.js. Until
// those exist, uploads fall back to the cleaned headline and category.
//
// Title, description, tags and category are built in
// scripts/youtube-metadata.js.

import { createClient } from "@supabase/supabase-js";
import { buildSnippet } from "./youtube-metadata.js";
import { makeYouTubeVersion, createCtaClipLoader } from "./youtube-cta.js";
import { isMissingColumn } from "../api/_optional-columns.js";

// Six is the hard quota ceiling (6 × 1600 = 9600 of 10000). Lower it if
// you also want to spend quota on anything else that day.
const MAX_PER_RUN = 3;

// Only upload news that is still news. The pipeline renders far more
// stories a day than the quota can upload, so the old oldest-first
// queue meant every draft was already 2–3 days stale.
const MAX_AGE_HOURS = 36;

// Hours from upload to YouTube's automatic publish. Anything that isn't a
// positive number (unset, "", "abc", "0", "-1") falls back to 3, with a
// warning if something was set: publishAt must be in the future, and a
// typo must never mean "publish immediately".
const DEFAULT_PUBLISH_DELAY_HOURS = 3;
const PUBLISH_DELAY_HOURS = (() => {
  const raw = (process.env.PUBLISH_DELAY_HOURS || "").trim();
  if (!raw) return DEFAULT_PUBLISH_DELAY_HOURS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  console.warn("[upload] ⚠️ PUBLISH_DELAY_HOURS=" + JSON.stringify(raw) + " is not a positive number — using " + DEFAULT_PUBLISH_DELAY_HOURS);
  return DEFAULT_PUBLISH_DELAY_HOURS;
})();

const {
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

for (const [name, value] of Object.entries({
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
})) {
  if (!value) {
    console.error("[upload] missing secret:", name);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// The spoken CTA clip, downloaded at most once per run and shared.
const getCtaClip = createCtaClipLoader(supabase);

/* Refresh tokens are long-lived; access tokens last an hour. Exchanging
   one for the other on every run is simpler and safer than caching an
   access token somewhere it could leak. */
async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_CLIENT_SECRET,
      refresh_token: YOUTUBE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Never log the response body — it can echo credential material.
    console.error("[upload] token refresh failed:", res.status, data.error || "");
    if (data.error === "invalid_grant") {
      console.error(
        "[upload] invalid_grant usually means the refresh token was revoked, " +
        "or you were removed as a test user on the OAuth consent screen. " +
        "Re-run scripts/get-refresh-token.js."
      );
    }
    throw new Error("Could not obtain access token");
  }
  return data.access_token;
}

async function uploadOne(story, accessToken) {
  // The Supabase media bucket is public, so no auth header needed here.
  const videoRes = await fetch(story.video_url);
  if (!videoRes.ok) throw new Error("could not fetch video (" + videoRes.status + ")");
  const original = Buffer.from(await videoRes.arrayBuffer());
  console.log("[upload] fetched", (original.length / 1048576).toFixed(1), "MB");

  // YouTube-only watermark + end card + spoken CTA. Never throws: on any
  // problem it logs a warning and hands back the original bytes.
  const { bytes } = await makeYouTubeVersion(original, { getClip: getCtaClip });

  // ISO 8601 UTC, e.g. 2026-11-26T14:05:00.000Z. Computed per video, just
  // before its upload starts.
  const publishAt = new Date(Date.now() + PUBLISH_DELAY_HOURS * 3600 * 1000).toISOString();

  const metadata = {
    // title (youtube_title or cleaned headline + " #Shorts"), description
    // (summary → site link → script → source → hashtags), tags, category
    // 17 Sports / 25 News & Politics, language "en".
    snippet: buildSnippet(story),
    status: {
      // Private until publishAt, then YouTube makes it public by itself.
      // YouTube only honours publishAt on private videos, so this must
      // stay "private". Do not set "public": that skips the review window.
      privacyStatus: "private",
      publishAt,
      selfDeclaredMadeForKids: false,
    },
  };

  // Step 1: open a resumable session. Returns a URL in the Location
  // header. Sending metadata separately from bytes means a rejected
  // title fails here, before uploading megabytes for nothing.
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(bytes.length),
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const detail = await initRes.text().catch(() => "");
    if (initRes.status === 403 && /quota/i.test(detail)) {
      throw new Error("QUOTA_EXCEEDED");
    }
    throw new Error("session init failed (" + initRes.status + "): " + detail.slice(0, 200));
  }

  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) throw new Error("no upload session URL returned");

  // Step 2: send the bytes. One shot — these are ~2MB files, so there is
  // no value in chunking and resuming.
  const putRes = await fetch(sessionUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) },
    body: bytes,
  });

  const result = await putRes.json().catch(() => ({}));
  if (!putRes.ok || !result.id) {
    throw new Error("upload failed (" + putRes.status + "): " + JSON.stringify(result).slice(0, 200));
  }

  return { id: result.id, publishAt };
}

async function main() {
  // Newest first, and never a story that already failed once. Before,
  // the queue was oldest-first and retried failures forever, so one
  // broken story (e.g. its file already deleted by storage cleanup) sat
  // at the front and blocked every upload behind it — while the run
  // still showed a green tick. `youtube_id is null` keeps it idempotent.
  const since = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();
  const BASE_COLS = "id, headline, script, category, source, article_url, video_url";
  const queue = (cols) =>
    supabase
      .from("published_stories")
      .select(cols)
      .eq("status", "ready")
      .is("youtube_id", null)
      .is("youtube_error", null)
      .not("video_url", "is", null)
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(MAX_PER_RUN);

  let { data: stories, error } = await queue(BASE_COLS + ", youtube_title, entities");
  if (error && isMissingColumn(error, ["youtube_title", "entities"])) {
    console.warn("[upload] youtube_title/entities columns missing — using headline + category. Run the migration in api/_optional-columns.js.");
    ({ data: stories, error } = await queue(BASE_COLS));
  }

  if (error) {
    console.error("[upload] could not read queue:", error.message);
    process.exit(1);
  }

  if (!stories || !stories.length) {
    // Say WHY it's empty, so an empty run is never a mystery again.
    const { count } = await supabase
      .from("published_stories")
      .select("id", { count: "exact", head: true })
      .eq("status", "ready")
      .gte("updated_at", since);
    console.log(
      "[upload] nothing to upload —", count ?? "?", "stories went ready in the last",
      MAX_AGE_HOURS + "h (all already uploaded or failed). If that number is 0, " +
      "the render pipeline is the problem, not this script."
    );
    return;
  }

  console.log("[upload]", stories.length, "video(s) to upload");
  const accessToken = await getAccessToken();

  let uploaded = 0;
  let failed = 0;
  for (const story of stories) {
    console.log("[upload] →", (story.headline || "").slice(0, 70));
    try {
      const { id: youtubeId, publishAt } = await uploadOne(story, accessToken);

      await supabase
        .from("published_stories")
        .update({
          youtube_id: youtubeId,
          youtube_uploaded_at: new Date().toISOString(),
          youtube_error: null,
        })
        .eq("id", story.id);

      uploaded++;
      console.log("[upload] ✅ uploaded (private): https://studio.youtube.com/video/" + youtubeId + "/edit");
      console.log("[upload]    publishes automatically at " + publishAt + " (in " + PUBLISH_DELAY_HOURS + "h)");
    } catch (e) {
      const message = String(e.message || e);

      // Quota is not a per-story failure, it is a stop condition. Trying
      // the next one just burns the retry for nothing.
      if (message === "QUOTA_EXCEEDED") {
        console.error("[upload] daily quota exhausted — stopping. Remaining stories stay queued.");
        break;
      }

      failed++;
      console.error("[upload] ❌ failed:", message);
      // Recorded but youtube_id stays null, so the next run picks it up
      // again. A genuinely broken video will keep reappearing, which is
      // visible in the logs rather than silently dropped.
      await supabase
        .from("published_stories")
        .update({ youtube_error: message.slice(0, 500) })
        .eq("id", story.id);
    }
  }

  console.log("[upload] done —", uploaded, "uploaded,", failed, "failed");
  // Every story failed → turn the run RED so GitHub emails you, instead
  // of a green tick hiding a dead pipeline for days.
  if (failed && !uploaded) process.exit(1);
  if (uploaded) {
    console.log(
      "[upload] they publish themselves in " + PUBLISH_DELAY_HOURS + "h. To stop one, open it in Studio → " +
      "Visibility → Private (clears the schedule): https://studio.youtube.com → Content"
    );
  }
}

main().catch((e) => {
  console.error("[upload] fatal:", e.message || e);
  process.exit(1);
});
