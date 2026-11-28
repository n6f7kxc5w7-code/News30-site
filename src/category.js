// Story category, decided from what the story is about.
// Shared by api/cron/ingest.js (when a story is queued), src/App.jsx and
// api/seo.js (when a story is read), so all three always agree.
//
// Why this exists: ingest fills "geopolitics" from NewsAPI's `general`
// feed, which is a catch-all. A Black Friday shopping story arrived
// there and was stored, and shown, as Geopolitics. The feed a story
// came from is now only a starting point; the headline (and, at
// ingest, NewsAPI's description) decides.
//
// Rules:
//   - finance/business and sports feeds are trusted unless the text
//     points clearly elsewhere (another category scores 2+ higher);
//   - `general`/geopolitics stories go to finance or sports when that
//     scores higher than the world-affairs signal; ties stay geopolitics.

const ALIASES = {
  geopolitics: "geopolitics", world: "geopolitics", politics: "geopolitics", general: "geopolitics",
  finance: "finance", business: "finance", markets: "finance", economy: "finance",
  sports: "sports", sport: "sports",
};

/* [pattern, weight]. Weight 2 = unambiguous on its own, 1 = supporting. */
const SIGNALS = {
  finance: [
    [/\bblack friday\b/, 2], [/\bcyber monday\b/, 2], [/\bprime day\b/, 2],
    [/\bshoppers?\b/, 2], [/\bshopping\b/, 2], [/\bretail(ers?)?\b/, 2], [/\bconsumer spending\b/, 2],
    [/\bonline spending\b/, 2], [/\bdiscounts?\b/, 1], [/\bholiday sales\b/, 2], [/\bsales\b/, 1],
    [/\bstock(s| market)\b/, 2], [/\bshares\b/, 1], [/\bmarkets?\b/, 1], [/\bwall street\b/, 2],
    [/\b(s&p|nasdaq|dow jones|ftse|nikkei|dax)\b/, 2], [/\bearnings\b/, 2], [/\bprofits?\b/, 1],
    [/\brevenue\b/, 1], [/\binvestors?\b/, 2], [/\bipo\b/, 2], [/\binflation\b/, 2],
    [/\binterest rates?\b/, 2], [/\brate (cut|hike)s?\b/, 2], [/\bcentral bank\b/, 2],
    [/\b(federal reserve|the fed|ecb|bank of england|bank of japan)\b/, 2],
    [/\b(oil|gas|petrol|fuel) prices?\b/, 2], [/\b(brent|crude)\b/, 2], [/\bopec\+?/, 2],
    [/\becono(my|mic|mies)\b/, 1], [/\bgdp\b/, 2], [/\brecession\b/, 2], [/\bjobs report\b/, 2],
    [/\bunemployment\b/, 1], [/\b(bitcoin|crypto(currency)?)\b/, 2], [/\bmortgages?\b/, 1],
    [/\bprices?\b/, 1], [/\bconsumers?\b/, 1], [/\bbusiness(es)?\b/, 1], [/\btariffs?\b/, 1],
  ],
  sports: [
    [/\b(premier|champions|europa|nations) league\b/, 2], [/\bworld cup\b/, 2], [/\bgrand prix\b/, 2],
    [/\bformula (1|one)\b|\bf1\b/, 2], [/\b(nfl|nba|mlb|nhl|uefa|fifa)\b/, 2], [/\bolympics?\b/, 2],
    [/\b(football|soccer|tennis|golf|cricket|rugby|boxing|cycling|athletics)\b/, 2],
    [/\b(quarterback|striker|goalkeeper|midfielder)\b/, 2], [/\b(playoffs?|semi-?finals?|quarter-?finals?)\b/, 2],
    [/\b(match|fixture|derby|kick-?off|hat-?trick)\b/, 1], [/\b(scored|goals?|wins?|beat|defeat)\b/, 1],
    [/\b(coach|manager|squad|season|title|league|cup)\b/, 1],
  ],
  geopolitics: [
    [/\b(president|prime minister|minister|government|parliament|senate|congress)\b/, 2],
    [/\b(election|vote|referendum|coalition|opposition)\b/, 1], [/\b(war|ceasefire|truce|invasion)\b/, 2],
    [/\b(troops|military|army|missiles?|drones?|airstrikes?|nuclear)\b/, 2], [/\b(defen[cs]e)\b/, 1],
    [/\b(sanctions|treaty|diplomat(s|ic)?|embassy|summit|talks|negotiations?)\b/, 1],
    [/\b(nato|united nations|un security council|eu|european union|african union|asean|g7|g20)\b/, 2],
    [/\b(border|refugees?|migrants?|protests?|coup|rebels?|militants?|hostages?)\b/, 1],
    [/\b(policy|law|bill|court|supreme court|tariffs?|trade war)\b/, 1],
  ],
};

function score(text, cat) {
  let n = 0;
  for (const [re, w] of SIGNALS[cat]) if (re.test(text)) n += w;
  return n;
}

/**
 * @param {{category?: string, headline?: string, description?: string}} story
 * @returns {"geopolitics"|"finance"|"sports"}
 */
export function storyCategory({ category, headline, description } = {}) {
  const feed = ALIASES[String(category || "").toLowerCase()] || "geopolitics";
  const head = String(headline || "").toLowerCase();
  const body = String(description || "").toLowerCase();
  // The headline counts double: it is what the story is about.
  const s = {};
  for (const cat of ["geopolitics", "finance", "sports"]) s[cat] = score(head, cat) * 2 + score(body, cat);

  if (feed === "geopolitics") {
    const best = s.finance >= s.sports ? "finance" : "sports";
    return s[best] > s.geopolitics ? best : "geopolitics";
  }
  const others = ["geopolitics", "finance", "sports"].filter((c) => c !== feed);
  const alt = s[others[0]] >= s[others[1]] ? others[0] : others[1];
  return s[alt] >= s[feed] + 2 ? alt : feed;
}
