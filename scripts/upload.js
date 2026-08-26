// scripts/upload.js
// 📤 STAGE 3 OF THE PIPELINE — takes finished renders and puts them on
// YouTube as PRIVATE drafts. Run by .github/workflows/upload.yml.
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
// So this automates the mechanical part (render → upload → metadata)
// and stops at the one step that needs judgement. Reviewing a batch of
// private drafts in Studio and scheduling the good ones takes about two
// minutes, once. That is the whole point: kill the daily grind, keep
// the safety net.
//
// ─── QUOTA IS THE BINDING CONSTRAINT ────────────────────────────────
// A videos.insert costs 1600 quota units. The default daily allowance
// is 10,000. That is SIX uploads per day, total, with 400 units of
// headroom for nothing else. There is no clever way around it: a failed
// upload that retries still spends the quota. MAX_PER_RUN exists to
// make that ceiling explicit rather than something you discover at 3am
// via a 403.
//
// Required GitHub repo secrets:
//   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Required migration:
//   alter table published_stories
//     add column if not exists youtube_id text,
//     add column if not exists youtube_uploaded_at timestamptz,
//     add column if not exists youtube_error text;

import { createClient } from "@supabase/supabase-js";

// Six is the hard quota ceiling (6 × 1600 = 9600 of 10000). Lower it if
// you also want to spend quota on anything else that day.
const MAX_PER_RUN = 3;

// YouTube truncates hard at 100 characters and rejects < > outright.
const TITLE_LIMIT = 100;

// News & Politics. Sports stories still fit here comfortably — the
// category mostly affects which shelf YouTube files it under, not
// distribution.
const CATEGORY_ID = "25";

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

/* ─── TEMPORARY DIAGNOSTIC — DELETE ONCE THE URL IS FIXED ────────────
   "Invalid path specified in request URL" means SUPABASE_URL is
   malformed rather than merely wrong: the client builds every request
   path off it, so a trailing slash, a stray newline, or the anon key
   pasted in by mistake all produce that same unhelpful message.

   None of this leaks anything. The project URL is public — it appears
   in every request the website makes from the browser. The KEY is
   never printed, only whether it looks like the right SHAPE, because
   pasting the URL and key into each other's slots is an easy mistake
   and produces exactly this error. */
console.log("[diag] SUPABASE_URL length:", SUPABASE_URL.length);
console.log("[diag] starts with https:// :", SUPABASE_URL.startsWith("https://"));
console.log("[diag] ends with .supabase.co :", SUPABASE_URL.endsWith(".supabase.co"));
// JSON.stringify is what makes an invisible \n or a trailing space
// visible — without it the log looks completely normal.
console.log("[diag] last 30 chars:", JSON.stringify(SUPABASE_URL.slice(-30)));
console.log("[diag] has whitespace anywhere:", /\s/.test(SUPABASE_URL));
console.log("[diag] service key length:", SUPABASE_SERVICE_ROLE_KEY.length);
console.log(
  "[diag] service key shape:",
  SUPABASE_SERVICE_ROLE_KEY.startsWith("eyJ") ? "legacy JWT (expected)"
    : SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_secret_") ? "new-style secret key"
    : SUPABASE_SERVICE_ROLE_KEY.startsWith("https://") ? "⚠️ this is a URL, not a key — secrets are swapped"
    : "⚠️ unrecognised"
);
/* ─── END DIAGNOSTIC ─────────────────────────────────────────────── */

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

function buildTitle(story) {
  // The headline regex in ingest.js strips a trailing " - Reuters" but
  // not a leading "Exclusive | ". Both are outlet furniture and neither
  // belongs in a Shorts title.
  let title = (story.headline || "")
    .replace(/^\s*(exclusive|breaking|analysis|opinion|watch|video|live)\s*[|:—–-]\s*/i, "")
    .replace(/\s+[-|–—]\s+[^-|–—]+$/, "")
    .replace(/[<>]/g, "")
    .trim();

  // #Shorts in the title is not required — YouTube classifies by aspect
  // ratio and duration — but it costs nothing and still helps surfacing.
  const suffix = " #Shorts";
  if (title.length + suffix.length > TITLE_LIMIT) {
    title = title.slice(0, TITLE_LIMIT - suffix.length - 1).trimEnd() + "…";
  }
  return title + suffix;
}

function buildDescription(story) {
  const lines = [];
  if (story.script) lines.push(story.script.trim(), "");
  lines.push("More 30-second news at https://news30.live");
  if (story.source) lines.push("", "Source: " + story.source);
  // Attribution matters here: these are summaries of other newsrooms'
  // reporting, and saying so is both honest and the thing that keeps
  // this on the right side of a copyright complaint.
  if (story.article_url) lines.push(story.article_url);
  return lines.join("\n").slice(0, 4900);
}

async function uploadOne(story, accessToken) {
  // The Supabase media bucket is public, so no auth header needed here.
  const videoRes = await fetch(story.video_url);
  if (!videoRes.ok) throw new Error("could not fetch video (" + videoRes.status + ")");
  const bytes = Buffer.from(await videoRes.arrayBuffer());
  console.log("[upload] fetched", (bytes.length / 1048576).toFixed(1), "MB");

  const metadata = {
    snippet: {
      title: buildTitle(story),
      description: buildDescription(story),
      categoryId: CATEGORY_ID,
      tags: ["news", "shorts", story.category].filter(Boolean),
    },
    status: {
      // The whole safety argument in one field. Do not change this to
      // "public" without replacing the human review step with something
      // else that catches a wrong claim about a named person.
      privacyStatus: "private",
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

  return result.id;
}

async function main() {
  // `youtube_id is null` is what makes this idempotent. The workflow can
  // run every four hours, or twice by accident, and nothing gets
  // double-posted — a story with an ID is simply not selected again.
  const { data: stories, error } = await supabase
    .from("published_stories")
    .select("id, headline, script, category, source, article_url, video_url")
    .eq("status", "ready")
    .is("youtube_id", null)
    .not("video_url", "is", null)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error("[upload] could not read queue:", error.message);
    process.exit(1);
  }

  if (!stories || !stories.length) {
    console.log("[upload] nothing to upload");
    return;
  }

  console.log("[upload]", stories.length, "video(s) to upload");
  const accessToken = await getAccessToken();

  let uploaded = 0;
  for (const story of stories) {
    console.log("[upload] →", (story.headline || "").slice(0, 70));
    try {
      const youtubeId = await uploadOne(story, accessToken);

      await supabase
        .from("published_stories")
        .update({
          youtube_id: youtubeId,
          youtube_uploaded_at: new Date().toISOString(),
          youtube_error: null,
        })
        .eq("id", story.id);

      uploaded++;
      console.log("[upload] ✅ private draft: https://studio.youtube.com/video/" + youtubeId + "/edit");
    } catch (e) {
      const message = String(e.message || e);

      // Quota is not a per-story failure, it is a stop condition. Trying
      // the next one just burns the retry for nothing.
      if (message === "QUOTA_EXCEEDED") {
        console.error("[upload] daily quota exhausted — stopping. Remaining stories stay queued.");
        break;
      }

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

  console.log("[upload] done —", uploaded, "uploaded");
  if (uploaded) {
    console.log("[upload] review them at https://studio.youtube.com → Content → filter by Private");
  }
}

main().catch((e) => {
  console.error("[upload] fatal:", e.message || e);
  process.exit(1);
});
