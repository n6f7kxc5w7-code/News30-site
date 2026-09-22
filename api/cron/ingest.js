// /api/cron/ingest.js
// 🗞 STAGE 1 OF THE AUTOMATED PIPELINE — decides what is worth making
// a video about, queues it, and clears out old media.
//
// Runs on a schedule (see .github/workflows/ingest.yml). Does NOT render
// anything: it fetches headlines, works out which stories are actually
// significant, writes the top three per category into published_stories
// as `pending`, then kicks the worker. Selection is fast; rendering is
// slow. Keeping them in separate functions is what makes the whole
// thing fit inside Vercel's execution limit.
//
// ─── HOW "BIG STORY" IS DECIDED, WITHOUT AI ──────────────────────
// The instinct is to ask a model "is this important?" That is slow,
// costs money on every headline, and a model's guess about importance
// is just a guess. There is a better signal sitting in the data.
//
// CORROBORATION. If Reuters, AP and the BBC are all running the same
// story, it is significant — newsrooms have already made that judgement
// independently, and their agreement is evidence about the world rather
// than an opinion about it. A story only one outlet carries is usually
// either minor or a puff piece. This is the heaviest weighted signal.
//
// SOURCE TIER. Wire services and major outlets break real news; content
// farms republish it. A story led by Reuters starts ahead of one led by
// an aggregator.
//
// RECENCY. News decays. A six-hour-old story competes poorly against
// one from twenty minutes ago, all else equal.
//
// FEED POSITION. NewsAPI already sorts top-headlines by its own
// relevance model. Ignoring that entirely would be throwing away free
// information, so it contributes a small amount.
//
// SOFT-NEWS PENALTY. Listicles, celebrity items and "you won't believe"
// headlines score badly regardless of corroboration.
//
// Security: this endpoint spends money, so it requires CRON_SECRET.
// GitHub Actions sends it as a bearer token; anyone else calling the
// URL gets a 401.
//
// Requires: alter table published_stories add column if not exists description text;

import { createClient } from "@supabase/supabase-js";

const CATEGORY_MAP = {
  geopolitics: "general",
  finance: "business",
  sports: "sports",
};

const STORIES_PER_CATEGORY = 2;
const HEADLINES_TO_CONSIDER = 40; // pool per category before ranking

/* NewsAPI's description is one or two sentences of real detail. It is
   capped here rather than at read time because there is no point
   storing a truncated paragraph plus the "[+1423 chars]" tail NewsAPI
   appends — that tail is boilerplate the model would have to be told
   to ignore. 600 characters comfortably holds a full summary. */
const MAX_DESCRIPTION = 600;

/* ─── THE STORAGE BUDGET ────────────────────────────────────────────

   Retention is not a taste question, it is arithmetic. The free tier is
   1024 MB and the whole pipeline stops when it is exceeded, so:

     1024 MB limit
     - 100 MB deliberate safety margin
     =  924 MB usable

   Three things live in the bucket, and they behave differently.

   THUMBNAILS are what draw the cards on the feed, so a story without
   one looks broken even when it has no video left. At ~0.14 MB each (847 files,
   118 MB measured) that is only ~10 MB a day — but nothing was ever
   deleting them, so over a few months they would quietly eat the whole
   budget on their own. They get their own, much longer retention: at 30
   days they settle at roughly 150 MB and stop growing.

     924 MB usable
     - 150 MB thumbnails at 30 days
     =  774 MB for video + narration

   VIDEO + NARRATION. Measured 22 Sep, after the encoder was rate-capped:
   video averaged 1.35 MB and narration 0.29 MB per render, against
   ~15 MB per video before. That was -crf 30, which came in at roughly
   360 kbps — far under its own 1500k ceiling, so the quality knob, not
   the cap, was doing the work. -crf 25 spends some of that headroom
   back on picture quality at an expected ~3 MB per video.

   Render rate is the least certain input: 34 videos were present under
   a 12-hour retention, implying ~68 renders a day, which is double what
   the schedule suggests. Using the higher figure deliberately.

     68 renders/day x (3 MB video + 0.29 MB narration) = ~225 MB/day
     774 MB / 225 MB per day = 3.4 days

   So three days, rounded down. Peak usage lands around 825 MB, which
   preserves the 100 MB margin, and the site keeps three days of
   playable video instead of the twelve hours that made every card older
   than half a day show as a placeholder.

   IF ANY INPUT CHANGES, REDO THE SUM. More renders per day, bigger
   files, or a different encoder setting all move it. The query to check
   the real numbers:

     select split_part(name,'/',1) as folder, count(*) as files,
            round(avg((metadata->>'size')::bigint)/1048576.0, 2) as avg_mb,
            round(sum((metadata->>'size')::bigint)/1048576.0, 1) as total_mb
     from storage.objects where bucket_id = 'media'
     group by 1 order by 4 desc;
*/
const RETENTION_DAYS = 3;          // video + narration
const THUMB_RETENTION_DAYS = 30;   // thumbnails — see above

