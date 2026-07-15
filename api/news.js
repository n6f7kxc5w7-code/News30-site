// /api/news.js
// 🔌 NEWS API SERVER PROXY — runs on Vercel's servers (Node.js runtime),
// never in the browser. This is what makes live news actually work on
// a deployed domain: NewsAPI's free tier only allows browser requests
// from localhost, but that restriction only applies to *browser* calls
// (CORS). Server-to-server calls like this one aren't subject to CORS
// at all, and the real key never ships to the client bundle.
//
// Setup required in Vercel → Settings → Environment Variables:
//   NEWSAPI_KEY = your real newsapi.org key   (NO "VITE_" prefix —
//   that prefix is what makes Vite expose a var to the browser bundle;
//   leaving it off keeps this one server-only.)
//
// The frontend calls this exactly like it used to call newsapi.org
// directly: GET /api/news?category=business — same response shape
// (NewsAPI's { articles: [...] } JSON), so newsService in App.jsx
// needs no changes beyond pointing ENDPOINT at "/api/news".

export default async function handler(req, res) {
  const apiKey = process.env.NEWSAPI_KEY;

  if (!apiKey) {
    // Missing server key → tell the caller clearly. The frontend's
    // existing try/catch in newsService.load() already falls back
    // gracefully to curated sample stories on any non-OK response.
    res.status(500).json({ error: "NEWSAPI_KEY is not configured on the server" });
    return;
  }

  const category = (req.query && req.query.category) || "general";
  const allowed = ["business", "entertainment", "general", "health", "science", "sports", "technology"];
  const safeCategory = allowed.includes(category) ? category : "general";

  const url =
    "https://newsapi.org/v2/top-headlines" +
    "?category=" + encodeURIComponent(safeCategory) +
    "&language=en&pageSize=30" +
    "&apiKey=" + encodeURIComponent(apiKey);

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();

    if (!upstream.ok) {
      // Forward NewsAPI's own status/message so errors are debuggable
      // (e.g. rate limits, bad key) without ever echoing the key back.
      res.status(upstream.status).json({ error: data.message || "NewsAPI request failed", code: data.code });
      return;
    }

    // Cache briefly at the edge/CDN so repeated visits don't all hit
    // NewsAPI fresh — keeps you comfortably under the free daily quota.
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
