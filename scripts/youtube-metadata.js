// scripts/youtube-metadata.js
// Builds the YouTube snippet (title, description, tags, category) for a
// published_stories row. Pure functions, no I/O, so they can be tested
// without credentials. Used by scripts/upload.js.

import { storyPath } from "../src/slug.js";

const SITE_URL = "https://www.news30.live";

// YouTube truncates hard at 100 characters and rejects < > outright.
const TITLE_LIMIT = 100;
const TITLE_SUFFIX = " #Shorts";
const DESCRIPTION_LIMIT = 4900; // YouTube's limit is 5000 bytes; leave headroom
const SUMMARY_LIMIT = 220;
const MAX_TAGS = 10;
const TAGS_CHAR_LIMIT = 450; // YouTube caps all tags together at 500

// YouTube category ids.
const CATEGORY_SPORTS = "17";
const CATEGORY_NEWS_POLITICS = "25";

// Same mapping as CATEGORY_ALIASES in src/App.jsx / api/seo.js.
const CATEGORY_ALIASES = {
  geopolitics: "geopolitics", world: "geopolitics", politics: "geopolitics", general: "geopolitics",
  finance: "finance", business: "finance", markets: "finance", economy: "finance",
  sports: "sports", sport: "sports",
};
const normaliseCategory = (c) => CATEGORY_ALIASES[String(c || "").toLowerCase()] || "geopolitics";

const CATEGORY_HASHTAG = { geopolitics: "WorldNews", finance: "Finance", sports: "Sports" };

const stripUnsafe = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/[\p{Extended_Pictographic}‍️]/gu, "");

const outletName = (story) => {
  const src = String(story.source || "").replace(/\.(com|org|net|co\.uk)$/i, "").trim();
  if (src) return src;
  try {
    return new URL(story.article_url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** entities may arrive as a jsonb array or (older rows / text columns) a JSON string. */
export function storyEntities(story) {
  let e = story.entities;
  if (typeof e === "string") {
    try {
      e = JSON.parse(e);
    } catch {
      e = [];
    }
  }
  if (!Array.isArray(e)) return [];
  return e
    .filter((x) => typeof x === "string")
    // "US Open (tennis)" is an archive disambiguator, not something people type.
    .map((x) => x.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim())
    // "Arsenal F.C." → "Arsenal": nobody searches the club suffix.
    .map((x) => x.replace(/\s+(A\.?F\.?C|F\.?C|C\.?F|S\.?C)\.?$/i, "").trim())
    .filter((x) => x.length > 1)
    .filter((x, i, arr) => arr.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
}

/* ───────────── title ───────────── */

export function cleanHeadline(headline) {
  // The headline regex in ingest.js strips a trailing " - Reuters" but
  // not a leading "Exclusive | ". Both are outlet furniture and neither
  // belongs in a Shorts title.
  return stripUnsafe(headline)
    .replace(/^\s*(exclusive|breaking|analysis|opinion|watch|video|live)\s*[|:—–-]\s*/i, "")
    .replace(/\s+[-|–—]\s+[^-|–—]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildTitle(story) {
  // youtube_title is written by the script model (<= 60 chars, name
  // first, no outlet). Fall back to the cleaned headline for older rows
  // or when the model's title was rejected.
  let title = stripUnsafe(story.youtube_title).replace(/\s+/g, " ").trim() || cleanHeadline(story.headline);
  // #Shorts in the title is not required — YouTube classifies by aspect
  // ratio and duration — but it costs nothing and still helps surfacing.
  if (title.length + TITLE_SUFFIX.length > TITLE_LIMIT) {
    title = title.slice(0, TITLE_LIMIT - TITLE_SUFFIX.length - 1).trimEnd() + "…";
  }
  return title + TITLE_SUFFIX;
}

/* ───────────── hashtags & tags ───────────── */

/** "Premier League" → "PremierLeague", "Côte d'Ivoire" → "CoteDIvoire". */
export function toHashtag(text) {
  const words = String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const tag = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  if (!tag || /^\d+$/.test(tag) || tag.length > 30) return null;
  return tag;
}

/** "#News" plus two from the entities (most specific first), topped up from the category. */
export function buildHashtags(story) {
  const picked = ["News"];
  const candidates = [...storyEntities(story).map(toHashtag), CATEGORY_HASHTAG[normaliseCategory(story.category)]];
  for (const tag of candidates) {
    if (picked.length >= 3) break;
    if (tag && !picked.some((p) => p.toLowerCase() === tag.toLowerCase())) picked.push(tag);
  }
  return picked.map((t) => "#" + t);
}

export function buildTags(story) {
  const raw = [...storyEntities(story), normaliseCategory(story.category), "news"];
  const tags = [];
  let total = 0;
  for (const t of raw) {
    const tag = stripUnsafe(t).replace(/[,"]/g, "").trim();
    if (!tag || tags.some((x) => x.toLowerCase() === tag.toLowerCase())) continue;
    if (tags.length >= MAX_TAGS || total + tag.length > TAGS_CHAR_LIMIT) break;
    tags.push(tag);
    total += tag.length + 1;
  }
  return tags;
}

/* ───────────── description ───────────── */

const sentencesOf = (text) =>
  (String(text || "").match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || []).map((s) => s.trim()).filter(Boolean);

/** 1–2 sentences, key names first. This is the part YouTube shows in search. */
export function buildSummary(story) {
  const sentences = sentencesOf(story.script);
  const title = stripUnsafe(story.youtube_title).trim();
  if (!sentences.length) return title || cleanHeadline(story.headline);

  let summary = sentences[0];
  if (sentences[1] && summary.length + 1 + sentences[1].length <= SUMMARY_LIMIT) summary += " " + sentences[1];

  // The script's hook usually leads with the subject, but not always. If
  // the main entity isn't in the summary, lead with the title, which the
  // prompt requires to start with it.
  const lead = storyEntities(story)[0];
  if (lead && title && !summary.toLowerCase().includes(lead.toLowerCase())) {
    summary = title.replace(/[.\s]+$/, "") + ". " + sentences[0];
  }
  return stripUnsafe(summary);
}

export function storyUrl(story) {
  return SITE_URL + storyPath(story.id, story.headline);
}

export function buildDescription(story) {
  const head = [buildSummary(story), "", "Full story, sources and a quiz: " + storyUrl(story)];

  // Attribution matters here: these are summaries of other newsrooms'
  // reporting, and saying so is both honest and the thing that keeps
  // this on the right side of a copyright complaint.
  const tail = [];
  const outlet = outletName(story);
  if (outlet || story.article_url) {
    tail.push("");
    if (outlet) tail.push("Source: " + stripUnsafe(outlet));
    if (story.article_url) tail.push(stripUnsafe(story.article_url));
  }
  tail.push("", buildHashtags(story).join(" "));

  // The script is the only part that gets cut if the whole thing is too
  // long, so the link, the source credit and the hashtags always survive.
  const fixed = head.join("\n").length + tail.join("\n").length + 4;
  let script = stripUnsafe(story.script).trim();
  const room = DESCRIPTION_LIMIT - fixed;
  if (script.length > room) script = room > 20 ? script.slice(0, room - 1).trimEnd() + "…" : "";

  return [...head, ...(script ? ["", script] : []), ...tail].join("\n");
}

/* ───────────── snippet ───────────── */

export function buildSnippet(story) {
  return {
    title: buildTitle(story),
    description: buildDescription(story),
    tags: buildTags(story),
    categoryId: normaliseCategory(story.category) === "sports" ? CATEGORY_SPORTS : CATEGORY_NEWS_POLITICS,
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
  };
}