const STORAGE_BUCKET = "media";

// Outlets that break stories rather than repackage them. Anything
// unlisted scores 1 — unknown, not penalised.
const SOURCE_TIER = {
  reuters: 5, "associated press": 5, ap: 5, "agence france-presse": 5, afp: 5,
  "bbc news": 4, bbc: 4, bloomberg: 4, "financial times": 4, ft: 4,
  "the guardian": 4, "the new york times": 4, "the washington post": 4,
  "the wall street journal": 4, wsj: 4, cnbc: 3, "sky news": 3, "sky sports": 3,
  "al jazeera english": 3, "al jazeera": 3, npr: 3, politico: 3, axios: 3,
  espn: 3, "the athletic": 3, nrk: 3, dw: 3, "deutsche welle": 3,
  cnn: 3, "abc news": 3, "cbs news": 3, "nbc news": 3,
};

// Headline shapes that signal soft news whatever the corroboration.
const SOFT_NEWS_PATTERNS = [
  /\b\d+\s+(things|ways|reasons|times|photos|celebrities)\b/i,
  /\byou won'?t believe\b/i, /\bhere'?s (why|what|how)\b/i,
  /\bwent viral\b/i, /\bslams?\b/i, /\bfans? react\b/i,
  /\bbest deals?\b/i, /\bdeal of the day\b/i, /\bhoroscope\b/i,
  /\bnetflix\b.*\bwatch\b/i, /\brecipe\b/i,
];

// Words too common to indicate two articles are about the same event.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","as","is","are","was","were","be","been","has","have","had","will",
  "would","could","should","may","might","new","says","said","after","before",
  "over","its","his","her","their","this","that","these","those","it","he",
  "she","they","we","you","not","no","more","most","up","down","out","about",
]);

