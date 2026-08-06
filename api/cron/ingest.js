import { createClient } from "@supabase/supabase-js";


const CATEGORY_MAP = {
  geopolitics: "general",
  finance: "business",
  sports: "sports",
};

const STORIES_PER_CATEGORY = 3;
const HEADLINES_TO_CONSIDER = 40;

const SOURCE_TIER = {
  reuters: 5, "associated press": 5, ap: 5, "agence france-presse": 5, afp: 5,
  "bbc news": 4, bbc: 4, bloomberg: 4, "financial times": 4, ft: 4,
  "the guardian": 4, "the new york times": 4, "the washington post": 4,
  "the wall street journal": 4, wsj: 4, cnbc: 3, "sky news": 3, "sky sports": 3,
  "al jazeera english": 3, "al jazeera": 3, npr: 3, politico: 3, axios: 3,
  espn: 3, "the athletic": 3, nrk: 3, dw: 3, "deutsche welle": 3,
  cnn: 3, "abc news": 3, "cbs news": 3, "nbc news": 3,
};

const SOFT_NEWS_PATTERNS = [
  /\b\d+\s+(things|ways|reasons|times|photos|celebrities)\b/i,
  /\byou won'?t believe\b/i, /\bhere'?s (why|what|how)\b/i,
  /\bwent viral\b/i, /\bslams?\b/i, /\bfans? react\b/i,
  /\bbest deals?\b/i, /\bdeal of the day\b/i, /\bhoroscope\b/i,
  /\bnetflix\b.*\bwatch\b/i, /\brecipe\b/i,
];

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

function rankStories(articles, limit) {
  const usable = articles.filter(
    (a) => a && a.title && a.title !== "[Removed]" && a.url
  );

  const clusters = [];
  usable.forEach((article, feedIndex) => {
    const tokens = tokenize(article.title);
    let placed = false;

    for (const cluster of clusters) {
      if (similarity(tokens, cluster.tokens) >= SAME_STORY_THRESHOLD) {
        cluster.members.push({ article, feedIndex });
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

    const outlets = new Set(
      cluster.members.map((m) => ((m.article.source && m.article.source.name) || "").toLowerCase())
    );
    const corroboration = outlets.size;

    const corroborationScore = Math.min(50, Math.round(18 * Math.log2(corroboration + 1)));

    const bestTier = Math.max(
      ...cluster.members.map((m) => sourceTier(m.article.source && m.article.source.name))
    );
    const tierScore = bestTier * 5;

    const ageHours = Math.max(0, (now - (Date.parse(article.publishedAt) || now)) / 3600000);
    const recencyScore = Math.round(25 * Math.pow(0.5, ageHours / 8));

    const positionScore = Math.max(0, 10 - feedIndex);

    const softPenalty = isSoftNews(article.title) ? -40 : 0;

    const brevityPenalty = tokenize(article.title).size < 4 ? -15 : 0;

    const significance =
      corroborationScore + tierScore + recencyScore + positionScore + softPenalty + brevityPenalty;

    return {
      article,
      significance,
      corroboration,
      rank_reason:
        corroboration + " outlets" +
        ", tier " + bestTier +
        ", " + ageHours.toFixed(1) + "h old" +
        (softPenalty ? ", soft-news penalty" : "") +
        (brevityPenalty ? ", thin headline" : ""),
    };
  });

  return scored.sort((a, b) => b.significance - a.significance).slice(0, limit);
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[ingest] CRON_SECRET not configured — refusing to run");
    res.status(500).json({ error: "Not configured" });
    return;
  }

  // TEMPORARY DEBUG — remove once the 401 mismatch is resolved. Logs
  // only lengths and first/last characters, never the secret itself,
  // so this is safe to leave in Vercel's logs briefly.
  const incoming = req.headers.authorization || "";
  console.log("[DEBUG] stored secret length:", secret.length);
  console.log("[DEBUG] stored secret starts/ends:", secret.slice(0, 4) + "..." + secret.slice(-4));
  console.log("[DEBUG] incoming header length:", incoming.length);
  console.log("[DEBUG] incoming header starts/ends:", incoming.slice(0, 11) + "..." + incoming.slice(-4));
  console.log("[DEBUG] expected header length:", ("Bearer " + secret).length);

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

      const rows = top.map((t, i) => ({
        article_url: t.article.url,
        category,
        headline: (t.article.title || "").replace(/\s+[-|–]\s+[^-|–]+$/, "").trim(),
        source: (t.article.source && t.article.source.name) || "Newswire",
        article_published: t.article.publishedAt || new Date().toISOString(),
        significance: t.significance,
        corroboration: t.corroboration,
        rank_reason: t.rank_reason,
        status: "pending",
        slot: i + 1,
      }));

      const { error } = await supabase
        .from("published_stories")
        .upsert(rows, { onConflict: "article_url", ignoreDuplicates: true });

      if (error) throw error;
      summary[category] = { queued: rows.length };
    }

    const base = "https://" + (req.headers.host || "news30.live");
    fetch(base + "/api/cron/process", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret },
    }).catch(() => {});

    res.status(200).json({ ok: true, summary });
  } catch (e) {
    console.error("[ingest] failed:", e);
    res.status(500).json({ error: "Ingest failed" });
  }
}
