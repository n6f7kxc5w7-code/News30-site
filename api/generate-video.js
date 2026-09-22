// /api/generate-video.js
// 🔌 STEP 3 OF THE VIDEO PIPELINE — FFmpeg version (free, self-hosted).
// Downloads real imagery + the Fish Audio narration into /tmp, uses
// FFmpeg (via ffmpeg-static) to assemble a 720x1280 video with a gentle
// Ken Burns zoom per image and burned-in captions, muxes in the
// narration, then uploads the finished MP4 to Supabase Storage.
//
// Required Vercel env vars (server-only, no "VITE_" prefix):
//   PEXELS_API_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   PIPELINE_ENABLED           (set to "false" to kill all rendering
//                               instantly without a redeploy — see below)
// Reuses VITE_SUPABASE_URL.
//
// ─── FIXES IN THIS VERSION ──────────────────────────────────────────
// 1. THE "SAME IMAGE FOR THE WHOLE VIDEO" BUG. zoompan's `d` parameter
//    is the number of output frames generated PER INPUT FRAME, not the
//    total length of the segment. Inputs here are `-loop 1 -t 6 -i img`,
//    which already produce ~150 frames each, so `d=150` was asking for
//    150 x 150 = ~22,500 frames from image 1 alone. `-shortest` then cut
//    the video at the audio length, so the finished video showed only
//    the first image, crawling, start to finish. Fixed by using `d=1`
//    (one output frame per input frame) and driving the zoom off `on`,
//    the output frame counter, so the Ken Burns effect still ramps
//    smoothly across each segment.
//
// 2. THE PADDING LOOP THAT REPEATED IMAGE ZERO. The old line
//       while (photos.length < count) photos.push(photos[photos.length % photos.length]);
//    computes n % n, which is always 0 — so short result sets were
//    padded with five copies of the same photo. Replaced with a proper
//    multi-query fill that only ever adds genuinely new photos, and
//    accepts a shorter video over a repeated one.
//
// 3. SUBSTRING KEYWORD MATCHING. The old map used `lower.includes(t)`,
//    so "ai" matched Ukraine / aid / campaign / air, "bill" matched
//    billion, "app" matched appeal, "war" matched warning, and "heat"
//    matched wheat. Now matched on word boundaries with a scoring pass
//    across all categories instead of first-match-wins.
//
// 4. IMAGE QUERIES COME FROM THE MODEL. The keyword map can only
//    recognise vocabulary it was written for — headlines like "Israel
//    and Hamas agree ceasefire framework" or "Bitcoin falls after ETF
//    outflows" score zero triggers and fall through to generic photos.
//    generate-audio.js asks DeepSeek for three stock-photo search
//    phrases in the same call that produces the script (no extra
//    round-trip, which is what made a separate step-3 AI call untenable
//    against the 60s limit) and stores them on the job row. This
//    function reads job.image_queries first and only falls back to the
//    map below when they're missing or unusable.
//
// 5. NAMED ENTITIES NOW COME FROM WIKIMEDIA, NOT PEXELS. This is the
//    big one. Pexels is a STOCK library: it has photographs of models,
//    offices, skylines and crowds, and no photographs whatsoever of
//    Trump, SpaceX, Anthropic, Real Madrid or any other named person,
//    company or event. So a story about SpaceX would narrate SpaceX
//    over five anonymous strangers in an office — which is worse than
//    no illustration, because the mismatch is what makes a viewer
//    swipe away.
//
//    Stories split cleanly into two kinds. THEMATIC ones (markets fall,
//    protests spread, storms hit) are exactly what stock libraries are
//    for. NAMED-ENTITY ones need a picture of the actual thing.
//    Wikimedia Commons has the second kind — freely licensed photos of
//    companies, politicians, landmarks, rockets — and costs nothing and
//    needs no API key.
//
//    So: generate-audio.js now also returns any named entities in the
//    story. Where they exist, this fetches one Commons image per entity
//    and leads the video with them, then fills the remaining slots from
//    Pexels for visual variety. Where there are none, behaviour is
//    exactly as before.
//
//    Requires: alter table video_jobs add column if not exists entities jsonb;
//              alter table video_jobs add column if not exists image_credits jsonb;
//
//    ⚠️ ATTRIBUTION: Commons images are freely licensed, not
//    unencumbered. Public-domain and CC0 files need nothing. CC-BY and
//    CC-BY-SA legally require crediting the author. This function
//    filters to free licences and records the credit line for every
//    image it uses on job.image_credits — put those in the video
//    description when you upload. If that becomes a nuisance, tighten
//    ACCEPTED_LICENCES below to the public-domain entries only.
//
// 6. STOCK IS NO LONGER THE UNIVERSAL FALLBACK — TEXT CARDS ARE.
//    YouTube retention showed a hard cliff at ~4 seconds on two very
//    different Shorts of different lengths. Five slides across a 16s
//    video puts the SECOND slide at ~3.2s, and slide two is the first
//    Pexels image. On a Walmart story that was a photograph of an
//    unrelated independent boutique; on a Dutch GP story it was a
//    club-level motorsport helmet, not F1. Slide one (the correct
//    Wikipedia photo) held ~100% of viewers. Slide two lost half of
//    them. The mismatch itself is the retention problem: a viewer who
//    sees the visual contradict the narration concludes the channel has
//    no real footage and swipes.
//
//    So Pexels is now CONDITIONAL rather than automatic:
//
//      Tier 1  Wikimedia/Wikipedia entity photos      (as before)
//      Tier 2  Pexels — ONLY when confident            (new gate)
//      Tier 3  Rendered text card                      (new)
//
//    "Confident" means one of:
//      (a) the story is purely thematic (no named entities at all), in
//          which case stock is the right tool and always has been; or
//      (b) the headline scores a real hit on the keyword map, so we
//          know which visual bucket it belongs to.
//
//    Note what is NOT sufficient: DeepSeek's image_queries alone on an
//    entity-led story. Those queries are what produced the boutique —
//    the model correctly described "clothing retail" and Pexels
//    correctly returned clothing retail, but next to narration about
//    Walmart specifically, a generic shopfront reads as wrong. The
//    model's phrases are still used to SEARCH; they just no longer
//    authorise searching in the first place.
//
//    Tier 3 renders a headline card — brand background, white text,
//    burned in through libass exactly like the captions. Neutral beats
//    wrong: a card doesn't contradict anything, so a viewer keeps
//    listening. Capped at MAX_CARDS (1) because three identical cards
//    would be the repeated-image bug wearing a different hat, and a
//    3-slide 16s video is perfectly normal news pacing.
//
//    LAST RESORT: if entity photos + one card still leave us under
//    MIN_IMAGE_COUNT, the stock gate is released rather than failing
//    the render. A possibly-generic photo beats no video at all. This
//    is logged loudly so it shows up in image_sources.
//
//    NOTE: this could not use FFmpeg's `drawtext` filter — Vercel's
//    bundled static build has no drawtext at all ("No such filter"),
//    which is the same constraint that pushed captions onto libass.
//    The card is therefore a `color` lavfi source with a one-line .ass
//    burned onto it, saved as a JPEG, and then fed through the normal
//    image path like any other slide.
//
//    Requires: alter table video_jobs add column if not exists image_sources jsonb;
//
// 7. AAS TEXT IS NOW ESCAPED. buildAss interpolated caption text
//    straight into the Dialogue line. A headline containing { or } or a
//    backslash would be parsed as an ASS override tag — silently
//    dropping text at best, breaking the render at worst. Both the
//    caption and card builders now run text through assEscape().
//
// 8. VIDEOS WERE ~15 MB EACH. `-preset ultrafast` with no rate control
//    produced roughly 4 Mbps for a 720x1280 slideshow — measured at
//    68 videos = 1039 MB. At 30-40 renders a day that is 500+ MB of new
//    files daily, which alone nearly fills Supabase's 1 GB free tier and
//    got the organisation restricted twice.
//
//    First attempt was `-crf 30` with a `-maxrate 1500k` ceiling. That
//    overshot: measured output averaged 1.35 MB per video, roughly
//    360 kbps — a tenth of the original bitrate and far under its own
//    ceiling, so CRF, not the cap, was setting the size. Storage stopped
//    being a problem, but detailed photographs during the Ken Burns zoom
//    were visibly soft.
//
//    So `-crf 25` now: expected ~3 MB per video, still a 5x saving on
//    the original, with the bitrate spent where it shows. The retention
//    window in ingest.js is sized against that number — if you change
//    CRF again, redo the storage budget there.
//
//    `superfast` rather than
//    `ultrafast` because ultrafast disables most of the tools that make
//    rate control efficient; it is only marginally slower. If renders
//    start timing out against the 60s limit, go back to `ultrafast` and
//    keep -crf and -maxrate — they still do most of the work.
// ─────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import ffmpegPath from "ffmpeg-static";
import { enforceRateLimit } from "./_rate-limit.js";