function tokenize(title) {
  return new Set(
    (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

// Jaccard similarity. Two headlines about the same event share their
// distinctive nouns even when worded completely differently:
// "EU leaders agree defence fund" vs "European Union strikes deal on
// joint defence financing" overlap on leaders/defence/fund.
function similarity(aTokens, bTokens) {
  if (!aTokens.size || !bTokens.size) return 0;
  let shared = 0;
  for (const t of aTokens) if (bTokens.has(t)) shared++;
  return shared / (aTokens.size + bTokens.size - shared);
}

const SAME_STORY_THRESHOLD = 0.28;

function sourceTier(name) {
  return SOURCE_TIER[(name || "").toLowerCase().trim()] || 1;
}

function isSoftNews(headline) {
  return SOFT_NEWS_PATTERNS.some((re) => re.test(headline || ""));
}

/* NewsAPI truncates long descriptions and marks the cut with a
   "[+1423 chars]" suffix. Left in, that string reaches DeepSeek as if
   it were part of the story. Strip it, along with the usual HTML
   entities that survive the feed. */
function cleanDescription(raw) {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/\[\+\d+\s*chars?\]\s*$/i, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Anything this short is a stub ("Read more", a byline, an ellipsis)
  // and is worse than nothing: it would be presented to the model as
  // source material and produce a script built on a fragment.
  if (text.length < 30) return null;
  return text.slice(0, MAX_DESCRIPTION);
}

/* ─────────────────── STORAGE CLEANUP ───────────────────────────────

   WHY THIS WORKS FROM STORAGE, NOT FROM THE DATABASE.

   The first version found files to delete by reading video_url and
   audio_url off published_stories rows, then deleting whatever those
   URLs pointed at. That is only as good as the pointers. On 16 Sep a
   manual `update published_stories set video_url = null, audio_url = null`
   wiped every pointer at once, and from then on the sweep reported
   {"checked":0,"deleted":0} on every run while 68 videos (1 GB) and 492
   narration files sat in the bucket with nothing referring to them.
   Orphaned files are invisible to a database-driven sweep, forever.

   So this asks Storage directly. Every object carries its own
   created_at, which is the only fact the retention rule actually needs.
   Nulled columns, deleted rows, a failed render that uploaded narration
   but never published — none of it matters any more. If a file in
   video/ or narration/ is older than RETENTION_DAYS, it goes.

   thumb/ is swept too, but on THUMB_RETENTION_DAYS rather than
   RETENTION_DAYS: a thumbnail is ~40x smaller than its video and it is
   what keeps a card from looking broken after the video is gone.
*/
const CLEANUP_FOLDERS = [
  { folder: "video", days: RETENTION_DAYS },
  { folder: "narration", days: RETENTION_DAYS },
  { folder: "thumb", days: THUMB_RETENTION_DAYS },
];

// Supabase list() returns at most this many objects per call.
const LIST_PAGE = 1000;

// remove() takes an array of paths; chunked so one oversized request
// cannot fail the whole sweep.
const REMOVE_CHUNK = 100;

/**
 * Every object in `folder` older than `cutoffMs`, oldest first.
 *
 * Sorted ascending by created_at so the scan can stop at the first file
 * newer than the cutoff — everything after it is newer too, and there is
 * no point paging through today's renders.
 */
async function listExpired(supabase, folder, cutoffMs) {
  const expired = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(folder, {
        limit: LIST_PAGE,
        offset,
        sortBy: { column: "created_at", order: "asc" },
      });

    if (error) throw new Error("list " + folder + " failed: " + error.message);
    if (!data || !data.length) break;

    let reachedNew = false;
    for (const obj of data) {
      // list() also returns sub-folder placeholders, which have no id and
      // no created_at. Skip them rather than trying to delete a folder.
      if (!obj || !obj.id || !obj.created_at) continue;
      if (Date.parse(obj.created_at) >= cutoffMs) { reachedNew = true; break; }
      expired.push(folder + "/" + obj.name);
    }

    if (reachedNew || data.length < LIST_PAGE) break;
    offset += LIST_PAGE;
  }

  return expired;
}

/**
 * Deletes video and narration files older than RETENTION_DAYS, straight
 * from Storage, then clears any database columns still pointing at them.
 *
 * Files first, columns second: if this dies halfway, the worst outcome
 * is a row pointing at a missing file (one card fails to play), never a
 * file nobody can find.
 *
 * Never throws. A failed sweep must not stop the day's ingest — there is
 * another run in four hours, whereas a missed ingest is a gap in the feed.
 */
async function cleanupOldMedia(supabase) {
  const mediaCutoffMs = Date.now() - RETENTION_DAYS * 86400000;
  const result = { checked: 0, deleted: 0, failed: 0 };

  for (const { folder, days } of CLEANUP_FOLDERS) {
    const cutoffMs = Date.now() - days * 86400000;
    let paths;
    try {
      paths = await listExpired(supabase, folder, cutoffMs);
    } catch (e) {
      console.error("[ingest] cleanup:", String(e.message || e));
      continue;
    }

    result.checked += paths.length;

    for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
      const chunk = paths.slice(i, i + REMOVE_CHUNK);
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).remove(chunk);
      if (error) {
        console.error("[ingest] cleanup remove failed in", folder + ":", error.message);
        result.failed += chunk.length;
      } else {
        result.deleted += (data || chunk).length;
      }
    }
  }

  /* Clear pointers to anything we just removed, so the site doesn't offer
     a play button that 404s. Row age is used as the proxy: a story row is
     created before its files, so any row older than the cutoff has files
     older than the cutoff too. Harmless when there is nothing to clear. */
  try {
    const { error } = await supabase
      .from("published_stories")
      .update({ video_url: null, audio_url: null })
      .lt("created_at", new Date(mediaCutoffMs).toISOString())
      .not("video_url", "is", null);
    if (error) console.error("[ingest] cleanup column clear failed:", error.message);
  } catch (e) {
    console.error("[ingest] cleanup column clear errored:", String(e).slice(0, 160));
  }

  console.log(
    "[ingest] cleanup: found", result.checked, "expired files,",
    result.deleted, "deleted,", result.failed, "failed",
    "(video/narration >", RETENTION_DAYS, "days; thumbs >", THUMB_RETENTION_DAYS, "days)"
  );

  return result;
}

/**
 * Ranks a category's headlines and returns the top N.
 *
 * Clusters near-duplicate headlines first, so the three chosen stories
 * are three different events rather than three write-ups of one. That
 * clustering does double duty: cluster size IS the corroboration count.
 */
