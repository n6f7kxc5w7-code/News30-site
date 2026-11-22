// /api/seo.js
// Server-rendered HTML for crawlers (and first paint) — ONE function on
// purpose (Vercel Hobby caps the function count). vercel.json rewrites:
//
//   /                      → ?page=home
//   /story/<slug>-<uuid>   → ?page=story&slug=<slug>-<uuid>
//   /geopolitics|finance|sports → ?page=category&cat=<name>
//   /sitemap.xml           → ?page=sitemap
//
// Every HTML page is the built SPA shell (dist/app.html — the build
// renames index.html so "/" isn't served statically and reaches us)
// with two things swapped in:
//   • the <!-- seo:start --> … <!-- seo:end --> block in <head>
//   • the contents of <div id="root">, as plain HTML that React
//     replaces when it mounts. Google gets the full text with no JS.
//
// Reads Supabase over REST with the public anon key (same access the
// browser already has); falls back to the service key if anon is unset.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, optional SITE_URL
// (default https://news30.live), optional GOOGLE_SITE_VERIFICATION.

import { storyPath, uuidFromSlug } from "../src/slug.js";

const SITE_URL = (process.env.SITE_URL || "https://news30.live").replace(/\/+$/, "");
const SITE_NAME = "News30";
const THIN_WORDS = 40;               // below this a story page is noindex
const THUMB_MAX_AGE_DAYS = 29;       // thumbnails are swept after 30 days (api/cron/ingest.js)
const SITEMAP_MAX = 50000;           // sitemaps.org per-file limit (incl. home + categories)
const PAGE_ROWS = 1000;              // PostgREST default max rows per request

const CATEGORIES = {
  geopolitics: {
    label: "Geopolitics",
    title: "Geopolitics news in 30 seconds",
    description: "The latest world politics, diplomacy and conflict stories, each condensed by AI into a 30-second summary with the original source credited.",
  },
  finance: {
    label: "Finance",
    title: "Finance and markets news in 30 seconds",
    description: "The latest markets, business and economy stories, each condensed by AI into a 30-second summary with the original source credited.",
  },
  sports: {
    label: "Sports",
    title: "Sports news in 30 seconds",
    description: "The latest sports results and stories, each condensed by AI into a 30-second summary with the original source credited.",
  },
};
// Same mapping as CATEGORY_ALIASES in src/App.jsx.
const CATEGORY_ALIASES = {
  geopolitics: "geopolitics", world: "geopolitics", politics: "geopolitics", general: "geopolitics",
  finance: "finance", business: "finance", markets: "finance", economy: "finance",
  sports: "sports", sport: "sports",
};
const normaliseCategory = (c) => CATEGORY_ALIASES[String(c || "").toLowerCase()] || "geopolitics";

const HOME_TITLE = "News30 — AI-condensed news in 30 seconds";
const HOME_DESCRIPTION =
  "News30 condenses the day's top geopolitics, finance and sports stories into 30-second AI video summaries, with the original source credited and linked on every story.";

const CACHE = {
  page: "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
  story: "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
  sitemap: "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
  missing: "public, max-age=0, s-maxage=60",
  error: "no-store",
};

/* ───────────────────────── helpers ───────────────────────── */

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// JSON-LD inside <script>: stop "</script>" and friends breaking out.
const jsonLd = (obj) =>
  '<script type="application/ld+json">' +
  JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026") +
  "</script>";

const wordCount = (s) => (String(s || "").trim().match(/\S+/g) || []).length;

function truncate(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

const sourceName = (s) => String(s || "").replace(/\.(com|org|net|co\.uk)$/i, "").trim() || "the original publisher";

const isoDate = (d) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const humanDate = (d) => {
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

const safeHttpUrl = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
};

// Thumbnails older than THUMB_MAX_AGE_DAYS have been deleted from storage
// but thumbnail_url is never cleared — don't advertise a 404 image.
const liveThumb = (row) => {
  const url = safeHttpUrl(row.thumbnail_url);
  if (!url) return null;
  const t = Date.parse(row.created_at);
  if (Number.isFinite(t) && Date.now() - t > THUMB_MAX_AGE_DAYS * 86400000) return null;
  return url;
};

const absolute = (path) => SITE_URL + path;
const pathFor = (row) => storyPath(row.id, row.headline);

/* ───────────────────────── Supabase ───────────────────────── */

function supabaseConfig() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
  return { url: url.replace(/\/+$/, ""), key };
}