const execFileAsync = promisify(execFile);

const FALLBACK_DURATION_SECONDS = 30;
const IMAGE_COUNT = 5;
const MIN_IMAGE_COUNT = 3; // ship a shorter rotation rather than repeat a photo
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 25;

// How many of the five slots entity photos may take. Capped at 3 so a
// story about three companies still gets some visual variety rather
// than five near-identical logo shots.
const MAX_ENTITY_IMAGES = 3;

// How many slots may be filled by a rendered text card. ONE. Two
// identical cards is a repeated image by another name, and a shorter
// video is a better outcome than a padded one.
const MAX_CARDS = 1;

/* CROSS-VIDEO IMAGE HISTORY.

   Dedupe used to be per-render: every job started with an empty `seen`
   set, so the same photo could headline three different videos in a
   week. Stock libraries are shallow for any given query — Pexels has
   only so many "stock market trading screen" photos, and the same
   handful rank top on every request — so two finance stories a day
   apart would genuinely pull identical imagery. Viewers reading the
   channel as a feed notice that far more than any single video's
   internal repetition.

   So recently-used Pexels IDs are persisted and excluded from future
   renders. NOT applied to Wikimedia: if two stories are both about
   Walmart, the same Walmart photograph appearing in both is correct
   rather than lazy, and suppressing it would push an entity story back
   onto stock — which is the exact failure this pipeline was rebuilt to
   avoid.

   Exclusion is a PREFERENCE, not a hard filter. If honouring it would
   leave too few images to fill the video, previously-used photos are
   allowed back in rather than failing the render.

   Requires:
     create table if not exists used_images (
       pexels_id bigint primary key,
       used_at   timestamptz not null default now()
     );
     create index if not exists used_images_used_at_idx on used_images (used_at desc);
     alter table used_images enable row level security;
     -- no policies: the service role bypasses RLS, and nothing else
     -- should be reading this table.
*/
const IMAGE_HISTORY_DAYS = 30;
const IMAGE_HISTORY_LIMIT = 5000; // ~30 days at 5 images x 30 videos/day

// Card styling. Background is deliberately close to the site's dark
// theme so the card reads as part of the brand rather than as a
// failure state.
const CARD_BG = "0x111318";
const CARD_FONT_SIZE_MAX = 58;
const CARD_FONT_SIZE_MIN = 40;

// Fonts live next to this file. Vercel's serverless environment ships
// NO system fonts, and libass silently draws nothing rather than
// erroring when it can't find one. Resolved once at module scope
// because the card renderer needs it before the handler computes it.
const FONTS_DIR = path.dirname(fileURLToPath(new URL("./LiberationSans-Bold.ttf", import.meta.url)));

// Only these origins may trigger a render. This endpoint spends real
// money (Pexels quota, Supabase storage, function time), so it must not
// be callable from arbitrary sites.
const ALLOWED_ORIGINS = [
  "https://news30.live",
  "https://www.news30.live",
  "http://localhost:5173",
];

/* ───────────────────────── KEYWORD MATCHING ─────────────────────────

   Each bucket carries SEVERAL distinct search phrases rather than one.
   Two reasons:

   (a) Variety. Running one query and taking the top 5 gives five near
       identical photos, because stock libraries cluster visually
       similar results together. Running three different queries and
       taking a couple from each produces a visibly varied sequence.

   (b) Depth. If one phrase returns thin results, the others fill the
       gap with on-topic images instead of falling back to something
       generic.

   Triggers are matched on word boundaries. A trailing `*` means prefix
   match (so "prosecut*" catches prosecuted / prosecution / prosecutors).
*/
const STOCK_KEYWORD_MAP = [
  {
    triggers: ["strike*", "military", "war", "troops", "missile", "attack*", "conflict", "defence", "defense", "army", "navy", "soldier*", "airstrike*"],
    queries: ["military aircraft sky", "soldiers formation uniform", "naval warship sea"],
  },
  {
    triggers: ["election*", "vote*", "parliament", "president", "government", "minister*", "policy", "policies", "law", "laws", "bill", "senate", "congress", "summit", "treaty", "diplomat*"],
    queries: ["government parliament building", "national flags row", "podium press conference"],
  },
  {
    triggers: ["market*", "stock*", "econom*", "inflation", "bank*", "trade", "profit*", "gdp", "interest rate", "currency", "shares", "investor*", "recession", "tariff*"],
    queries: ["stock market trading screen", "financial district skyline", "currency banknotes closeup"],
  },
  {
    triggers: ["court*", "trial", "lawsuit", "judge*", "legal", "sentenc*", "charges", "prosecut*", "verdict", "appeal"],
    queries: ["courtroom interior", "judge gavel desk", "law books library"],
  },
  {
    triggers: ["climate", "weather", "storm*", "flood*", "heat", "heatwave", "hurricane", "wildfire*", "drought", "emissions", "wildlife"],
    queries: ["storm clouds dramatic sky", "flooded street water", "wildfire smoke landscape"],
  },
  {
    triggers: ["football", "soccer", "match", "goal*", "tournament", "championship", "team*", "player*", "coach", "transfer", "league", "olympic*", "cricket", "tennis"],
    queries: ["stadium crowd floodlights", "football pitch aerial", "athlete running track"],
  },
  {
    triggers: ["tech", "ai", "artificial intelligence", "software", "app", "startup*", "chip*", "robot*", "data", "cyber*", "semiconductor*", "algorithm*"],
    queries: ["server room data centre", "circuit board macro", "person coding screen"],
  },
  {
    triggers: ["health", "hospital*", "disease", "vaccine*", "medical", "drug*", "treatment", "patient*", "doctor*", "outbreak", "virus"],
    queries: ["hospital corridor", "medical laboratory research", "doctor stethoscope hands"],
  },
  {
    triggers: ["space", "nasa", "rocket*", "satellite*", "astronaut*", "orbit", "lunar", "mars"],
    queries: ["rocket launch flames", "earth from space", "night sky stars"],
  },
  {
    triggers: ["protest*", "rally", "demonstration", "march", "riot*", "strike action", "union*"],
    queries: ["crowd protest signs", "city street march", "megaphone activist"],
  },
];