function rankStories(articles, limit) {
  const usable = articles.filter(
    (a) => a && a.title && a.title !== "[Removed]" && a.url
  );

  // Cluster by headline similarity.
  const clusters = [];
  usable.forEach((article, feedIndex) => {
    const tokens = tokenize(article.title);
    let placed = false;

    for (const cluster of clusters) {
      if (similarity(tokens, cluster.tokens) >= SAME_STORY_THRESHOLD) {
        cluster.members.push({ article, feedIndex });
        // Keep the highest-tier outlet as the cluster's representative:
        // Reuters' wording of an event beats an aggregator's rewrite.
        if (sourceTier(article.source && article.source.name) >
            sourceTier(cluster.lead.article.source && cluster.lead.article.source.name)) {
          cluster.lead = { article, feedIndex };
        }
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push({ tokens, members: [{ article, feedIndex }], lead: { article, feedIndex } });
    }
  });

  const now = Date.now();

  const scored = clusters.map((cluster) => {
    const { article, feedIndex } = cluster.lead;

    // Distinct outlets, not distinct articles — one outlet filing three
    // updates is not three newsrooms agreeing.
    const outlets = new Set(
      cluster.members.map((m) => ((m.article.source && m.article.source.name) || "").toLowerCase())
    );
    const corroboration = outlets.size;

    // Heaviest signal. Sub-linear so a 12-outlet story doesn't
    // permanently crowd out everything else.
    const corroborationScore = Math.min(50, Math.round(18 * Math.log2(corroboration + 1)));

    // Best outlet in the cluster, not just the lead.
    const bestTier = Math.max(
      ...cluster.members.map((m) => sourceTier(m.article.source && m.article.source.name))
    );
    const tierScore = bestTier * 5;

    // Roughly halves every 8 hours.
    const ageHours = Math.max(0, (now - (Date.parse(article.publishedAt) || now)) / 3600000);
    const recencyScore = Math.round(25 * Math.pow(0.5, ageHours / 8));

    // NewsAPI's own ordering, small weight.
    const positionScore = Math.max(0, 10 - feedIndex);

    const softPenalty = isSoftNews(article.title) ? -40 : 0;

    // Headlines under ~5 words are usually teasers with no substance.
    const brevityPenalty = tokenize(article.title).size < 4 ? -15 : 0;

    /* A story with no usable summary can only ever produce a
       headline-only script, and those measured 18 to 48 words against a
       65-75 target. That is not a reason to reject the story — a real
       lead with a thin description still beats a padded minor one — but
       it is a reason to prefer the version of the same event that came
       with detail. The lead article is chosen by source tier, so this
       nudges rather than overrides. */
    const cluster_desc = cleanDescription(article.description);
    const detailBonus = cluster_desc ? 8 : 0;

    const significance =
      corroborationScore + tierScore + recencyScore + positionScore +
      softPenalty + brevityPenalty + detailBonus;

    return {
      article,
      description: cluster_desc,
      significance,
      corroboration,
      rank_reason:
        corroboration + " outlets" +
        ", tier " + bestTier +
        ", " + ageHours.toFixed(1) + "h old" +
        (cluster_desc ? ", has summary" : ", HEADLINE ONLY") +
        (softPenalty ? ", soft-news penalty" : "") +
        (brevityPenalty ? ", thin headline" : ""),
    };
  });

  return scored.sort((a, b) => b.significance - a.significance).slice(0, limit);
}

export default async function handler(req, res) {
  // GitHub Actions sends `Authorization: Bearer <CRON_SECRET>`. Without
  // this check the URL is public and anyone could trigger a full render
  // cycle at will.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[ingest] CRON_SECRET not configured — refusing to run");
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

  const newsKey = process.env.NEWSAPI_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!newsKey || !supabaseUrl || !serviceKey) {
    console.error("[ingest] missing config");
    res.status(500).json({ error: "Server is not configured" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const summary = {};

  // Anything still waiting after 24h is no longer news — expire it rather
  // than letting the queue grow without bound. process.js only picks up
  // `pending`, so this is what stops the worker rendering two-day-old
  // stories while genuinely fresh ones sit behind them in the queue.
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: expired, error: expireErr } = await supabase
      .from("published_stories")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("status", "pending")
      .lt("created_at", cutoff)
      .select("id");
    if (expireErr) throw expireErr;
    summary.expired = (expired || []).length;
    console.log("[ingest] expired stale pending rows:", summary.expired);
  } catch (e) {
    // Non-fatal: a failed cleanup shouldn't stop today's ingest.
    console.error("[ingest] expiry sweep failed:", e);
  }

  /* Media retention sweep. Runs BEFORE the NewsAPI fetches so that a
     slow news API cannot eat the function's time budget and leave the
     storage sweep permanently unreached — which is the failure mode
     that lets a disk fill silently. Never throws; see cleanupOldMedia. */
  try {
    summary.cleanup = await cleanupOldMedia(supabase);
  } catch (e) {
    console.error("[ingest] cleanup sweep failed:", e);
    summary.cleanup = { error: true };
  }

  try {
    for (const [category, apiCategory] of Object.entries(CATEGORY_MAP)) {
      const url =
        "https://newsapi.org/v2/top-headlines?category=" + apiCategory +
        "&language=en&pageSize=" + HEADLINES_TO_CONSIDER +
        "&apiKey=" + encodeURIComponent(newsKey);

      const r = await fetch(url);
      if (!r.ok) {
        console.error("[ingest] NewsAPI failed for", category, r.status);
        summary[category] = { error: "fetch failed (" + r.status + ")" };
        continue;
      }

      const json = await r.json();
      const top = rankStories(json.articles || [], STORIES_PER_CATEGORY);

      console.log(
        "[ingest]", category, "picked:",
        top.map((t) => t.significance + " — " + t.article.title.slice(0, 60)).join(" | ")
      );

      /* How many of today's picks carry real source material. If this
         is regularly 0, the scripts will stay short no matter what the
         prompt says, and the fix is a different news source rather than
         more prompt engineering. */
      const withSummary = top.filter((t) => t.description).length;
      console.log("[ingest]", category, "with summary:", withSummary + "/" + top.length);

      // Slot 1 is the lead story for the category.
      const rows = top.map((t, i) => ({
        article_url: t.article.url,
        category,
        headline: (t.article.title || "").replace(/\s+[-|–]\s+[^-|–]+$/, "").trim(),
        /* NewsAPI's own one-or-two-sentence summary. Previously thrown
           away, which left DeepSeek writing 65-75 word scripts from a
           headline alone — it cannot, and the prompt (correctly) forbids
           inventing detail, so it stopped early instead. Measured
           scripts ran 18 to 57 words, producing 13-21 second videos.
           This column is what makes a full-length script possible
           without fabricating anything. */
        description: t.description,
        source: (t.article.source && t.article.source.name) || "Newswire",
        article_published: t.article.publishedAt || new Date().toISOString(),
        significance: t.significance,
        corroboration: t.corroboration,
        rank_reason: t.rank_reason,
        status: "pending",
        slot: i + 1,
      }));

      // ignoreDuplicates means a story already queued or published stays
      // as it is — this cron runs repeatedly and must not re-render
      // yesterday's news or reset a row mid-generation.
      //
      // .select() makes the upsert return the rows it actually wrote, so
      // `inserted` reflects reality — `rows.length` counts what we tried,
      // which stays cheerfully constant even when every write is failing.
      const { data: written, error } = await supabase
        .from("published_stories")
        .upsert(rows, { onConflict: "article_url", ignoreDuplicates: true })
        .select("id");

      if (error) throw error;
      summary[category] = {
        considered: rows.length,
        inserted: (written || []).length,
        with_summary: withSummary,
      };
    }

    // Kick the worker. This is still fire-and-forget in spirit — we do
    // NOT wait for the actual render, which can take up to process.js's
    // own 60s limit. But the original version used a bare
    // `.catch(() => {})` with no await at all, which meant a failed
    // trigger — network blip, DNS hiccup — left nine stories sitting at
    // `pending` with zero visibility into why. That happened once
    // already during testing and took a manual Supabase check to catch.
    //
    // The fix: wait just long enough (5s) to confirm the request was
    // ACCEPTED, then stop waiting regardless of whether the render has
    // finished. AbortController cancels our own wait, not the render
    // itself — process.js keeps running server-side either way, this
    // only affects how long ingest.js hangs around to check.
    const base = "https://" + (req.headers.host || "news30.live");
    const kickController = new AbortController();
    const kickTimeout = setTimeout(() => kickController.abort(), 5000);

    try {
      const kickRes = await fetch(base + "/api/cron/process", {
        method: "POST",
        headers: { Authorization: "Bearer " + secret },
        signal: kickController.signal,
      });
      clearTimeout(kickTimeout);
      if (!kickRes.ok) {
        console.error("[ingest] worker trigger rejected:", kickRes.status);
      } else {
        console.log("[ingest] worker trigger accepted");
      }
    } catch (kickErr) {
      clearTimeout(kickTimeout);
      if (kickErr.name === "AbortError") {
        // Expected on a normal run: the render is still in progress
        // after 5s, which is fine — this just means we stopped
        // watching, not that anything failed.
        console.log("[ingest] worker trigger sent, still rendering after 5s (normal)");
      } else {
        // A genuine failure to even reach the endpoint — this is the
        // case the old bare .catch(() => {}) was hiding.
        console.error("[ingest] worker trigger failed to send:", kickErr);
      }
    }

    res.status(200).json({ ok: true, summary });
  } catch (e) {
    console.error("[ingest] failed:", e);
    res.status(500).json({ error: "Ingest failed" });
  }
}
