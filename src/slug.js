// Shared by the SPA (src/App.jsx) and the server (api/seo.js) so both
// build exactly the same story URL: /story/<slug>-<uuid>.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function slugify(text, maxLen = 80) {
  let s = String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    const cut = s.lastIndexOf("-");
    if (cut > maxLen / 2) s = s.slice(0, cut);
    s = s.replace(/-+$/g, "");
  }
  return s || "story";
}

/** Path for a published story row/uuid + headline. */
export function storyPath(uuid, headline) {
  return "/story/" + slugify(headline) + "-" + String(uuid).toLowerCase();
}

/** The uuid in a "<slug>-<uuid>" segment (or a bare uuid). Not anchored to
    the end, so trailing junk (a slash, ".html", an appended query, a
    duplicated value) can't make a valid story URL unresolvable; if there
    are several, the last one wins. */
export function uuidFromSlug(segment) {
  const all = String(segment || "").match(UUID_RE);
  return all ? all[all.length - 1].toLowerCase() : null;
}