// Sensible visuals per category, used when no trigger matches.
const CATEGORY_FALLBACK = {
  geopolitics: ["national flags row", "government building exterior", "world map closeup"],
  finance: ["stock market trading screen", "financial district skyline", "currency banknotes closeup"],
  sports: ["stadium crowd floodlights", "athlete running track", "sports equipment closeup"],
};
const GENERIC_FALLBACK = ["newspaper headlines closeup", "city skyline morning", "newsroom desk"];

// Phrases where a trigger word carries a different meaning than the
// bucket assumes. "EU leaders strike a deal" is not a military story.
const FALSE_POSITIVE_PHRASES = [
  { phrase: /strikes? (a )?deal/, suppress: "strike" },
  { phrase: /struck (a )?deal/, suppress: "strike" },
  { phrase: /hunger strike/, suppress: "strike" },
  { phrase: /price war/, suppress: "war" },
  { phrase: /trade war/, suppress: "war" },
  { phrase: /bidding war/, suppress: "war" },
];

function triggerRegex(trigger) {
  if (trigger.endsWith("*")) {
    return new RegExp("\\b" + trigger.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\w*\\b");
  }
  return new RegExp("\\b" + trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
}

// Scores every bucket against the headline and returns the best match's
// query list, rather than taking whichever bucket happens to be listed
// first. A headline hitting three finance words and one military word
// now correctly reads as finance.
//
// Now also reports CONFIDENCE. A real bucket hit means we know what the
// story looks like. Falling through to the category or generic list
// means we're guessing, and guessing is what puts a boutique window on
// a Walmart story. The caller uses this to decide whether Pexels runs
// at all — see fix #6 in the header.
function getStockQueries(headline, category) {
  const lower = (headline || "").toLowerCase();

  const suppressed = new Set();
  for (const fp of FALSE_POSITIVE_PHRASES) {
    if (fp.phrase.test(lower)) suppressed.add(fp.suppress);
  }

  let best = null;
  let bestScore = 0;

  for (const bucket of STOCK_KEYWORD_MAP) {
    let score = 0;
    for (const trigger of bucket.triggers) {
      const bare = trigger.replace(/\*$/, "");
      if (suppressed.has(bare)) continue;
      if (triggerRegex(trigger).test(lower)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }

  if (best) return { queries: best.queries, confident: true, score: bestScore };

  return {
    queries: CATEGORY_FALLBACK[(category || "").toLowerCase()] || GENERIC_FALLBACK,
    confident: false,
    score: 0,
  };
}

/* ──────────────────── WIKIMEDIA COMMONS (named entities) ────────────

   No API key, no quota worth worrying about, but Wikimedia asks that
   automated clients identify themselves — an anonymous flood of
   requests from a datacentre IP is what gets a range blocked.
*/
const WIKI_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const WIKI_UA = "News30/1.0 (https://news30.live; automated news video pipeline)";

// Below this the image is a thumbnail, an icon, or a flag sprite —
// upscaling it to 720x1280 would look worse than a stock photo.
const WIKI_MIN_WIDTH = 640;

/* Commons hosts plenty of non-free material under fair-use-style
   exemptions, and "freely licensed" is not the same as "no obligations".
   These are the licences safe to use with a credit line; everything
   else is skipped. Matched loosely because Commons' LicenseShortName
   strings vary ("CC BY-SA 4.0", "CC BY 2.5", "Public domain"…). */
const ACCEPTED_LICENCES = [
  /^cc0/i,
  /^cc[ -]by/i,          // covers CC BY and CC BY-SA, all versions
  /public domain/i,
  /^pd[ -]/i,
];

function licenceIsUsable(shortName) {
  if (!shortName) return false;
  return ACCEPTED_LICENCES.some((re) => re.test(shortName.trim()));
}

// Commons descriptions are HTML fragments. Strip tags for the credit
// line — this ends up in a YouTube description, not a web page.
function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The canonical photograph of an entity, via Wikipedia's lead image.
 *
 * This is tried before a Commons search, and the difference matters.
 * Commons full-text search returns whatever happens to be catalogued
 * under a name, ranked by keyword relevance — searching "England
 * cricket team" surfaced a 2015 Ashes photograph, correct but a decade
 * stale. A Wikipedia article's lead image is chosen and maintained by
 * editors to be the best current representation of the subject, which
 * is exactly the judgement we want and cannot make ourselves.
 *
 * Two calls: Wikipedia for the filename, Commons for the licence and a
 * sized copy. Wikipedia's own API returns no licence metadata, and
 * using an image without knowing its licence is not something to do at
 * scale.
 */
async function fetchWikipediaLeadImage(entity) {
  const wpUrl =
    "https://en.wikipedia.org/w/api.php" +
    "?action=query&format=json&redirects=1" +   // redirects: "Trump" → "Donald Trump"
    "&prop=pageimages&piprop=name" +
    "&titles=" + encodeURIComponent(entity);

  const wpRes = await fetch(wpUrl, { headers: { "User-Agent": WIKI_UA } });
  if (!wpRes.ok) return null;

  const wpData = await wpRes.json();
  const pages = (wpData.query && wpData.query.pages) ? Object.values(wpData.query.pages) : [];
  const page = pages[0];
  // `missing` means no such article; no pageimage means the article
  // exists but carries no illustration.
  if (!page || page.missing !== undefined || !page.pageimage) return null;

  const fileTitle = "File:" + page.pageimage;

  const cUrl =
    WIKI_ENDPOINT +
    "?action=query&format=json" +
    "&titles=" + encodeURIComponent(fileTitle) +
    "&prop=imageinfo" +
    "&iiprop=url|size|mime|extmetadata" +
    "&iiurlwidth=1280";

  const cRes = await fetch(cUrl, { headers: { "User-Agent": WIKI_UA } });
  if (!cRes.ok) return null;

  const cData = await cRes.json();
  const cPages = (cData.query && cData.query.pages) ? Object.values(cData.query.pages) : [];
  const info = cPages[0] && cPages[0].imageinfo && cPages[0].imageinfo[0];
  if (!info) return null;
  if (!/^image\/(jpeg|png)$/i.test(info.mime || "")) return null;

  const src = info.thumburl || info.url;
  if (!src) return null;
  if ((info.thumbwidth || info.width || 0) < WIKI_MIN_WIDTH) return null;

  const meta = info.extmetadata || {};
  const licence = meta.LicenseShortName && meta.LicenseShortName.value;
  if (!licenceIsUsable(licence)) return null;

  const artist = stripHtml(meta.Artist && meta.Artist.value);
  const needsCredit = !/^cc0|public domain|^pd[ -]/i.test(String(licence).trim());

  return {
    url: src,
    source: "wikipedia",
    credit: needsCredit
      ? page.pageimage + (artist ? " by " + artist : "") + " — " + licence + ", via Wikimedia Commons"
      : null,
  };
}

/**
 * One good photograph per entity. Deliberately one, not several: three
 * different subjects beats three angles on the same logo, and the whole
 * point of this path is that the viewer recognises what they're being
 * told about.
 *
 * Wikipedia's lead image first, Commons search only if that finds
 * nothing — the search is noisier, so it's the backstop rather than the
 * default.
 *
 * Returns [{ url, credit, source }] — credit is null for public-domain
 * files.
 */
async function fetchWikimediaImages(entities, maxImages) {
  const out = [];
  const seenUrls = new Set();

  for (const entity of entities) {
    if (out.length >= maxImages) break;

    // ── 1. The curated option ──────────────────────────────────────
    try {
      const lead = await fetchWikipediaLeadImage(entity);
      if (lead && !seenUrls.has(lead.url)) {
        seenUrls.add(lead.url);
        out.push(lead);
        console.log("[generate-video]", entity, "→ Wikipedia lead image");
        continue;
      }
    } catch (e) {
      console.warn("[generate-video] Wikipedia lookup errored for", entity, String(e).slice(0, 120));
    }

    // ── 2. The backstop ────────────────────────────────────────────
    try {
      // `filetype:bitmap` keeps out SVG logos, PDFs and audio files,
      // which Commons search happily returns otherwise and FFmpeg
      // cannot read.
      const url =
        WIKI_ENDPOINT +
        "?action=query&format=json" +
        "&generator=search" +
        "&gsrsearch=" + encodeURIComponent(entity + " filetype:bitmap") +
        "&gsrnamespace=6" +          // File: namespace
        "&gsrlimit=12" +
        "&prop=imageinfo" +
        "&iiprop=url|size|mime|extmetadata" +
        "&iiurlwidth=1280";          // ask for a resized copy, not the 40MB original

      const res = await fetch(url, { headers: { "User-Agent": WIKI_UA } });
      if (!res.ok) {
        console.warn("[generate-video] Commons search failed for", entity, res.status);
        continue;
      }

      const data = await res.json();
      const pages = (data.query && data.query.pages) ? Object.values(data.query.pages) : [];

      // Commons returns search results unordered in the pages object;
      // `index` is the relevance ranking, so restore it.
      pages.sort((a, b) => (a.index || 999) - (b.index || 999));

      for (const page of pages) {
        const info = page.imageinfo && page.imageinfo[0];
        if (!info) continue;
        if (!/^image\/(jpeg|png)$/i.test(info.mime || "")) continue;

        const src = info.thumburl || info.url;
        if (!src || seenUrls.has(src)) continue;
        if ((info.thumbwidth || info.width || 0) < WIKI_MIN_WIDTH) continue;

        const meta = info.extmetadata || {};
        const licence = meta.LicenseShortName && meta.LicenseShortName.value;
        if (!licenceIsUsable(licence)) continue;

        const artist = stripHtml(meta.Artist && meta.Artist.value);
        const title = (page.title || "").replace(/^File:/, "");
        const needsCredit = !/^cc0|public domain|^pd[ -]/i.test(String(licence).trim());

        seenUrls.add(src);
        out.push({
          url: src,
          source: "commons",
          credit: needsCredit
            ? title + (artist ? " by " + artist : "") + " — " + licence + ", via Wikimedia Commons"
            : null,
        });
        console.log("[generate-video]", entity, "→ Commons search");
        break; // one per entity
      }
    } catch (e) {
      // Never fatal. A failed lookup just means this story is
      // illustrated the old way.
      console.warn("[generate-video] Commons lookup errored for", entity, String(e).slice(0, 120));
    }
  }

  return out;
}

/* ────────────────────────── PEXELS FETCHING ────────────────────────── */

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Recently-used Pexels IDs, for cross-video exclusion.
 *
 * Never throws. If the history lookup fails the render proceeds with an
 * empty set — a possibly-repeated photo is a far better outcome than a
 * failed video, and this table is an optimisation, not a dependency.
 */
async function fetchRecentlyUsedImageIds(supabase) {
  try {
    const cutoff = new Date(Date.now() - IMAGE_HISTORY_DAYS * 86400000).toISOString();
    const { data, error } = await supabase
      .from("used_images")
      .select("pexels_id")
      .gt("used_at", cutoff)
      .order("used_at", { ascending: false })
      .limit(IMAGE_HISTORY_LIMIT);

    if (error) {
      console.warn("[generate-video] image history lookup failed:", error.message);
      return new Set();
    }
    return new Set((data || []).map((r) => r.pexels_id));
  } catch (e) {
    console.warn("[generate-video] image history errored:", String(e).slice(0, 160));
    return new Set();
  }
}

/**
 * Records the Pexels IDs this render actually used.
 *
 * Upsert rather than insert: a photo allowed back in as a last resort
 * should have its timestamp refreshed, not collide on the primary key
 * and abort the batch.
 *
 * Called after the video is safely uploaded, and never fatal — losing a
 * history row means one photo might repeat sooner than intended, which
 * is not worth failing a finished render over.
 */
async function recordUsedImages(supabase, ids) {
  if (!ids.length) return;
  try {
    const now = new Date().toISOString();
    const rows = ids.map((id) => ({ pexels_id: id, used_at: now }));
    const { error } = await supabase
      .from("used_images")
      .upsert(rows, { onConflict: "pexels_id" });
    if (error) console.warn("[generate-video] image history write failed:", error.message);
  } catch (e) {
    console.warn("[generate-video] image history write errored:", String(e).slice(0, 160));
  }
}

// Fetches a POOL of candidates per query rather than exactly `count`,
// then dedupes by Pexels photo id and shuffles. Pulling a pool is what
// makes genuine variety possible: asking for exactly 5 and taking all 5
// means any duplicate or dud in that set has no replacement available.
//
// `excludeIds` holds photos used in the last IMAGE_HISTORY_DAYS. They're
// deprioritised rather than banned — see the selection step at the end.
//
// Returns [{ id, url }] so the caller can record what it used.
async function fetchPexelsImages(queries, count, apiKey, category, excludeIds) {
  if (count <= 0) return [];
  const exclude = excludeIds || new Set();

  const POOL_PER_QUERY = 15;
  const randomPage = () => 1 + Math.floor(Math.random() * 3);

  const search = async (q, orientation) => {
    const url =
      "https://api.pexels.com/v1/search?query=" +
      encodeURIComponent(q) +
      "&per_page=" + POOL_PER_QUERY +
      "&page=" + randomPage() +
      (orientation ? "&orientation=" + orientation : "");
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) throw new Error("Pexels request failed: " + res.status);
    const data = await res.json();
    return (data.photos || []).map((p) => ({
      id: p.id,
      url: p.src.large2x || p.src.large || p.src.original,
    }));
  };

  // Dedupe by photo ID, not URL — the same photo can surface across
  // several of our queries, and ID is the reliable identity.
  const seen = new Set();
  const pool = [];
  const addAll = (photos) => {
    for (const p of photos) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      pool.push(p);
    }
  };

  // Run the topic queries in parallel; a single failing query shouldn't
  // sink the whole render.
  const results = await Promise.all(
    queries.map((q) => search(q, "portrait").catch(() => []))
  );
  results.forEach(addAll);

  // Still thin? Widen in stages before ever considering a repeat.
  if (pool.length < count) {
    const catQueries = CATEGORY_FALLBACK[(category || "").toLowerCase()] || GENERIC_FALLBACK;
    const more = await Promise.all(
      catQueries.map((q) => search(q, "portrait").catch(() => []))
    );
    more.forEach(addAll);
  }

  // Dropping the portrait filter roughly triples the available pool.
  // We scale-and-crop to 720x1280 anyway, so a landscape source is
  // usable — just more aggressively cropped.
  //
  // The pool size that matters here is the pool of photos we haven't
  // already used, not the raw pool — otherwise a topic whose top
  // results all appeared last week would never widen.
  const freshCount = () => pool.filter((p) => !exclude.has(p.id)).length;

  if (freshCount() < count) {
    const anyOrientation = await Promise.all(
      queries.map((q) => search(q, null).catch(() => []))
    );
    anyOrientation.forEach(addAll);
  }

  // Shuffle so two videos on the same topic don't open on the same shot.
  //
  // Photos used in the last IMAGE_HISTORY_DAYS go to the back of the
  // queue rather than being dropped outright. A repeat is mildly
  // disappointing; a video that won't render because the good photos
  // were all used last month is worse. In practice the fresh set covers
  // it — the fallback only fires on genuinely thin topics.
  const fresh = shuffle(pool.filter((p) => !exclude.has(p.id)));
  const chosen = fresh.slice(0, count);

  if (chosen.length < count) {
    const stale = shuffle(pool.filter((p) => exclude.has(p.id)));
    const shortfall = count - chosen.length;
    chosen.push(...stale.slice(0, shortfall));
    if (stale.length) {
      console.warn(
        "[generate-video] reusing", Math.min(shortfall, stale.length),
        "previously-used photo(s) — fresh pool was only", fresh.length
      );
    }
  }

  return chosen.map((p) => ({ id: p.id, url: p.url }));
}

/* ──────────────────────── TEXT CARDS (tier 3) ───────────────────────

   The honest fallback. When we have no photograph of the actual
   subject and no confident stock query, we say what the story is
   rather than showing something that isn't it.

   Rendered as a still JPEG so it enters the pipeline as an ordinary
   image and needs no special handling downstream beyond skipping the
   Ken Burns zoom (see buildFilterComplex — zoompan defaults to
   x=0,y=0, i.e. zooming into the top-left corner, which would slide
   centred text out of frame over the segment).
*/

// ASS treats { } as override-tag delimiters and \ as an escape. Text
// pulled from a headline can contain all three. Newlines terminate the
// Dialogue line entirely, so they're flattened.
function assEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Roughly 560px of usable width at CARD_FONT_SIZE_MAX in Liberation
// Sans Bold works out around 26 characters per line. Long headlines get
// stepped down rather than overflowing the frame.
function cardFontSize(text) {
  const len = (text || "").length;
  if (len <= 60) return CARD_FONT_SIZE_MAX;
  if (len <= 100) return 50;
  if (len <= 140) return 44;
  return CARD_FONT_SIZE_MIN;
}

// Cards get their own .ass rather than reusing buildAss: different
// alignment (5 = centred both axes), no outline, larger margins, and a
// single event spanning the whole segment.
function buildCardAss(text, seconds) {
  const size = cardFontSize(text);
  return (
    "[Script Info]\n" +
    "ScriptType: v4.00+\n" +
    "PlayResX: " + WIDTH + "\n" +
    "PlayResY: " + HEIGHT + "\n" +
    "WrapStyle: 0\n" +
    "ScaledBorderAndShadow: yes\n\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    "Style: Card,Liberation Sans," + size + ",&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,80,80,0,1\n\n" +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    // \pos overrides Alignment's centring so the text sits above the
    // caption band (captions use MarginV=150 from the bottom).
    "Dialogue: 0,0:00:00.00," + assTimestamp(seconds) +
    ",Card,,0,0,0,,{\\pos(360,470)}" + assEscape(text) + "\n"
  );
}

/**
 * Renders one text card to a JPEG.
 *
 * `color` lavfi source for the background, libass for the text. NOT
 * drawtext — Vercel's bundled static FFmpeg doesn't include it, which
 * is the same reason captions go through libass.
 */
async function renderTextCard(text, workDir, index) {
  const assPath = path.join(workDir, "card" + index + ".ass");
  const outPath = path.join(workDir, "card" + index + ".jpg");

  await fs.writeFile(assPath, buildCardAss(text, 5), "utf8");

  await execFileAsync(ffmpegPath, [
    "-f", "lavfi",
    "-i", "color=c=" + CARD_BG + ":s=" + WIDTH + "x" + HEIGHT + ":d=1",
    "-vf", "subtitles=" + assPath + ":fontsdir=" + FONTS_DIR,
    "-frames:v", "1",
    "-q:v", "2",
    "-y", outPath,
  ]);

  return outPath;
}

async function downloadToFile(url, destPath) {
  // Commons will reject a request with no User-Agent; Pexels does not
  // care. Sending it to both is simpler than branching.
  const res = await fetch(url, { headers: { "User-Agent": WIKI_UA } });
  if (!res.ok) throw new Error("Failed to download " + url + ": " + res.status);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

/* ─────────────────────────── AUDIO / CAPTIONS ─────────────────────────── */

// Measures the real narration length instead of assuming 30 seconds.
// Running `ffmpeg -i file` with no output prints Duration to stderr
// before erroring — avoids bundling ffprobe as a second binary.
async function getAudioDuration(audioPath) {
  try {
    await execFileAsync(ffmpegPath, ["-i", audioPath]);
    return FALLBACK_DURATION_SECONDS;
  } catch (e) {
    const output = (e.stderr || e.message || "").toString();
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return FALLBACK_DURATION_SECONDS;
    const [, h, m, s] = match;
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
  }
}

function buildCaptionChunks(script, totalSeconds) {
  const words = script.trim().split(/\s+/);
  const chunkSize = 4;
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }
  const perChunk = totalSeconds / chunks.length;
  return chunks.map((text, i) => ({
    text,
    start: (i * perChunk).toFixed(2),
    end: ((i + 1) * perChunk).toFixed(2),
  }));
}

function assTimestamp(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
  const pad = (n, len) => String(n).padStart(len, "0");
  return h + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(cs, 2);
}

// Style is baked into the .ass file's own [V4+ Styles] section rather
// than passed via force_style on a bare .srt — force_style proved
// unreliable in testing (captions ignored MarginV/Alignment entirely).
// PlayResX/Y must match the real output resolution or positioning drifts.
//
// BorderStyle=1 is outline mode: "Outline" is stroke thickness around
// each letter. (In BorderStyle=3, box mode, that same field is box
// padding — and with Outline=0 the box silently collapses to nothing.)
function buildAss(captionChunks) {
  const header =
    "[Script Info]\n" +
    "ScriptType: v4.00+\n" +
    "PlayResX: " + WIDTH + "\n" +
    "PlayResY: " + HEIGHT + "\n" +
    "ScaledBorderAndShadow: yes\n\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    "Style: Default,Liberation Sans,68,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,2,2,40,40,150,1\n\n" +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  // assEscape: a script containing { } or \ would otherwise be read as
  // an ASS override tag and silently swallow text.
  const events = captionChunks.map((c) =>
    "Dialogue: 0," + assTimestamp(parseFloat(c.start)) + "," + assTimestamp(parseFloat(c.end)) + ",Default,,0,0,0,," + assEscape(c.text)
  ).join("\n");

  return header + events;
}

/* ──────────────────────── SLIDE ASSEMBLY ────────────────────────────

   Entity photos first, then stock or card, alternating after the
   opener.

   The first frame is the one that decides whether someone keeps
   watching, so if we have a photograph of the actual subject it leads.
   After that they alternate: back-to-back Commons images tend to look
   like an encyclopedia entry, and back-to-back stock looks like a
   corporate explainer. Alternating reads as edited.

   Cards occupy the same position stock would have. That is deliberate
   — slide two is where the retention cliff sits, so if we don't have a
   defensible photo for that slot, a card goes there rather than a
   guess.

   Each item is { path?, url?, source } so the caller can log which
   tier produced each slide.
*/
function assembleSlides(entityItems, stockItems, cardItems, total) {
  const out = [];
  let e = 0, s = 0, c = 0;

  if (entityItems.length) out.push(entityItems[e++]);

  while (out.length < total) {
    let pushed = false;

    if (s < stockItems.length) {
      out.push(stockItems[s++]);
      pushed = true;
    } else if (c < cardItems.length) {
      out.push(cardItems[c++]);
      pushed = true;
    }

    if (out.length < total && e < entityItems.length) {
      out.push(entityItems[e++]);
      pushed = true;
    }

    if (!pushed) break;
  }

  return out.slice(0, total);
}

/* ──────────────────────────── FFMPEG GRAPH ──────────────────────────── */

// `slides` is [{ path, isCard }]. Cards skip zoompan: the filter
// defaults to x=0,y=0, so it zooms into the top-left corner rather than
// the centre. That's unobjectionable on a photograph and disastrous on
// centred text, which would drift out of frame across the segment.
function buildFilterComplex(slides, assPath, fontsDir, totalSeconds) {
  const perImageSeconds = totalSeconds / slides.length;
  const framesPerImage = Math.max(1, Math.round(perImageSeconds * FPS));

  // Zoom ramps from 1.0 to ZOOM_MAX across the segment. Derived from the
  // frame count so the pace is identical whatever the segment length.
  const ZOOM_MAX = 1.15;
  const zoomStep = (ZOOM_MAX - 1) / framesPerImage;

  const parts = [];
  const labels = [];

  slides.forEach((slide, i) => {
    const base =
      "[" + i + ":v]scale=" + WIDTH + ":" + HEIGHT + ":force_original_aspect_ratio=increase," +
      "crop=" + WIDTH + ":" + HEIGHT + "," +
      "setsar=1,";

    if (slide.isCard) {
      // Static. fps= pins the segment to the timeline rate so the
      // concat downstream sees a consistent stream.
      parts.push(base + "fps=" + FPS + "[v" + i + "]");
    } else {
      parts.push(
        base +
        // d=1 — one output frame per input frame. The input is already a
        // looped image stream of the right length, so anything higher
        // multiplies the frame count (this was the whole-video-is-one-image
        // bug). `on` is the output frame index, giving a smooth linear ramp
        // without relying on zoom accumulating between frames.
        "zoompan=z='min(1+" + zoomStep.toFixed(6) + "*on," + ZOOM_MAX + ")'" +
        ":d=1:s=" + WIDTH + "x" + HEIGHT + ":fps=" + FPS +
        "[v" + i + "]"
      );
    }

    labels.push("[v" + i + "]");
  });

  parts.push(labels.join("") + "concat=n=" + slides.length + ":v=1:a=0[vconcat]");

  // Captions burned in via libass's `subtitles` filter, not `drawtext` —
  // Vercel's bundled static FFmpeg has no drawtext ("No such filter"),
  // but does include libass.
  //
  // `fontsdir` points libass at the font bundled in this repo. Vercel's
  // serverless environment ships NO system fonts, and libass silently
  // draws nothing rather than erroring when it can't find one.
  parts.push("[vconcat]subtitles=" + assPath + ":fontsdir=" + fontsDir + "[vout]");

  return { filterComplex: parts.join(";"), finalLabel: "vout" };
}

/* ──────────────────────────────  HANDLER  ────────────────────────────── */

export default async function handler(req, res) {
  /* Locked for the same reason as generate-audio: Pexels calls, Supabase
     storage and a full FFmpeg render, all billable, all previously
     reachable by anyone who found the URL.

     process.js calls this internally with x-pipeline-secret (the header
     that also bypasses the rate limit below); a bearer token covers any
     other legitimate caller. Anything else gets a 401. */
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[generate-video] CRON_SECRET not configured — refusing to run");
    res.status(500).json({ error: "Not configured" });
    return;
  }
  const pipelineSecret = process.env.PIPELINE_SECRET || secret;
  const bearerOk = req.headers.authorization === "Bearer " + secret;
  const pipelineOk =
    req.headers["x-pipeline-secret"] === secret ||
    req.headers["x-pipeline-secret"] === pipelineSecret;
  if (!bearerOk && !pipelineOk) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  // Kill switch. Set PIPELINE_ENABLED=false in Vercel to stop every
  // render immediately, with no redeploy, if something starts burning
  // quota or money unexpectedly.
  if (process.env.PIPELINE_ENABLED === "false") {
    res.status(503).json({ error: "Video pipeline is currently disabled" });
    return;
  }

  // Rendering is the most expensive and slowest operation in the stack,
  // so this doubles as protection against concurrent renders piling up
  // against Vercel's function time limit.
  if (!(await enforceRateLimit(req, res, "generate-video", 5, 60))) return;

  const { jobId, headline, category } = req.body || {};
  if (!jobId || !headline) {
    res.status(400).json({ error: "jobId and headline are both required" });
    return;
  }

  const pexelsKey = process.env.PEXELS_API_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!pexelsKey || !supabaseUrl || !serviceKey) {
    console.error("[generate-video] missing config", {
      PEXELS_API_KEY: !!pexelsKey,
      VITE_SUPABASE_URL: !!supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: !!serviceKey,
    });
    res.status(500).json({ error: "Server is not configured for video rendering" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: job, error: fetchErr } = await supabase
    .from("video_jobs").select("*").eq("id", jobId).single();
  if (fetchErr || !job) {
    res.status(404).json({ error: "Job not found: " + jobId });
    return;
  }
  if (!job.audio_url) {
    res.status(400).json({ error: "This job has no audio yet — run /api/generate-audio.js first" });
    return;
  }

  const workDir = path.join(os.tmpdir(), "news30-" + jobId);
  await fs.mkdir(workDir, { recursive: true });

  try {
    await supabase.from("video_jobs")
      .update({ status: "rendering", updated_at: new Date().toISOString() })
      .eq("id", jobId);

    // Images and audio don't depend on each other, so fetch both at once —
    // wall-clock time matters against Vercel's 60s function limit.
    const audioPath = path.join(workDir, "audio.mp3");
    let imageCredits = [];
    let imageSources = [];
    let usedPexelsIds = [];

    const [slidePaths] = await Promise.all([
      (async () => {
        const entities = Array.isArray(job.entities)
          ? job.entities.filter((e) => typeof e === "string" && e.trim()).slice(0, MAX_ENTITY_IMAGES)
          : [];

        /* ── TIER 1: real photographs of the actual subject ─────────
           Skipped entirely for thematic stories, which have no
           entities and are better served by stock anyway. */
        let entityImages = [];
        if (entities.length) {
          entityImages = await fetchWikimediaImages(entities, MAX_ENTITY_IMAGES);
          console.log(
            "[generate-video] entities:", entities.join(" | "),
            "→", entityImages.length, "Commons images"
          );
        }
        imageCredits = entityImages.map((i) => i.credit).filter(Boolean);

        /* ── TIER 2: stock, but only when we can defend it ──────────

           The gate, not the query. Two things decide whether Pexels
           runs at all:

             - a purely thematic story (no entities) is exactly what
               stock is for, and always has been; or
             - the headline scored a real hit on the keyword map, so we
               know which visual bucket it belongs to.

           DeepSeek's image_queries are deliberately NOT sufficient on
           their own for an entity-led story. Those queries are what
           put an unrelated boutique next to narration about Walmart:
           the model correctly described "clothing retail", Pexels
           correctly returned clothing retail, and the viewer correctly
           concluded we had no footage of Walmart. The model's phrases
           still drive the SEARCH — they're better than the keyword map
           at describing what a story looks like — they just no longer
           authorise searching. */
        const keywordMatch = getStockQueries(headline, category);
        const isThematic = entities.length === 0;
        let stockAllowed = isThematic || keywordMatch.confident;

        const fromModel = Array.isArray(job.image_queries) ? job.image_queries : [];
        const usingModel = fromModel.length > 0;
        const queries = usingModel ? fromModel : keywordMatch.queries;

        /* ── TIER 3: the honest fallback ────────────────────────────
           Capped at MAX_CARDS. Two identical headline cards is the
           repeated-image bug wearing a hat, and three slides over 16s
           is normal news pacing. */
        const cardSlots = stockAllowed ? 0 : Math.min(MAX_CARDS, IMAGE_COUNT - entityImages.length);

        // Would entity photos + cards leave us too short to render?
        // Release the gate rather than fail — a possibly-generic photo
        // beats no video. Logged loudly so it's visible in
        // image_sources afterwards.
        if (!stockAllowed && entityImages.length + cardSlots < MIN_IMAGE_COUNT) {
          console.warn(
            "[generate-video] stock gate released as last resort —",
            entityImages.length, "entity +", cardSlots, "card <", MIN_IMAGE_COUNT
          );
          stockAllowed = true;
        }

        console.log(
          "[generate-video] stock", stockAllowed ? "ALLOWED" : "BLOCKED",
          "(" + (isThematic ? "thematic" : "entity-led") +
          ", keyword score " + keywordMatch.score + ")",
          "| queries (" + (usingModel ? "model" : "keyword map") + "):",
          queries.join(" | ")
        );

        let stockPhotos = [];
        if (stockAllowed) {
          try {
            // Cross-video history. Fetched only when stock is actually
            // going to run — no point querying it on an entity-led or
            // card-filled story.
            const recentlyUsed = await fetchRecentlyUsedImageIds(supabase);
            console.log("[generate-video] excluding", recentlyUsed.size, "recently-used photos");

            stockPhotos = await fetchPexelsImages(
              queries, IMAGE_COUNT - entityImages.length, pexelsKey, category, recentlyUsed
            );
          } catch (e) {
            // A Pexels failure is survivable if Commons already gave us
            // enough to work with — the check below decides.
            console.warn("[generate-video] Pexels failed:", String(e).slice(0, 160));
          }
        }

        // Cards are rendered only if they'll actually be used. Recompute
        // now that we know how much stock actually came back.
        const stillShort = IMAGE_COUNT - entityImages.length - stockPhotos.length;
        const cardsToRender = Math.min(MAX_CARDS, Math.max(cardSlots, stillShort > 0 ? 1 : 0));

        const cardItems = [];
        for (let i = 0; i < cardsToRender; i++) {
          try {
            const p = await renderTextCard(headline, workDir, i);
            cardItems.push({ path: p, source: "card", isCard: true });
            console.log("[generate-video] rendered text card", i);
          } catch (e) {
            // A card that won't render is not worth failing over; the
            // MIN_IMAGE_COUNT check below is the real backstop.
            console.warn("[generate-video] card render failed:", String(e).slice(0, 200));
          }
        }

        const entityItems = entityImages.map((i) => ({
          url: i.url, source: i.source, isCard: false,
        }));
        const stockItems = stockPhotos.map((p) => ({
          url: p.url, pexelsId: p.id, source: "pexels", isCard: false,
        }));

        const slides = assembleSlides(entityItems, stockItems, cardItems, IMAGE_COUNT);

        if (slides.length < MIN_IMAGE_COUNT) {
          throw new Error(
            "Only " + slides.length + " usable slides (" + entityImages.length +
            " Commons, " + stockPhotos.length + " Pexels, " + cardItems.length +
            " card) for: " + queries.join(" / ")
          );
        }

        imageSources = slides.map((s) => s.source);
        // Only what actually made the cut — assembleSlides may drop
        // surplus photos when entity images and cards fill the video.
        usedPexelsIds = slides.map((s) => s.pexelsId).filter((id) => id != null);
        console.log("[generate-video] slide order:", imageSources.join(" → "));

        // Cards are already on disk; everything else needs downloading.
        return Promise.all(slides.map(async (slide, i) => {
          if (slide.isCard) return { path: slide.path, isCard: true };
          const dest = path.join(workDir, "img" + i + ".jpg");
          await downloadToFile(slide.url, dest);
          return { path: dest, isCard: false };
        }));
      })(),
      downloadToFile(job.audio_url, audioPath),
    ]);

    // Real narration length — everything below (caption timing, per-image
    // duration, total video length) derives from this rather than a fixed
    // 30s assumption, which is what caused captions to drift on longer
    // scripts.
    const realDuration = await getAudioDuration(audioPath);
    const segmentSeconds = realDuration / slidePaths.length;

    const captionChunks = buildCaptionChunks(job.script || headline, realDuration);
    const assPath = path.join(workDir, "captions.ass");
    await fs.writeFile(assPath, buildAss(captionChunks), "utf8");
    const { filterComplex, finalLabel } = buildFilterComplex(slidePaths, assPath, FONTS_DIR, realDuration);

    const outputPath = path.join(workDir, "output.mp4");
    const args = [];
    slidePaths.forEach((s) => {
      // -framerate pins the looped still to our timeline fps, so the
      // input frame count is exactly segmentSeconds * FPS and lines up
      // with the zoom ramp computed in buildFilterComplex.
      args.push("-loop", "1", "-framerate", String(FPS), "-t", segmentSeconds.toFixed(3), "-i", s.path);
    });
    args.push("-i", audioPath);
    args.push(
      "-filter_complex", filterComplex,
      "-map", "[" + finalLabel + "]",
      "-map", slidePaths.length + ":a",
      // Size-capped encode — see fix #8 in the header. -crf is the
      // quality target and does the real work; -maxrate is only a hard
      // ceiling for a pathologically busy scene (~9 MB for 30s), which
      // normal output never approaches.
      "-c:v", "libx264", "-preset", "superfast", "-crf", "25",
      "-maxrate", "2500k", "-bufsize", "5000k", "-pix_fmt", "yuv420p",
      "-r", String(FPS),
      // Narration is a single voice; 96k AAC is indistinguishable from
      // the default and saves a little more per file.
      "-c:a", "aac", "-b:a", "96k",
      // Moves the index to the front so the site's <video> can start
      // playing before the whole file has downloaded.
      "-movflags", "+faststart",
      "-shortest",
      "-y", outputPath
    );

    await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 });

    // ── Thumbnail ───────────────────────────────────────────────────
    // Grabbed from the finished video rather than reusing a source
    // image, for three reasons: it is guaranteed to match what actually
    // plays, it already carries the Ken Burns crop and burned-in
    // caption so the card previews the real thing, and it sidesteps any
    // question about republishing a stock image as cover art.
    //
    // Taken ~1.5s in — far enough past the first frame to have zoomed
    // slightly and to usually have a caption on screen.
    const thumbPath = path.join(workDir, "thumb.jpg");
    let thumbnailUrl = null;
    try {
      await execFileAsync(ffmpegPath, [
        "-ss", "1.5",
        "-i", outputPath,
        "-frames:v", "1",
        "-q:v", "3",
        "-y", thumbPath,
      ]);

      const thumbBuffer = await fs.readFile(thumbPath);
      const thumbFilePath = "thumb/" + jobId + ".jpg";
      const { error: thumbErr } = await supabase.storage
        .from("media")
        .upload(thumbFilePath, thumbBuffer, { contentType: "image/jpeg", upsert: true });

      if (thumbErr) {
        // A missing thumbnail is a cosmetic problem; a missing video is
        // not. Never fail the render over cover art — the front end
        // falls back to generated artwork.
        console.error("[generate-video] thumbnail upload failed:", thumbErr);
      } else {
        const { data: thumbUrlData } = supabase.storage.from("media").getPublicUrl(thumbFilePath);
        thumbnailUrl = thumbUrlData.publicUrl;
      }
    } catch (e) {
      console.error("[generate-video] thumbnail extraction failed:", e);
    }

    const videoBuffer = await fs.readFile(outputPath);
    const filePath = "video/" + jobId + ".mp4";
    const { error: uploadErr } = await supabase.storage
      .from("media")
      .upload(filePath, videoBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadErr) throw new Error("Storage upload failed: " + uploadErr.message);

    const { data: publicUrlData } = supabase.storage.from("media").getPublicUrl(filePath);
    const videoUrl = publicUrlData.publicUrl;

    await supabase.from("video_jobs")
      .update({
        status: "done",
        video_url: videoUrl,
        thumbnail_url: thumbnailUrl,
        // Credit lines for any CC-BY / CC-BY-SA image used. Empty for
        // stories illustrated entirely with stock or public-domain
        // files. Paste these into the YouTube description.
        image_credits: imageCredits.length ? imageCredits : null,
        // Which tier produced each slide, in order. This is the whole
        // point of the logging: if "pexels" still dominates slide two,
        // the gate isn't tight enough; if "card" dominates everywhere,
        // entity extraction upstream is the real problem and no amount
        // of fallback tuning will fix it.
        image_sources: imageSources.length ? imageSources : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    // Written only after the video is safely uploaded — recording a
    // photo as used when the render then failed would burn it out of
    // the pool for a month for nothing.
    await recordUsedImages(supabase, usedPexelsIds);

    if (imageCredits.length) {
      console.log("[generate-video] attribution required:", imageCredits.join(" // "));
    }

    res.status(200).json({
      jobId,
      videoUrl,
      thumbnailUrl,
      durationSeconds: Number(realDuration.toFixed(2)),
      status: "done",
      imageCount: slidePaths.length,
      imageCredits,
      imageSources,
    });
  } catch (e) {
    console.error("[generate-video] render failed:", e);
    await supabase.from("video_jobs")
      .update({ status: "failed", error: String(e).slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", jobId);
    res.status(500).json({ error: "Video render failed" });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