async function sbSelect(query, { from, to } = {}) {
  const { url, key } = supabaseConfig();
  const headers = { apikey: key, Authorization: "Bearer " + key, Accept: "application/json" };
  if (from != null) headers.Range = from + "-" + to;
  const res = await fetch(url + "/rest/v1/published_stories?" + query, { headers });
  if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

const LIST_COLS = "id,headline,category,source,created_at";
const STORY_COLS =
  "id,headline,script,category,source,article_url,article_published,created_at,thumbnail_url,video_url,duration_seconds";

// Latest ready stories (light columns), memoised briefly per instance.
let latestMemo = { at: 0, rows: null };
async function latestStories() {
  if (latestMemo.rows && Date.now() - latestMemo.at < 60000) return latestMemo.rows;
  const rows = await sbSelect(
    "select=" + LIST_COLS + "&status=eq.ready&order=created_at.desc&limit=300"
  );
  latestMemo = { at: Date.now(), rows };
  return rows;
}

/* ───────────────────────── template ───────────────────────── */

let templateMemo = { at: 0, html: null };

const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#0f0f0f" />
<style>html,body{background:#0f0f0f}</style>
<!-- seo:start --><!-- seo:end -->
</head>
<body><div id="root"></div></body>
</html>`;

async function getTemplate(req) {
  if (templateMemo.html && Date.now() - templateMemo.at < 300000) return templateMemo.html;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") ? "http" : "https");
  const origin = process.env.SEO_TEMPLATE_ORIGIN || (host ? proto + "://" + host : SITE_URL);
  try {
    const res = await fetch(origin + "/app.html", { headers: { "x-news30-seo": "template" } });
    const html = res.ok ? await res.text() : "";
    if (html.includes("<!-- seo:start") && html.includes('<div id="root">')) {
      templateMemo = { at: Date.now(), html };
      return html;
    }
    console.error("[seo] app.html fetch unusable:", res.status);
  } catch (e) {
    console.error("[seo] app.html fetch failed:", String(e).slice(0, 200));
  }
  // Without the shell the page still carries all its SEO content; it
  // just won't boot the app. Not memoised, so the next request retries.
  return FALLBACK_TEMPLATE;
}

function render(template, { head, body, rootAttrs = "" }) {
  return template
    .replace(/<!-- seo:start[\s\S]*?<!-- seo:end -->/, () => head)
    .replace(/<div id="root">\s*<\/div>/, () => '<div id="root"' + rootAttrs + ">" + body + "</div>");
}

// Styles for the server-rendered markup. Scoped to .n30s; harmless once
// React has replaced it. Also what visitors see on a story whose video
// has expired (main.jsx doesn't mount the app over those).
const STATIC_CSS = `<style>
.n30s{color:#f1f1f1;font:16px/1.6 Roboto,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;max-width:760px;margin:0 auto;padding:16px 16px 48px}
.n30s a{color:#8ab4f8}
.n30s header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:8px 0 20px;border-bottom:1px solid #303030;margin-bottom:24px}
.n30s .brand{font-weight:800;font-size:22px;color:#fff;text-decoration:none}
.n30s .brand b{color:#ff3b30}
.n30s nav a{color:#ccc;text-decoration:none;margin-right:16px;font-weight:500}
.n30s h1{font-size:28px;line-height:1.25;margin:4px 0 12px}
.n30s h2{font-size:18px;margin:32px 0 12px}
.n30s .meta,.n30s .note,.n30s time{color:#aaa;font-size:14px}
.n30s .note{border-left:3px solid #8ab4f8;padding:8px 12px;background:#1a1a1a;border-radius:4px}
.n30s .kicker{text-transform:uppercase;letter-spacing:.06em;font-size:13px;font-weight:700;margin:0}
.n30s .kicker a{text-decoration:none}
.n30s img.thumb{width:100%;height:auto;border-radius:12px;margin:8px 0 16px;aspect-ratio:16/9;object-fit:cover;background:#1a1a1a}
.n30s ul.list{list-style:none;padding:0;margin:0}
.n30s ul.list li{padding:10px 0;border-bottom:1px solid #262626}
.n30s ul.list a{color:#f1f1f1;text-decoration:none;font-weight:500}
.n30s ul.list a:hover{text-decoration:underline}
.n30s ul.list .meta{display:block}
.n30s footer{margin-top:40px;color:#888;font-size:13px}
</style>`;

const orgLd = () => ({
  "@type": "Organization",
  "@id": SITE_URL + "/#organization",
  name: SITE_NAME,
  url: SITE_URL + "/",
});

function headTags({ title, description, canonical, type = "website", image, robots, extra = "", ld = [] }) {
  const t = [];
  t.push("<title>" + esc(title) + "</title>");
  t.push('<meta name="description" content="' + esc(description) + '" />');
  if (robots) t.push('<meta name="robots" content="' + esc(robots) + '" />');
  if (canonical) t.push('<link rel="canonical" href="' + esc(canonical) + '" />');
  t.push('<meta property="og:site_name" content="' + SITE_NAME + '" />');
  t.push('<meta property="og:type" content="' + esc(type) + '" />');
  if (canonical) t.push('<meta property="og:url" content="' + esc(canonical) + '" />');
  t.push('<meta property="og:title" content="' + esc(title) + '" />');
  t.push('<meta property="og:description" content="' + esc(description) + '" />');
  if (image) t.push('<meta property="og:image" content="' + esc(image) + '" />');
  t.push('<meta name="twitter:card" content="' + (image ? "summary_large_image" : "summary") + '" />');
  t.push('<meta name="twitter:title" content="' + esc(title) + '" />');
  t.push('<meta name="twitter:description" content="' + esc(description) + '" />');
  if (image) t.push('<meta name="twitter:image" content="' + esc(image) + '" />');
  if (extra) t.push(extra);
  for (const obj of ld) t.push(jsonLd(obj));
  t.push(STATIC_CSS);
  return "<!-- seo:start -->\n    " + t.join("\n    ") + "\n    <!-- seo:end -->";
}

const siteHeader = () =>
  '<header><a class="brand" href="/">News<b>30</b></a><nav>' +
  Object.entries(CATEGORIES).map(([id, c]) => '<a href="/' + id + '">' + c.label + "</a>").join("") +
  "</nav></header>";

const siteFooter = () =>
  "<footer><p>News30 stories are AI-condensed summaries of reporting by the credited news outlets. " +
  "Each story links to its original source.</p></footer>";

function storyList(rows) {
  if (!rows.length) return "<p>No stories yet — check back soon.</p>";
  return (
    '<ul class="list">' +
    rows
      .map((r) => {
        const iso = isoDate(r.created_at);
        return (
          '<li><a href="' + esc(pathFor(r)) + '">' + esc(r.headline || "Untitled story") + "</a>" +
          '<span class="meta">' + esc(sourceName(r.source)) +
          (iso ? ' · <time datetime="' + iso + '">' + esc(humanDate(r.created_at)) + "</time>" : "") +
          "</span></li>"
        );
      })
      .join("") +
    "</ul>"
  );
}

function scriptParagraphs(script) {
  const text = String(script || "").trim();
  if (!text) return "";
  let paras = text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  // One long block → break into ~3-sentence paragraphs for readability.
  if (paras.length === 1) {
    const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];
    paras = [];
    for (let i = 0; i < sentences.length; i += 3) paras.push(sentences.slice(i, i + 3).map((x) => x.trim()).join(" "));
  }
  return paras.map((p) => "<p>" + esc(p) + "</p>").join("\n");
}

const isoDuration = (sec) => {
  const s = Math.max(1, Math.round(Number(sec) || 30));
  const m = Math.floor(s / 60);
  return "PT" + (m ? m + "M" : "") + (s % 60 ? (s % 60) + "S" : m ? "" : "0S");
};

function send(res, status, cache, body, type = "text/html; charset=utf-8") {
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", cache);
  res.status(status).send(body);
}

/* ───────────────────────── pages ───────────────────────── */

async function homePage(req, res) {
  const template = await getTemplate(req);
  let rows = [];
  try {
    rows = (await latestStories()).slice(0, 30);
  } catch (e) {
    console.error("[seo] home stories:", String(e).slice(0, 200));
  }
  const verification = process.env.GOOGLE_SITE_VERIFICATION
    ? '<meta name="google-site-verification" content="' + esc(process.env.GOOGLE_SITE_VERIFICATION.trim()) + '" />'
    : "";
  const head = headTags({
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonical: SITE_URL + "/",
    extra: verification,
    ld: [
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "WebSite",
            "@id": SITE_URL + "/#website",
            name: SITE_NAME,
            url: SITE_URL + "/",
            description: HOME_DESCRIPTION,
            publisher: { "@id": SITE_URL + "/#organization" },
            inLanguage: "en",
          },
          orgLd(),
        ],
      },
    ],
  });
  const body =
    '<div class="n30s">' + siteHeader() +
    "<main><h1>News30 — the day's news in 30 seconds</h1>" +
    "<p>Top geopolitics, finance and sports stories, condensed by AI into 30-second video summaries. " +
    "Every story credits and links the outlet that reported it.</p>" +
    "<h2>Browse by category</h2><ul class=\"list\">" +
    Object.entries(CATEGORIES)
      .map(([id, c]) => '<li><a href="/' + id + '">' + c.label + '</a><span class="meta">' + esc(c.description) + "</span></li>")
      .join("") +
    "</ul><h2>Latest stories</h2>" + storyList(rows) + "</main>" + siteFooter() + "</div>";
  send(res, 200, CACHE.page, render(template, { head, body }));
}

async function categoryPage(req, res, cat) {
  const c = CATEGORIES[cat];
  if (!c) return notFound(req, res);
  const template = await getTemplate(req);
  let rows;
  try {
    rows = (await latestStories()).filter((r) => normaliseCategory(r.category) === cat).slice(0, 60);
  } catch (e) {
    console.error("[seo] category stories:", String(e).slice(0, 200));
    return unavailable(req, res, template);
  }
  const canonical = SITE_URL + "/" + cat;
  const head = headTags({
    title: c.title + " | " + SITE_NAME,
    description: c.description,
    canonical,
    ld: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: c.title,
        url: canonical,
        description: c.description,
        isPartOf: { "@type": "WebSite", "@id": SITE_URL + "/#website", name: SITE_NAME, url: SITE_URL + "/" },
        mainEntity: {
          "@type": "ItemList",
          itemListElement: rows.slice(0, 30).map((r, i) => ({ "@type": "ListItem", position: i + 1, url: absolute(pathFor(r)) })),
        },
      },
    ],
  });
  const body =
    '<div class="n30s">' + siteHeader() +
    "<main><h1>" + esc(c.title) + "</h1><p>" + esc(c.description) + "</p>" +
    "<h2>Latest " + esc(c.label.toLowerCase()) + " stories</h2>" + storyList(rows) + "</main>" + siteFooter() + "</div>";
  send(res, 200, CACHE.page, render(template, { head, body, rootAttrs: ' data-category="' + cat + '"' }));
}

async function storyPage(req, res, slugParam) {
  const uuid = uuidFromSlug(slugParam);
  if (!uuid) return notFound(req, res);

  let row, related = [];
  try {
    const [rows, latest] = await Promise.all([
      sbSelect("select=" + STORY_COLS + "&id=eq." + uuid + "&status=eq.ready&limit=1"),
      latestStories().catch(() => []),
    ]);
    row = rows[0];
    if (row) {
      const cat = normaliseCategory(row.category);
      related = latest.filter((r) => r.id !== row.id && normaliseCategory(r.category) === cat).slice(0, 8);
    }
  } catch (e) {
    console.error("[seo] story fetch:", String(e).slice(0, 200));
    return unavailable(req, res, await getTemplate(req));
  }
  if (!row) return notFound(req, res);

  // Wrong / missing slug (headline edited, legacy /story/<uuid>) → canonical.
  const path = pathFor(row);
  if (String(slugParam).replace(/\/+$/, "") !== path.slice("/story/".length)) {
    res.setHeader("Cache-Control", CACHE.story);
    res.setHeader("Location", path);
    return res.status(301).send("");
  }

  const template = await getTemplate(req);
  const canonical = absolute(path);
  const cat = normaliseCategory(row.category);
  const catInfo = CATEGORIES[cat];
  const src = sourceName(row.source);
  const articleUrl = safeHttpUrl(row.article_url);
  const videoUrl = safeHttpUrl(row.video_url);
  const image = liveThumb(row);
  const script = String(row.script || "").trim();
  const words = wordCount(script);
  const thin = words < THIN_WORDS;
  const published = isoDate(row.created_at);
  const originalPublished = isoDate(row.article_published);
  const description = truncate(
    script || "A 30-second AI-condensed summary of " + src + "'s report: " + (row.headline || ""),
    158
  );
  const title = truncate(row.headline || "News story", 90) + " | " + SITE_NAME;

  const article = {
    "@type": "NewsArticle",
    "@id": canonical + "#article",
    mainEntityOfPage: canonical,
    url: canonical,
    headline: truncate(row.headline || "News story", 110),
    description,
    articleSection: catInfo.label,
    inLanguage: "en",
    datePublished: published || undefined,
    dateModified: published || undefined,
    author: { "@id": SITE_URL + "/#organization" },
    publisher: { "@id": SITE_URL + "/#organization" },
    image: image ? [image] : undefined,
    articleBody: script || undefined,
    wordCount: words || undefined,
    isBasedOn: articleUrl || undefined,
    citation: articleUrl ? { "@type": "CreativeWork", url: articleUrl, publisher: { "@type": "Organization", name: src } } : undefined,
  };
  const graph = [article, orgLd()];
  if (videoUrl) {
    const video = {
      "@type": "VideoObject",
      "@id": canonical + "#video",
      name: row.headline || "News story",
      description,
      thumbnailUrl: image ? [image] : undefined,
      uploadDate: published || undefined,
      duration: isoDuration(row.duration_seconds),
      contentUrl: videoUrl,
      transcript: script || undefined,
      publisher: { "@id": SITE_URL + "/#organization" },
      inLanguage: "en",
    };
    graph.push(video);
    article.video = { "@id": video["@id"] };
  }

  const head = headTags({
    title,
    description,
    canonical,
    type: "article",
    image,
    robots: thin ? "noindex, follow" : "max-image-preview:large",
    extra: [
      published ? '<meta property="article:published_time" content="' + published + '" />' : "",
      '<meta property="article:section" content="' + esc(catInfo.label) + '" />',
      videoUrl ? '<meta property="og:video" content="' + esc(videoUrl) + '" />' : "",
      videoUrl ? '<meta property="og:video:type" content="video/mp4" />' : "",
    ].filter(Boolean).join("\n    "),
    ld: [{ "@context": "https://schema.org", "@graph": graph }],
  });

  const sourceLink = articleUrl
    ? '<a href="' + esc(articleUrl) + '" rel="noopener" target="_blank">' + esc(src) + "</a>"
    : esc(src);
  const body =
    '<div class="n30s">' + siteHeader() + "<main><article>" +
    '<p class="kicker"><a href="/' + cat + '">' + esc(catInfo.label) + "</a></p>" +
    "<h1>" + esc(row.headline || "News story") + "</h1>" +
    '<p class="meta">' +
    (published ? 'Published <time datetime="' + published + '">' + esc(humanDate(row.created_at)) + "</time> · " : "") +
    "Source: " + sourceLink +
    (originalPublished && humanDate(row.article_published) !== humanDate(row.created_at)
      ? ' (originally reported <time datetime="' + originalPublished + '">' + esc(humanDate(row.article_published)) + "</time>)"
      : "") +
    "</p>" +
    '<p class="note">This is an AI-condensed summary of reporting by ' + sourceLink +
    ". Read the original article for the full story.</p>" +
    (image ? '<img class="thumb" src="' + esc(image) + '" alt="' + esc(row.headline || "") + '" width="1280" height="720" />' : "") +
    (script ? "<h2>Transcript</h2>\n" + scriptParagraphs(script) : "") +
    (articleUrl
      ? '<p><a href="' + esc(articleUrl) + '" rel="noopener" target="_blank">Read the original article at ' + esc(src) + " →</a></p>"
      : "") +
    "</article>" +
    (related.length ? "<h2>More " + esc(catInfo.label.toLowerCase()) + " stories</h2>" + storyList(related) : "") +
    "</main>" + siteFooter() + "</div>";

  // data-video="0": the video has been deleted — main.jsx leaves this
  // page as-is instead of mounting the feed over the transcript.
  const rootAttrs = ' data-story="pub-' + row.id + '" data-video="' + (videoUrl ? "1" : "0") + '"';
  send(res, 200, CACHE.story, render(template, { head, body, rootAttrs }));
}

async function notFound(req, res) {
  const template = await getTemplate(req);
  const head = headTags({
    title: "Story not found | " + SITE_NAME,
    description: "This page doesn't exist on News30.",
    robots: "noindex, follow",
  });
  const body =
    '<div class="n30s">' + siteHeader() +
    '<main><h1>Story not found</h1><p>This story doesn\'t exist or is no longer available. <a href="/">Back to the latest news</a>.</p></main></div>';
  send(res, 404, CACHE.missing, render(template, { head, body }));
}

function unavailable(req, res, template) {
  const head = headTags({ title: HOME_TITLE, description: HOME_DESCRIPTION, robots: "noindex" });
  res.setHeader("Retry-After", "300");
  send(res, 503, CACHE.error, render(template, { head, body: "" }));
}

async function sitemap(req, res) {
  const urls = [{ loc: SITE_URL + "/", changefreq: "hourly", priority: "1.0" }];
  for (const id of Object.keys(CATEGORIES)) urls.push({ loc: SITE_URL + "/" + id, changefreq: "hourly", priority: "0.8" });

  const room = SITEMAP_MAX - urls.length;
  let newest = null;
  try {
    for (let from = 0; from < room; from += PAGE_ROWS) {
      const to = Math.min(from + PAGE_ROWS, room) - 1;
      const rows = await sbSelect(
        "select=id,headline,script,created_at&status=eq.ready&order=created_at.desc,id.desc",
        { from, to }
      );
      for (const r of rows) {
        if (wordCount(r.script) < THIN_WORDS) continue; // noindex pages stay out of the sitemap
        const lastmod = isoDate(r.created_at);
        if (!newest && lastmod) newest = lastmod;
        urls.push({ loc: absolute(pathFor(r)), lastmod });
      }
      if (rows.length < to - from + 1) break;
    }
  } catch (e) {
    console.error("[seo] sitemap:", String(e).slice(0, 200));
    return send(res, 503, CACHE.error, "Sitemap temporarily unavailable", "text/plain; charset=utf-8");
  }
  if (newest) for (let i = 0; i < 4; i++) urls[i].lastmod = newest;

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          "  <url><loc>" + esc(u.loc) + "</loc>" +
          (u.lastmod ? "<lastmod>" + u.lastmod + "</lastmod>" : "") +
          (u.changefreq ? "<changefreq>" + u.changefreq + "</changefreq>" : "") +
          (u.priority ? "<priority>" + u.priority + "</priority>" : "") +
          "</url>"
      )
      .join("\n") +
    "\n</urlset>\n";
  send(res, 200, CACHE.sitemap, xml, "application/xml; charset=utf-8");
}

/* ───────────────────────── entry ───────────────────────── */

export default async function handler(req, res) {
  const q = req.query || {};
  const page = String(q.page || "home");
  try {
    if (page === "sitemap") return await sitemap(req, res);
    if (page === "story") return await storyPage(req, res, String(q.slug || ""));
    if (page === "category") return await categoryPage(req, res, String(q.cat || ""));
    if (page === "home") return await homePage(req, res);
    return await notFound(req, res);
  } catch (e) {
    console.error("[seo] unhandled:", String(e && e.stack ? e.stack : e).slice(0, 500));
    if (!res.headersSent) send(res, 500, CACHE.error, "Something went wrong", "text/plain; charset=utf-8");
  }
}

