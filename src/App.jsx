/* ════════════════════════════════════════════════════════════════════
   NEWS30 — AI-powered news platform (pre-alpha production build)
   Single-file React app · YouTube-parity layout · Desktop + iPhone

   ── CONNECTION POINT INDEX (search for "🔌") ─────────────────────────
   🔌 AI API        → CONFIG.AI + callAI() · Gemini   (Ask AI, Summary chat, Simplify)
   🔌 GOOGLE OAUTH  → CONFIG.GOOGLE_OAUTH + GoogleModal sign-in flow
   🔌 EMAIL SERVICE → CONFIG.EMAIL + emailService     (Mailchimp / Resend)
   🔌 NEWS API      → CONFIG.NEWS_API + data layer    (NewsAPI-shaped objects)
   🔌 DATABASE      → CONFIG.DATABASE + db service    (Supabase / Firebase)

   All UI reads from structured data objects + a central tracking store —
   nothing is hard-coded into markup, so swapping in live services means
   editing the service layer only.
   ════════════════════════════════════════════════════════════════════ */

import React, { useState, useEffect, useRef, useCallback, useMemo, useReducer } from "react";
import { createClient } from "@supabase/supabase-js";

/* ════════════════════════ 1 · CONFIG ═══════════════════════════════ */

/* Reads a Vite env var safely (also safe outside Vite, e.g. artifact
   preview, where import.meta.env is undefined). Set these in Vercel →
   Settings → Environment Variables, or a local .env.local file.      */
const env = (key) =>
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env[key]) || "";

const CONFIG = {
  AI: {
    // 🔌 AI API — Google Gemini ────────────────────────────────────
    // Generous free tier. Create a key at aistudio.google.com and set
    // VITE_GEMINI_API_KEY. Without it, every AI feature serves the
    // labelled sample responses instead — the UI never breaks.
    // Tip: VITE_ vars ship in the bundle, so add "Website restrictions"
    // to the key (AI Studio / Cloud console) limiting it to your
    // domains — and proxy through a backend before a public launch.
    ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models",
    MODEL: "gemini-2.5-flash",
    API_KEY: env("VITE_GEMINI_API_KEY"),
  },
  GOOGLE_OAUTH: {
    // 🔌 GOOGLE OAUTH — LIVE ─────────────────────────────────────────
    // Client IDs are public by design; domains must be listed under
    // "Authorized JavaScript origins" in console.cloud.google.com.
    // The client SECRET is not public — it belongs on a server only
    // and is deliberately absent from this file.
    CLIENT_ID: "538312385751-r7mj5q8slibo3irg0sr32kf0378mvj18.apps.googleusercontent.com",
  },
  EMAIL: {
    // 🔌 EMAIL SERVICE CONNECTION POINT (Mailchimp / Resend / etc.) ──
    // Sending belongs server-side; these envs exist for when the calls
    // are proxied through your backend.
    PROVIDER: "resend", // or "mailchimp"
    API_KEY: env("VITE_EMAIL_API_KEY"),
    AUDIENCE_ID: env("VITE_EMAIL_AUDIENCE_ID"),
  },
  NEWS_API: {
    // 🔌 NEWS API — LIVE via server proxy ─────────────────────────────
    // The real NewsAPI key lives server-side only, in the NEWSAPI_KEY
    // env var (no VITE_ prefix — never shipped to the browser) read by
    // /api/news.js, a small Vercel serverless function. The browser
    // calls that proxy instead of newsapi.org directly. This sidesteps
    // NewsAPI's free-tier restriction (browser calls are only allowed
    // from localhost, not a deployed domain — see /api/news.js) since
    // server-to-server calls aren't subject to that CORS rule, and it
    // keeps the key out of the client bundle entirely.
    ENDPOINT: "/api/news",
  },
  DATABASE: {
    // 🔌 DATABASE — LIVE (Supabase) ──────────────────────────────────
    // With both vars set, signed-in users' data (quiz results, login
    // streaks, likes, saves, video engagement) persists to Supabase.
    // The db service below has the REST calls + required table SQL.
    SUPABASE_URL: env("VITE_SUPABASE_URL"),
    SUPABASE_ANON_KEY: env("VITE_SUPABASE_ANON_KEY"),
  },
  DEBUG_TRACKING: true, // logs every tracked event to the console
};

/* 🔌 SUPABASE CLIENT — powers Google sign-in + the user_state/events
   tables. Null when env vars are missing, so callers must guard on it. */
const supabase = (CONFIG.DATABASE.SUPABASE_URL && CONFIG.DATABASE.SUPABASE_ANON_KEY)
  ? createClient(CONFIG.DATABASE.SUPABASE_URL, CONFIG.DATABASE.SUPABASE_ANON_KEY)
  : null;

const supabaseAuth = {
  configured() { return !!supabase; },
  async signInWithGoogle() {
    if (!supabase) throw new Error("Supabase not configured");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  },
  async getUser() {
    if (!supabase) return null;
    const { data } = await supabase.auth.getUser();
    return data.user || null;
  },
  onChange(cb) {
    if (!supabase) return () => {};
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      cb(session ? session.user : null);
    });
    return () => sub.subscription.unsubscribe();
  },
  async signOut() {
    if (supabase) await supabase.auth.signOut();
  },
};

function buildAppUser(supaUser) {
  const meta = supaUser.user_metadata || {};
  const email = supaUser.email;
  return {
    name: meta.full_name || meta.name || email,
    email,
    color: colorForEmail(email),
    picture: meta.avatar_url || meta.picture || null,
  };
}

/* ════════════════════════ 2 · UTILITIES ════════════════════════════ */

const NOW = Date.now();

/** Deterministic PRNG so infinite-scroll archives are stable. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seeded = (seed) => mulberry32(seed * 9301 + 49297);

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 > 1e5 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 > 100 && n < 1e4 ? 1 : 0) + "K";
  return String(n);
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
  if (d < 30) return Math.floor(d / 7) + "w ago";
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + "mo ago";
  return Math.floor(mo / 12) + "y ago";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateBadge(ts) {
  const d = new Date(ts);
  return d.getDate() + " " + MONTHS[d.getMonth()];
}
function fullDate(ts) {
  const d = new Date(ts);
  return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

const cls = (...xs) => xs.filter(Boolean).join(" ");

/* Brand assets — processed from the supplied News30 logo file (transparent PNG). */
/* ⚠️ RESTORE-FROM-YOUR-REPO: paste your original LOGO_SRC line here,
   copied straight from GitHub (do not retype — it's a long base64
   string and needs to match byte-for-byte). Same for FAVICON_SRC. */
const LOGO_SRC = "data:image/png;base64,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";
const FAVICON_SRC = "data:image/png;base64,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";

/* ════════════════════════ 3 · ICON LIBRARY ═════════════════════════
   Platform-wide rule: every functional icon is a consistent-stroke
   SVG line-art glyph (no emoji), matching YouTube's icon style.      */

const ICONS = {
  menu: <><path d="M3.5 6h17" /><path d="M3.5 12h17" /><path d="M3.5 18h17" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  mic: <><path d="M12 2.5a3 3 0 0 1 3 3V11a3 3 0 0 1-6 0V5.5a3 3 0 0 1 3-3z" /><path d="M19 10.5v.5a7 7 0 0 1-14 0v-.5" /><path d="M12 18v3.5" /><path d="M8.5 21.5h7" /></>,
  bell: <><path d="M18 8.5a6 6 0 0 0-12 0c0 7-2.7 7.5-2.7 9h17.4c0-1.5-2.7-2-2.7-9" /><path d="M10.3 20.7a1.9 1.9 0 0 0 3.4 0" /></>,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c0-3.8 3.4-6 7.5-6s7.5 2.2 7.5 6" /></>,
  home: <><path d="M4 10.7 12 4l8 6.7" /><path d="M5.8 9.3V20h4.7v-5.3h3V20h4.7V9.3" /></>,
  flame: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
  bookmark: <path d="M6.5 3.5h11V21L12 16.7 6.5 21z" />,
  sparkle: <><path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z" /><path d="M18.7 15.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></>,
  fileText: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h6" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c3.2 4 3.2 14 0 18" /><path d="M12 3c-3.2 4-3.2 14 0 18" /></>,
  trendUp: <><path d="M3 17l6-6 4 4 8-9" /><path d="M15 6h6v6" /></>,
  football: <><circle cx="12" cy="12" r="9" /><path d="M12 7.6l4.2 3-1.6 4.9H9.4L7.8 10.6z" /><path d="M12 3v4.6" /><path d="M20.5 9.2l-4.3 1.4" /><path d="M3.5 9.2l4.3 1.4" /><path d="M17.4 19.2l-2.8-3.7" /><path d="M6.6 19.2l2.8-3.7" /></>,
  cpu: <><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>,
  flask: <><path d="M9.5 3h5" /><path d="M10.5 3v6.2L5.2 18a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3l-5.3-8.8V3" /><path d="M7.3 15h9.4" /></>,
  mapPin: <><path d="M12 21.5s-7-6.3-7-11.2a7 7 0 0 1 14 0c0 4.9-7 11.2-7 11.2z" /><circle cx="12" cy="10.2" r="2.6" /></>,
  palette: <><path d="M12 21a9 9 0 1 1 9-9c0 2-1.4 3.1-3 3.1h-2a2.4 2.4 0 0 0-1.8 4c.5.6.1 1.9-2.2 1.9z" /><circle cx="7.6" cy="10.6" r="1.1" fill="currentColor" stroke="none" /><circle cx="10.7" cy="7.2" r="1.1" fill="currentColor" stroke="none" /><circle cx="14.8" cy="7.6" r="1.1" fill="currentColor" stroke="none" /></>,
  lock: <><rect x="5.5" y="11" width="13" height="9.5" rx="2" /><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></>,
  heart: <path d="M12 20.6C7.2 17.1 3.5 13.6 3.5 9.9 3.5 7.2 5.6 5 8.2 5c1.6 0 3 .8 3.8 2.1C12.8 5.8 14.2 5 15.8 5c2.6 0 4.7 2.2 4.7 4.9 0 3.7-3.7 7.2-8.5 10.7z" />,
  comment: <><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.6 1.3 4.9 3.4 6.5L4 22l4.6-2.2c1 .3 2.2.5 3.4.5 5.5 0 10-3.9 10-8.6S17.5 3 12 3z" /><path d="M8 10.3h8" /><path d="M8 13.3h5.5" /></>,
  bolt: <path d="M13 2 4.8 13.2h4.9L11 22l8.2-11.2h-4.9z" />,
  share: <path d="M14.5 9.1V5.2L21 12l-6.5 6.8v-3.9c-4.6 0-8 1.5-10.5 4.6.9-5.6 4.5-9.7 10.5-10.4z" />,
  arrowUp: <><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></>,
  arrowDown: <><path d="M12 5v14" /><path d="M18 13l-6 6-6-6" /></>,
  arrowLeft: <><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></>,
  x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  check: <path d="M4.5 12.5l5 5L19.5 7" />,
  alertTriangle: <><path d="M12 3.8 2.6 19.8h18.8z" /><path d="M12 9.7v4.3" /><path d="M12 17.1h.01" /></>,
  dotsVertical: <><circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" /></>,
  send: <><path d="M21 3 10.3 13.7" /><path d="M21 3l-6.8 18-3.2-8-8-3.2z" /></>,
  play: <path d="M8 5.3v13.4L19 12z" fill="currentColor" stroke="none" />,
  pause: <><path d="M7.5 5.3h3.2v13.4H7.5z" fill="currentColor" stroke="none" /><path d="M13.3 5.3h3.2v13.4h-3.2z" fill="currentColor" stroke="none" /></>,
  tune: <><path d="M4 7.5h7" /><path d="M17.5 7.5H20" /><circle cx="14.5" cy="7.5" r="2.4" /><path d="M4 16.5h2.5" /><path d="M13 16.5h7" /><circle cx="9.5" cy="16.5" r="2.4" /></>,
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.2 5.9-.9z" />,
  checkCircle: <><circle cx="12" cy="12" r="8.5" /><path d="M8.4 12.4l2.5 2.5 4.8-5.4" /></>,
};

function Icon({ name, size = 24, filled = false, stroke = 1.8, className = "", style }) {
  return (
    <svg
      className={cls("ic", className)}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name] || null}
    </svg>
  );
}

/* Official Google "G" (brand mark — the one intentionally multicolour glyph). */
function GoogleG({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a12 12 0 0 0 0 10.76z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.25 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}

/* News30 brand lockup — real processed logo, SVG fallback if the image fails. */
function Brand({ height = 26, onClick, className = "" }) {
  const [err, setErr] = useState(false);
  return (
    <div className={cls("brand", className)} onClick={onClick} role="button" tabIndex={0} title="News30 — Home"
      onKeyDown={(e) => { if (e.key === "Enter" && onClick) onClick(); }}>
      {!err ? (
        <img src={LOGO_SRC} style={{ height, width: "auto", display: "block" }} alt="News30" draggable={false}
          onError={() => setErr(true)} />
      ) : (
        <div className="brandFallback" style={{ height }}>
          <span>NEWS&nbsp;3</span>
          <Icon name="globe" size={Math.round(height * 0.82)} style={{ color: "#7d9cc9" }} />
        </div>
      )}
    </div>
  );
}

/* ════════════════════════ 4 · DATA LAYER ═══════════════════════════
   🔌 NEWS API CONNECTION POINT
   Every story is a plain data object with this shape — deliberately
   mirroring NewsAPI so the swap is a mapping function, not a rewrite:

     NewsAPI field            →  News30 field
     article.title            →  headline
     article.source.name      →  source
     article.publishedAt      →  publishedAt (ms epoch)
     article.category         →  category
     (editorial layer)        →  bias, fact, kicker, duration, views

   Replace getFeed() internals with a fetch to CONFIG.NEWS_API when
   ready; the whole UI reads only from these objects.                 */

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const fmtDur = (sec) => "0:" + String(sec).padStart(2, "0");

const SOURCES = {
  Reuters: { initials: "R", color: "#f4511e" },
  AP: { initials: "AP", color: "#e53935" },
  BBC: { initials: "B", color: "#8e24aa" },
  "BBC Sport": { initials: "BS", color: "#8e24aa" },
  Bloomberg: { initials: "BL", color: "#3949ab" },
  "The Guardian": { initials: "G", color: "#1e88e5" },
  DW: { initials: "DW", color: "#039be5" },
  "Al Jazeera": { initials: "AJ", color: "#f9a825" },
  AFP: { initials: "AF", color: "#6d4c41" },
  FT: { initials: "FT", color: "#ec407a" },
  CNBC: { initials: "C", color: "#00acc1" },
  WSJ: { initials: "W", color: "#5c6bc0" },
  MarketWatch: { initials: "MW", color: "#43a047" },
  NRK: { initials: "N", color: "#1565c0" },
  ESPN: { initials: "E", color: "#d81b60" },
  "Sky Sports": { initials: "SS", color: "#c62828" },
};
const sourceMeta = (name) => SOURCES[name] || { initials: name.slice(0, 2).toUpperCase(), color: "#546e7a" };

const BIAS = {
  left: { label: "Left", color: "#5b9cf5" },
  centre: { label: "Centre", color: "#9aa0a6" },
  right: { label: "Right", color: "#f28b82" },
};
const FACT = {
  verified: { label: "Verified", color: "#2ba640", icon: "check" },
  disputed: { label: "Disputed", color: "#ff9500", icon: "alertTriangle" },
};

const CATEGORIES = [
  { id: "all", label: "All", icon: null },
  { id: "geopolitics", label: "Geopolitics", icon: "globe" },
  { id: "finance", label: "Finance", icon: "trendUp" },
  { id: "sports", label: "Sports", icon: "football" },
];
const LOCKED_CATEGORIES = [
  { id: "technology", label: "Technology", icon: "cpu" },
  { id: "science", label: "Science", icon: "flask" },
  { id: "local", label: "Local", icon: "mapPin" },
  { id: "culture", label: "Culture", icon: "palette" },
];
const catLabel = (id) => (CATEGORIES.find((c) => c.id === id) || { label: id }).label;

function mkStory(id, category, headline, kicker, source, bias, fact, minsAgo, durationSec, views) {
  return {
    id, category, headline, kicker, source, bias, fact,
    publishedAt: NOW - minsAgo * 60000,
    duration: fmtDur(durationSec), durationSec, views,
    seed: hash(id),
  };
}

/* ── SAMPLE curated feed (replace via 🔌 NEWS API) ────────────────── */
const CURATED = {
  geopolitics: [
    mkStory("g1", "geopolitics", "EU leaders strike provisional deal on joint defence fund", "DEFENCE DEAL", "Reuters", "centre", "verified", 14, 29, 128400),
    mkStory("g2", "geopolitics", "Ceasefire talks resume in Cairo as mediators table new framework", "CEASEFIRE TALKS", "AP", "centre", "verified", 62, 31, 96200),
    mkStory("g3", "geopolitics", "China and India agree to reopen two Himalayan border crossings", "BORDER REOPENS", "BBC", "centre", "verified", 185, 27, 210500),
    mkStory("g4", "geopolitics", "US Senate advances bill tying foreign aid to audit rules", "AID AUDIT", "Bloomberg", "centre", "verified", 300, 30, 74100),
    mkStory("g5", "geopolitics", "Protests spread in Belgrade after disputed local results", "BELGRADE UNREST", "The Guardian", "left", "disputed", 430, 33, 152800),
    mkStory("g6", "geopolitics", "Arctic Council reconvenes for first full session since 2022", "ARCTIC TALKS", "DW", "centre", "verified", 600, 26, 45300),
  ],
  finance: [
    mkStory("f1", "finance", "Fed signals patience as core inflation cools to 2.4%", "FED HOLDS", "Bloomberg", "centre", "verified", 32, 30, 187300),
    mkStory("f2", "finance", "Oil slides 3% after surprise OPEC+ output boost", "OIL SLIDES 3%", "Reuters", "centre", "verified", 120, 28, 143600),
    mkStory("f3", "finance", "Krone rallies as Norges Bank holds rates, hints at autumn cut", "KRONE RALLY", "FT", "centre", "verified", 245, 29, 58900),
    mkStory("f4", "finance", "Tech megacaps push S&P 500 to fresh record close", "S&P RECORD", "CNBC", "centre", "verified", 370, 27, 232100),
    mkStory("f5", "finance", "EU carbon price tops €100 for first time since 2023", "CARBON €100", "WSJ", "right", "verified", 540, 31, 67400),
    mkStory("f6", "finance", "Retail traders pile into uranium ETFs as prices spike", "URANIUM RUSH", "MarketWatch", "right", "disputed", 660, 32, 89000),
  ],
  sports: [
    mkStory("s1", "sports", "Mbappé strikes twice as France power into World Cup semi-finals", "MBAPPÉ ×2", "Reuters", "centre", "verified", 118, 28, 412700),
    mkStory("s2", "sports", "England name unchanged squad for Tuesday's semi-final", "SEMI READY", "BBC Sport", "centre", "verified", 55, 26, 154200),
    mkStory("s3", "sports", "Norway's historic World Cup run ends in quarter-final heartbreak", "HISTORIC RUN ENDS", "NRK", "centre", "verified", 350, 30, 388900),
    mkStory("s4", "sports", "Semi-final ticket prices surge 300% on resale platforms", "TICKET SURGE", "AP", "centre", "disputed", 200, 29, 97300),
    mkStory("s5", "sports", "Spain sweat on captain's fitness ahead of last-four clash", "CAPTAIN DOUBT", "ESPN", "right", "disputed", 470, 27, 121500),
    mkStory("s6", "sports", "Host cities report record fan-zone crowds through knockouts", "RECORD CROWDS", "AFP", "centre", "verified", 720, 31, 63800),
  ],
};
const CURATED_ALL = [...CURATED.geopolitics, ...CURATED.finance, ...CURATED.sports];
const CURATED_BY_ID = Object.fromEntries(CURATED_ALL.map((s) => [s.id, s]));

/* Simulated "just posted" story used by the live-notification demo. */
function makeBreakingStory() {
  return {
    id: "s-live1", category: "sports",
    headline: "Referees confirmed for Tuesday's World Cup semi-finals",
    kicker: "SEMI OFFICIALS", source: "Reuters", bias: "centre", fact: "verified",
    publishedAt: Date.now(), duration: "0:24", durationSec: 24, views: 1200,
    seed: hash("s-live1"),
  };
}

/* ── Deterministic archive generator → infinite scroll back in time ─ */
const ARCH = {
  geopolitics: {
    subjects: ["EU leaders", "UN Security Council members", "NATO ministers", "ASEAN negotiators", "African Union envoys", "G20 delegates", "Gulf state mediators", "Nordic foreign ministers", "Balkan leaders", "Pacific alliance officials"],
    events: ["reach framework deal on {t}", "stall over sanctions language on {t}", "open emergency session on {t}", "agree phased timeline for {t}", "trade blame over stalled {t}", "back new monitoring mission for {t}", "clash over funding for {t}", "endorse roadmap on {t}", "review commitments on {t}", "tighten rules governing {t}"],
    topics: ["grain corridors", "border security", "energy transit", "peacekeeping mandates", "cyber norms", "maritime claims", "aid corridors", "election monitoring"],
    sources: ["Reuters", "AP", "BBC", "Bloomberg", "The Guardian", "DW", "Al Jazeera", "AFP"],
  },
  finance: {
    subjects: ["Markets", "Investors", "Central banks", "Oil traders", "Bond desks", "Tech stocks", "European banks", "Retail traders", "Fund managers", "Chipmakers"],
    events: ["weigh {t} ahead of key data", "rally as {t} pressure cools", "slip on fresh {t} jitters", "rotate portfolios toward {t}", "price in an earlier shift on {t}", "brace for the next {t} report", "extend gains on {t} optimism", "pare losses after {t} surprise", "eye record highs despite {t}", "hedge exposure to {t}"],
    topics: ["inflation", "the rate path", "earnings season", "supply squeezes", "yield spikes", "stimulus talk", "currency swings", "commodity demand"],
    sources: ["Bloomberg", "Reuters", "FT", "CNBC", "WSJ", "MarketWatch"],
  },
  sports: {
    teams: ["France", "England", "Spain", "Brazil", "Norway", "Argentina", "Portugal", "Germany", "Morocco", "Japan"],
    events: ["edge {o} in extra time", "cruise past {o}", "held by {o} in a group thriller", "rotate heavily against {o}", "sweat on fitness before facing {o}", "name a bold XI to face {o}", "stun {o} with a late winner", "share the spoils with {o}", "book a knockout spot past {o}", "fall to {o} on penalties"],
    kickers: ["LATE DRAMA", "EXTRA TIME", "ON PENALTIES", "STATEMENT WIN", "GROUP THRILLER", "KNOCKOUT BOUND", "SHOCK RESULT", "ALL SQUARE"],
    sources: ["Reuters", "BBC Sport", "ESPN", "AP", "AFP", "Sky Sports"],
  },
};

function makeArchiveStory(category, idx) {
  const rnd = seeded(hash(category) + idx * 7 + 13);
  const A = ARCH[category];
  let headline, kicker;
  if (category === "sports") {
    const a = A.teams[Math.floor(rnd() * A.teams.length)];
    let b = A.teams[Math.floor(rnd() * A.teams.length)];
    if (b === a) b = A.teams[(A.teams.indexOf(a) + 3) % A.teams.length];
    headline = a + " " + A.events[Math.floor(rnd() * A.events.length)].replace("{o}", b);
    kicker = A.kickers[Math.floor(rnd() * A.kickers.length)];
  } else {
    const t = A.topics[Math.floor(rnd() * A.topics.length)];
    headline = A.subjects[Math.floor(rnd() * A.subjects.length)] + " " + A.events[Math.floor(rnd() * A.events.length)].replace("{t}", t);
    kicker = t.replace("the ", "").toUpperCase();
  }
  const source = A.sources[Math.floor(rnd() * A.sources.length)];
  const bias = ["centre", "centre", "centre", "left", "right"][Math.floor(rnd() * 5)];
  const fact = rnd() < 0.82 ? "verified" : "disputed";
  const daysAgo = 1 + Math.floor(idx * 1.35) + Math.floor(rnd() * 2);
  const publishedAt = NOW - daysAgo * 86400000 - Math.floor(rnd() * 20) * 3600000;
  const durationSec = 24 + Math.floor(rnd() * 11);
  return {
    id: category + "-a" + idx, category, headline, kicker, source, bias, fact,
    publishedAt, duration: fmtDur(durationSec), durationSec,
    views: 2000 + Math.floor(rnd() * rnd() * 880000),
    seed: idx * 31 + hash(category),
  };
}

/* ── LIVE NEWS (NewsAPI) ────────────────────────────────────────────
   🔌 Via the /api/news server proxy, newsService.load() pulls real top
   headlines per category and maps every article onto the exact story
   shape the whole UI already consumes — cards, player, panels, quizzes
   and deep links all work unchanged. Falls back to the curated sample
   stories whenever the proxy errors (missing server key, rate limit,
   network failure) or returns no articles.                            */

const NEWS_CATEGORY_MAP = { geopolitics: "general", finance: "business", sports: "sports" };
const LIVE_KICKERS = {
  geopolitics: ["WORLD", "GLOBAL", "DIPLOMACY", "BREAKING"],
  finance: ["MARKETS", "ECONOMY", "MONEY", "BUSINESS"],
  sports: ["SPORTS", "MATCHDAY", "SCORES", "GAME ON"],
};
/* Light-touch outlet lean map for the visual bias tags (defaults to
   Centre for anything unlisted — extend freely).                     */
const OUTLET_BIAS = {
  "the guardian": "left", "guardian": "left", "cnn": "left", "msnbc": "left",
  "huffpost": "left", "vox": "left",
  "fox news": "right", "new york post": "right", "breitbart": "right",
  "daily mail": "right", "the telegraph": "right",
};

const LIVE = { ready: false, stories: { geopolitics: [], finance: [], sports: [] } };
const LIVE_CACHE = new Map(); // id → story (deep links, saved items, notifications)

function mapArticle(a, category, idx) {
  const headline = (a.title || "").replace(/\s+[-|\u2013]\s+[^-|\u2013]+$/, "").trim();
  const srcName = ((a.source && a.source.name) || "Newswire").replace(/\.(com|org|net)$/i, "");
  const seed = hash(a.url || headline) + idx;
  const rnd = seeded(seed);
  const durationSec = 25 + Math.floor(rnd() * 21);
  const story = {
    id: "live-" + category + "-" + (hash(a.url || headline) % 100000),
    category,
    headline,
    kicker: LIVE_KICKERS[category][seed % LIVE_KICKERS[category].length],
    source: srcName,
    bias: OUTLET_BIAS[srcName.toLowerCase()] || "centre",
    fact: "verified",
    publishedAt: Date.parse(a.publishedAt) || NOW,
    duration: fmtDur(durationSec),
    durationSec,
    views: 800 + Math.floor(rnd() * 240000), // placeholder metric until real analytics
    seed,
    url: a.url, // original article link (extra field — UI ignores unknown keys)
  };
  LIVE_CACHE.set(story.id, story);
  return story;
}

const newsService = {
  isLive() { return LIVE.ready; },
  async load() {
    try {
      const cats = Object.keys(NEWS_CATEGORY_MAP);
      const results = await Promise.all(cats.map(async (cat) => {
        const u = CONFIG.NEWS_API.ENDPOINT + "?category=" + NEWS_CATEGORY_MAP[cat];
        const r = await fetch(u);
        if (!r.ok) throw new Error("NewsAPI proxy failed: " + r.status);
        const j = await r.json();
        return (j.articles || [])
          .filter((a) => a.title && a.title !== "[Removed]" && a.url)
          .map((a, i) => mapArticle(a, cat, i));
      }));
      cats.forEach((cat, i) => { LIVE.stories[cat] = results[i]; });
      LIVE.ready = results.some((r) => r.length > 0);
      track("news_live_loaded", { geopolitics: LIVE.stories.geopolitics.length, finance: LIVE.stories.finance.length, sports: LIVE.stories.sports.length });
      return LIVE.ready;
    } catch (e) {
      LIVE.ready = false; // graceful fallback → curated sample stories
      track("news_live_failed", { error: String(e) });
      return false;
    }
  },
  /** One page of live stories for a category ('all' interleaves). */
  page(category, page) {
    const pick = (c) => LIVE.stories[c] || [];
    let pool;
    if (category === "all") {
      pool = [];
      const cats = ["geopolitics", "finance", "sports"];
      const max = Math.max(...cats.map((c) => pick(c).length));
      for (let i = 0; i < max; i++) for (const c of cats) if (pick(c)[i]) pool.push(pick(c)[i]);
    } else {
      pool = pick(category);
    }
    return pool.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  },
  all() {
    return [...LIVE.stories.geopolitics, ...LIVE.stories.finance, ...LIVE.stories.sports];
  },
};

const PAGE_SIZE = 12;
/** Feed pager. Serves live NewsAPI headlines when loaded; otherwise
    page 0 = curated samples and deeper pages walk back through the
    dated archive. In live mode, pages beyond the API supply continue
    into the archive so infinite scroll never dead-ends. */
function getFeed(category, page) {
  if (newsService.isLive()) {
    const live = newsService.page(category, page);
    if (live.length) return live;
  }
  if (page === 0) {
    if (category === "all") return CURATED_ALL.slice().sort((a, b) => b.publishedAt - a.publishedAt);
    return CURATED[category].slice();
  }
  const out = [];
  const start = (page - 1) * PAGE_SIZE;
  if (category === "all") {
    const cats = ["geopolitics", "finance", "sports"];
    for (let i = start; i < start + PAGE_SIZE; i++) out.push(makeArchiveStory(cats[i % 3], Math.floor(i / 3)));
  } else {
    for (let i = start; i < start + PAGE_SIZE; i++) out.push(makeArchiveStory(category, i));
  }
  return out;
}

function getTrending() {
  const pool = newsService.isLive() ? newsService.all() : [...getFeed("all", 0), ...getFeed("all", 1)];
  return pool.slice().sort((a, b) => b.views - a.views).slice(0, 18);
}

function findStoryById(id) {
  if (LIVE_CACHE.has(id)) return LIVE_CACHE.get(id);
  if (CURATED_BY_ID[id]) return CURATED_BY_ID[id];
  if (id === "s-live1") return makeBreakingStory();
  const m = /^(geopolitics|finance|sports)-a(\d+)$/.exec(id);
  if (m) return makeArchiveStory(m[1], parseInt(m[2], 10));
  return null;
}

/* ════════════════════ 5 · SERVICES & TRACKING ══════════════════════ */

/* ── Tracking store ─────────────────────────────────────────────────
   🔌 DATABASE — LIVE (Supabase). All user activity flows through ONE
   pure reducer into ONE structured store. When a user is signed in and
   Supabase is configured, App (a) hydrates this store from the
   user_state table on login, (b) upserts the whole store back on every
   change (debounced), and (c) mirrors each action to the events table.
   Signed-out or unconfigured → exact same behaviour as before, local
   state only. The store powers the profile stats and is shaped for the
   leaderboard + dashboard drawer planned for later builds.           */

const todayKey = () => new Date().toDateString();
const yesterdayKey = () => new Date(Date.now() - 86400000).toDateString();

const initialUserData = () => ({
  profile: { totalPoints: 0, quizAccuracy: 0, badges: [] },
  loginActivity: { streak: 0, totalDaysActive: 0, lastLoginDate: null },
  engagement: { videosWatched: 0, watchedIds: [], likedIds: [], savedIds: [], categoryCounts: {} },
  quizActivity: [], // [{ storyId, answers:[{q, chosen, correct}], points, completedAt }]
});

function track(event, payload) {
  if (CONFIG.DEBUG_TRACKING) console.info("[news30 · tracking]", event, payload || "");
}

const db = {
  /* 🔌 SUPABASE — LIVE via the @supabase/supabase-js client (authenticated
     session), not raw PostgREST fetch calls with the bare anon key.
     Required schema — run once in Supabase → SQL editor:

       create table if not exists user_state (
         user_email text primary key,
         data jsonb not null,
         updated_at timestamptz default now()
       );
       create table if not exists events (
         id bigint generated always as identity primary key,
         user_email text,
         event text not null,
         payload jsonb,
         at timestamptz default now()
       );

     Pre-alpha note: these tables were created WITHOUT Row Level Security
     so sign-in + persistence work end-to-end right away. Before launch,
     enable RLS on both tables with policies keyed on auth.uid() — now
     possible because sign-in goes through real Supabase Auth, so
     auth.uid() reflects a verified identity, not a client-supplied email. */
  enabled() {
    return !!supabase;
  },
  /** Fetch a user's persisted state; null when absent/disabled/failed. */
  async loadUserData(email) {
    if (!this.enabled()) return null;
    try {
      const { data, error } = await supabase
        .from("user_state")
        .select("data")
        .eq("user_email", email)
        .maybeSingle();
      if (error) throw error;
      return data ? data.data : null;
    } catch (e) {
      track("db_load_failed", { error: String(e) });
      return null;
    }
  },
  /** Upsert the entire user state blob (called debounced from App). */
  async saveUserData(email, data) {
    if (!this.enabled()) return false;
    try {
      const { error } = await supabase
        .from("user_state")
        .upsert({ user_email: email, data, updated_at: new Date().toISOString() });
      if (error) throw error;
      return true;
    } catch (e) {
      track("db_save_failed", { error: String(e) });
      return false;
    }
  },
  /** Fire-and-forget event stream (quiz answers, watches, logins…). */
  logEvent(email, event, payload) {
    if (!this.enabled()) return;
    supabase
      .from("events")
      .insert({ user_email: email || null, event, payload: payload || null })
      .then(() => {});
  },
};

function userDataReducer(state, action) {
  switch (action.type) {
    /* Replace local state with the persisted copy loaded from Supabase.
       Section-wise merge over the initial shape so older saved blobs
       survive future store-shape changes. */
    case "HYDRATE": {
      const base = initialUserData();
      const d = action.data || {};
      return {
        profile: { ...base.profile, ...(d.profile || {}) },
        loginActivity: { ...base.loginActivity, ...(d.loginActivity || {}) },
        engagement: { ...base.engagement, ...(d.engagement || {}) },
        quizActivity: Array.isArray(d.quizActivity) ? d.quizActivity : [],
      };
    }
    /* Sign-out: wipe local copy (the account's data lives server-side). */
    case "RESET":
      return initialUserData();
    case "VIDEO_WATCHED": {
      const { story } = action;
      if (state.engagement.watchedIds.includes(story.id)) return state;
      track("video_watched", { id: story.id, category: story.category });
      const categoryCounts = { ...state.engagement.categoryCounts };
      categoryCounts[story.category] = (categoryCounts[story.category] || 0) + 1;
      return {
        ...state,
        engagement: {
          ...state.engagement,
          videosWatched: state.engagement.videosWatched + 1,
          watchedIds: [...state.engagement.watchedIds, story.id],
          categoryCounts,
        },
      };
    }
    case "LIKE_TOGGLED": {
      const { storyId } = action;
      const liked = !state.engagement.likedIds.includes(storyId);
      track("like_toggled", { storyId, liked });
      return {
        ...state,
        engagement: {
          ...state.engagement,
          likedIds: liked
            ? [...state.engagement.likedIds, storyId]
            : state.engagement.likedIds.filter((id) => id !== storyId),
        },
      };
    }
    case "SAVE_TOGGLED": {
      const { storyId } = action;
      const saved = !state.engagement.savedIds.includes(storyId);
      track("save_toggled", { storyId, saved });
      return {
        ...state,
        engagement: {
          ...state.engagement,
          savedIds: saved
            ? [...state.engagement.savedIds, storyId]
            : state.engagement.savedIds.filter((id) => id !== storyId),
        },
      };
    }
    case "QUIZ_COMPLETE": {
      const { result } = action; // { storyId, answers, points, completedAt }
      track("quiz_complete", result);
      const quizActivity = [...state.quizActivity, result];
      let total = 0, correct = 0;
      quizActivity.forEach((r) => r.answers.forEach((a) => { total += 1; if (a.correct) correct += 1; }));
      return {
        ...state,
        quizActivity,
        profile: {
          ...state.profile,
          totalPoints: state.profile.totalPoints + result.points,
          quizAccuracy: total ? Math.round((correct / total) * 100) : 0,
        },
      };
    }
    case "LOGIN": {
      const last = state.loginActivity.lastLoginDate;
      if (last === todayKey()) return state;
      const streak = last === yesterdayKey() ? state.loginActivity.streak + 1 : 1;
      const loginActivity = {
        streak,
        totalDaysActive: state.loginActivity.totalDaysActive + 1,
        lastLoginDate: todayKey(),
      };
      track("login", loginActivity);
      return { ...state, loginActivity };
    }
    default:
      return state;
  }
}

/* ── AI service — Google Gemini ─────────────────────────────────────
   🔌 AI API CONNECTION POINT. All three AI features (Ask AI, Summary
   chat, Simplify) route through callAI() below — Gemini 2.5 Flash,
   with Google Search grounding on news questions. Key missing or the
   request fails → graceful fallback to the labelled sample responses
   in mockAI, so the UI never breaks without a connection.            */

async function callAI({ system, messages, useWebSearch = false }) {
  if (!CONFIG.AI.API_KEY) throw new Error("No AI key configured"); // → sample fallback
  const body = {
    contents: messages,
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { maxOutputTokens: 1000 },
  };
  if (useWebSearch) body.tools = [{ google_search: {} }]; // Gemini search grounding
  const res = await fetch(CONFIG.AI.ENDPOINT + "/" + CONFIG.AI.MODEL + ":generateContent?key=" + encodeURIComponent(CONFIG.AI.API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = (errJson.error && errJson.error.message) || JSON.stringify(errJson);
    } catch (e2) {
      try { detail = await res.text(); } catch (e3) { /* ignore */ }
    }
    throw new Error("AI request failed: " + res.status + " — " + detail);
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.map((pt) => pt.text || "").join("").trim();
  if (!text) throw new Error("Empty AI response");
  return text;
}

/* Gemini chat history uses role "model" (not "assistant") + parts[]. */
const toApiHistory = (history) =>
  history
    .filter((m) => !m.pending)
    .map((m) => ({ role: m.role === "ai" ? "model" : "user", parts: [{ text: m.text }] }));

const sampleNote = "\n\n— Sample response. Add VITE_GEMINI_API_KEY to switch on live AI answers.";

const mockAI = {
  news(question) {
    const top = getFeed("all", 0).slice(0, 3).map((s) => "• " + s.headline + " (" + s.source + ", " + timeAgo(s.publishedAt) + ")").join("\n");
    return "Here's what's leading News30 right now:\n" + top + "\n\nAsk about any of these and I can go deeper." + sampleNote;
  },
  story(story, question) {
    return "From what's on file: " + story.headline + ". " + story.source + " filed it " + timeAgo(story.publishedAt) + " and it's currently marked " + FACT[story.fact].label + " by the fact-check layer. That's the core of what this clip covers." + sampleNote;
  },
  simplify(text) {
    const first = text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    return "In plain terms: " + first + sampleNote;
  },
};

const aiService = {
  async askNews(question, history = []) {
    try {
      return await callAI({
        system:
          "You are the AI assistant inside News30, a short-form news platform covering geopolitics, finance and sports. Today is " +
          fullDate(Date.now()) +
          ". Use web search whenever the question needs current information. Answer in under 130 words: plain text, short paragraphs or dash bullets, no markdown headings. Be direct and factual; note uncertainty where it exists.",
        messages: [...toApiHistory(history), { role: "user", parts: [{ text: question }] }],
        useWebSearch: true,
      });
    } catch (e) {
      return "⚠️ " + (e?.message || String(e));
    }
  },
  async askStory(story, question, history = []) {
    try {
      return await callAI({
        system:
          "You are News30's story assistant. The user is asking about this specific story — Headline: \"" +
          story.headline +
          "\". Source: " + story.source + " (" + BIAS[story.bias].label + "). Category: " + catLabel(story.category) +
          ". Published: " + fullDate(story.publishedAt) + " (" + timeAgo(story.publishedAt) +
          "). Fact-check status: " + FACT[story.fact].label +
          ". Answer questions about this story and its wider context in under 110 words, plain text. If something isn't knowable from the story or general knowledge, say so briefly.",
        messages: [...toApiHistory(history), { role: "user", parts: [{ text: question }] }],
      });
    } catch (e) {
      return "⚠️ " + (e?.message || String(e));
    }
  },
  async simplify(text) {
    try {
      return await callAI({
        system:
          "Rewrite the user's article in plain English that a 14-year-old would follow. Keep every fact accurate, cut jargon, maximum 130 words, no intro or outro — output only the rewritten text.",
        messages: [{ role: "user", parts: [{ text: text }] }],
      });
    } catch (e) {
      return "⚠️ " + (e?.message || String(e));
    }
  },
};

/* ── Auth + email capture ───────────────────────────────────────────
   🔌 GOOGLE OAUTH — LIVE via Supabase Auth (see supabaseAuth above).
   Supabase handles the OAuth redirect, token exchange and session;
   GoogleModal below just triggers supabaseAuth.signInWithGoogle() and
   App listens for the resulting session via supabaseAuth.onChange().
   This is what makes Row Level Security possible: Postgres trusts
   Supabase's own verified auth.uid(), not a client-decoded JWT.       */

const AVATAR_COLORS = ["#3ea6ff", "#2ba640", "#ff9500", "#e91e63", "#9c6bff", "#00bcd4"];
const colorForEmail = (email) => AVATAR_COLORS[hash(email) % AVATAR_COLORS.length];

/* Fallback demo accounts — shown only when Supabase isn't configured
   yet (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY), so sign-in
   stays testable before the backend is wired up.                     */
const MOCK_GOOGLE_ACCOUNTS = [
  { name: "Aidrus", email: "aidrus.founder@gmail.com", color: "#3ea6ff" },
  { name: "News30 Test", email: "test@news30.app", color: "#2ba640" },
];

/* 🔌 EMAIL SERVICE CONNECTION POINT (Mailchimp / Resend)
   Emails captured during Google sign-in land here, shaped for the
   re-engagement flows: daily digest, come-back prompts, streak-at-risk
   warnings, milestone celebrations.                                  */
const capturedEmails = [];
const emailService = {
  captureEmail(email, name) {
    const record = {
      email,
      name,
      capturedAt: new Date().toISOString(),
      source: "google_oauth",
      plannedFlows: ["daily_digest", "come_back_reminder", "streak_at_risk", "milestone_celebration"],
    };
    capturedEmails.push(record);
    track("email_captured", record);
    // 🔌 RESEND:    fetch("https://api.resend.com/audiences/" + CONFIG.EMAIL.AUDIENCE_ID + "/contacts",
    //               { method: "POST", headers: { Authorization: "Bearer " + CONFIG.EMAIL.API_KEY }, body: JSON.stringify({ email }) })
    // 🔌 MAILCHIMP: fetch("https://usX.api.mailchimp.com/3.0/lists/" + CONFIG.EMAIL.AUDIENCE_ID + "/members",
    //               { method: "POST", ... body: JSON.stringify({ email_address: email, status: "subscribed" }) })
  },
};

/* ═══════════════════════ 6 · STYLES (part 1) ═══════════════════════
   Exact YouTube dark-theme values: #0f0f0f canvas, #272727 raised,
   #f1f1f1 text, #aaa secondary, Roboto, 12px thumbnails, 32px chips. */

const CSS1 = `
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0f0f0f;--raised:#272727;--hover:#3f3f3f;--bg2:#121212;
  --line:rgba(255,255,255,.2);--line2:rgba(255,255,255,.1);
  --txt:#f1f1f1;--txt2:#aaaaaa;--blue:#3ea6ff;--blue-d:#1c62b9;
  --green:#2ba640;--orange:#ff9500;--red:#ff4e45;
  --hd-h:56px;--sb-w:240px;--sb-mini:72px;--r:12px;
  --font:"Roboto","Segoe UI",Arial,sans-serif;
}
html,body,#root{height:100%}
body{background:var(--bg);color:var(--txt);font-family:var(--font);font-size:14px;overflow-x:hidden}
body.no-scroll{overflow:hidden}
button{font-family:var(--font);border:0;background:none;color:inherit;cursor:pointer}
input,textarea{font-family:var(--font);color:var(--txt);background:none;border:0;outline:none}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:#3f3f3f;border-radius:4px}
::-webkit-scrollbar-track{background:transparent}
.ibtn{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--txt);position:relative;flex:none;transition:background .15s}
.ibtn:hover{background:var(--raised)}
.ibtn:active{background:var(--hover)}

/* ── header ── */
.hd{position:fixed;top:0;left:0;right:0;height:var(--hd-h);background:var(--bg);display:flex;align-items:center;justify-content:space-between;padding:0 16px;z-index:60;gap:8px}
.hd-left{display:flex;align-items:center;gap:4px;flex:none}
.hd-brand{display:flex;align-items:center;padding:0 10px;height:40px;cursor:pointer}
.hd-brand img{height:21px;display:block}
.hd-brand svg{display:block}
.hd-center{flex:1;display:flex;justify-content:center;min-width:0;padding:0 8px}
.askbar{display:flex;align-items:center;width:100%;max-width:560px;height:40px;border:1px solid #303030;border-radius:20px;background:var(--bg2);overflow:hidden;transition:border-color .15s}
.askbar:focus-within{border-color:var(--blue-d)}
.askbar input{flex:1;height:100%;padding:0 6px 0 16px;font-size:15px;min-width:0}
.askbar input::placeholder{color:#888}
.ai-pill{flex:none;font-size:10.5px;font-weight:700;letter-spacing:.5px;color:var(--blue);border:1px solid rgba(62,166,255,.45);border-radius:999px;padding:2px 7px;margin-right:8px}
.askbar-btn{flex:none;width:60px;height:100%;background:#222;display:flex;align-items:center;justify-content:center;border-left:1px solid #303030;color:var(--txt)}
.askbar-btn:hover{background:#2f2f2f}
.hd-right{display:flex;align-items:center;gap:2px;flex:none}
.dot{position:absolute;top:5px;right:5px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--red);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg)}
.avatar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;color:#fff;flex:none}

/* ── dropdown menus ── */
.menu{position:fixed;top:calc(var(--hd-h) - 6px);right:16px;width:380px;max-width:calc(100vw - 24px);background:#212121;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);z-index:70;overflow:hidden;animation:pop .16s ease}
.menu-h{padding:13px 16px;font-size:16px;font-weight:500;border-bottom:1px solid var(--line2);display:flex;align-items:center;justify-content:space-between}
.menu-h small{font-size:12px;color:var(--blue);font-weight:500;cursor:pointer}
.menu-list{max-height:58vh;overflow-y:auto}
.notif{display:flex;gap:12px;padding:12px 16px;cursor:pointer;transition:background .12s;align-items:flex-start;width:100%;text-align:left}
.notif:hover{background:#2c2c2c}
.notif-thumb{width:84px;height:47px;border-radius:8px;overflow:hidden;flex:none}
.notif-thumb svg{width:100%;height:100%;display:block}
.notif-t{font-size:13.5px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.notif-m{font-size:12px;color:var(--txt2);margin-top:4px}
.notif-dot{width:5px;height:5px;border-radius:50%;background:var(--blue);flex:none;margin-top:9px}
.menu-empty{padding:38px 16px;text-align:center;color:var(--txt2);font-size:13.5px;display:flex;flex-direction:column;align-items:center;gap:12px}

/* profile card */
.pf-head{display:flex;gap:14px;padding:16px;border-bottom:1px solid var(--line2);align-items:center}
.pf-name{font-size:16px;font-weight:500}
.pf-mail{font-size:13px;color:var(--txt2);margin-top:2px}
.pf-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 16px;position:relative}
.stat{background:var(--raised);border-radius:10px;padding:12px 12px 10px;display:flex;flex-direction:column;gap:3px}
.stat b{font-size:19px;font-weight:700;display:flex;align-items:center;gap:6px}
.stat span{font-size:11px;color:var(--txt2);letter-spacing:.3px;text-transform:uppercase;font-weight:600}
.pf-lock{position:absolute;inset:6px;border-radius:12px;background:rgba(15,15,15,.74);backdrop-filter:blur(6px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;text-align:center;padding:14px;z-index:1}
.pf-lock p{font-size:13px;color:#ddd;line-height:1.45;max-width:250px}
.gbtn{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#1f1f1f;font-weight:500;font-size:14px;border-radius:999px;padding:9px 16px;transition:box-shadow .15s,transform .15s}
.gbtn:hover{box-shadow:0 3px 10px rgba(0,0,0,.5)}
.gbtn:active{transform:scale(.98)}
.pf-row{display:flex;align-items:center;gap:14px;padding:11px 16px;font-size:14px;cursor:pointer;width:100%;text-align:left}
.pf-row:hover{background:#2c2c2c}

/* ── sidebar / drawer / bottom nav ── */
.sb{position:fixed;top:var(--hd-h);left:0;bottom:0;width:var(--sb-w);padding:12px;overflow-y:auto;background:var(--bg);z-index:50}
.sb-item{display:flex;align-items:center;gap:24px;height:40px;padding:0 12px;border-radius:10px;font-size:14px;cursor:pointer;transition:background .12s;white-space:nowrap;width:100%;text-align:left}
.sb-item:hover{background:var(--raised)}
.sb-item.on{background:var(--raised);font-weight:500}
.sb-sep{height:1px;background:var(--line2);margin:12px 4px}
.sb-note{padding:10px 12px;font-size:12px;color:var(--txt2);line-height:1.55}
.sb.mini{width:var(--sb-mini);padding:4px 4px 12px}
.sb.mini .sb-item{flex-direction:column;gap:6px;height:74px;justify-content:center;font-size:10px;padding:0;border-radius:12px;gap:6px}
.sb.mini .sb-sep,.sb.mini .sb-note{display:none}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:80;animation:fade .2s;border:0}
.drawer{position:fixed;top:0;left:0;bottom:0;width:250px;background:var(--bg);z-index:81;padding:0 12px 12px;overflow-y:auto;animation:slide-r .2s ease}
.drawer-h{display:flex;align-items:center;gap:6px;height:56px;margin:0 -12px 6px;padding:0 12px}
.bnav{position:fixed;left:0;right:0;bottom:0;height:56px;background:var(--bg);border-top:1px solid var(--line2);display:flex;z-index:62}
.bnav button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10px;color:var(--txt2)}
.bnav button.on{color:var(--txt)}

/* ── chips ── */
.chips-wrap{position:sticky;top:var(--hd-h);z-index:40;background:var(--bg)}
.chips{display:flex;gap:12px;padding:12px 0;overflow-x:auto;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:8px;background:var(--raised);font-size:14px;font-weight:500;transition:background .12s,color .12s;white-space:nowrap}
.chip:hover{background:var(--hover)}
.chip.on{background:var(--txt);color:var(--bg)}
.chip.on:hover{background:var(--txt)}
.chip.locked{color:#7a7a7a;cursor:default;background:rgba(39,39,39,.55)}
.chip.locked:hover{background:rgba(39,39,39,.55)}
.pro{font-size:9px;font-weight:800;letter-spacing:.6px;color:#161616;background:var(--orange);border-radius:4px;padding:2px 5px}

/* ── layout / grid / cards ── */
.main{padding-top:var(--hd-h);transition:padding-left .2s ease;min-height:100vh}
.main.sb-full{padding-left:var(--sb-w)}
.main.sb-mini-pad{padding-left:var(--sb-mini)}
.page{padding:0 24px 60px;max-width:2000px;margin:0 auto}
.ph{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:600;padding:22px 0 6px}
.ph .ibtn{background:var(--raised)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));column-gap:16px;row-gap:40px;padding-top:20px}
.card{cursor:pointer;display:flex;flex-direction:column;gap:12px;min-width:0;text-align:left}
.thumb{position:relative;border-radius:var(--r);overflow:hidden;aspect-ratio:16/9;background:#181818;transition:border-radius .18s}
.card:hover .thumb{border-radius:7px}
.thumb svg{width:100%;height:100%;display:block}
.badge-dur{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.8);color:#fff;font-size:12px;font-weight:500;padding:1px 5px;border-radius:4px}
.badge-date{position:absolute;left:8px;top:8px;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);color:#eee;font-size:11px;font-weight:500;padding:2.5px 8px;border-radius:6px;letter-spacing:.2px}
.card-row{display:flex;gap:12px;align-items:flex-start}
.src-av{width:36px;height:36px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:700;color:#fff}
.card-body{flex:1;min-width:0}
.card-title{font-size:16px;line-height:22px;font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-meta{margin-top:5px;font-size:13px;color:var(--txt2);display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}
.mdot::before{content:"•";margin:0 1px;color:var(--txt2)}
.tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid}
.card .more{opacity:0;width:36px;height:36px;margin-left:auto}
.card:hover .more{opacity:1}
@media(hover:none){.card .more{opacity:1}}
.cmenu{position:fixed;z-index:75;background:#212121;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:8px 0;width:210px;animation:pop .14s ease}
.cmenu button{display:flex;align-items:center;gap:14px;width:100%;padding:9px 16px;font-size:14px;text-align:left}
.cmenu button:hover{background:#2c2c2c}
.sk-line{height:14px;border-radius:7px;background:#1e1e1e;margin-top:10px}
.shimmer{position:relative;overflow:hidden;background:#1e1e1e}
.shimmer::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent);animation:shimmer 1.4s infinite}
.feed-end{padding:44px 0;text-align:center;color:var(--txt2);font-size:13px}
.spin{width:26px;height:26px;border:3px solid #3f3f3f;border-top-color:var(--txt);border-radius:50%;animation:rot .8s linear infinite;margin:30px auto}
.empty{padding:70px 20px;text-align:center;color:var(--txt2);display:flex;flex-direction:column;align-items:center;gap:14px;font-size:14px}
.empty b{color:var(--txt);font-size:17px;font-weight:600}
`;

/* ═══════════════════════ 6 · STYLES (part 2) ═══════════════════════ */
const CSS2 = `
/* ── player ── */
.player{position:fixed;left:0;right:0;top:var(--hd-h);bottom:0;background:var(--bg);z-index:55;display:flex;align-items:center;justify-content:center;animation:fade .18s}
.pl-stage{position:relative;height:calc(100% - 40px);max-height:840px;display:flex;align-items:stretch;gap:0;transition:transform .24s ease}
.player.panel-open .pl-stage{transform:translateX(-208px)}
.pl-video{position:relative;height:100%;aspect-ratio:9/16;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 10px 44px rgba(0,0,0,.6)}
.pl-video>svg{position:absolute;inset:0;width:100%;height:100%}
.pl-kb{animation:kenburns 24s ease-in-out infinite alternate;transform-origin:62% 38%}
.pl-kb.paused{animation-play-state:paused}
.pl-grad{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.4),transparent 26%,transparent 52%,rgba(0,0,0,.76));pointer-events:none}
.pl-tap{position:absolute;inset:0;border:0;cursor:pointer}
.pl-topline{position:absolute;top:0;left:0;right:0;padding:14px;display:flex;justify-content:flex-end;pointer-events:none}
.pl-cat{display:inline-flex;align-items:center;gap:7px;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);border-radius:999px;padding:6px 13px;font-size:12.5px;font-weight:600;letter-spacing:.3px}
.pl-info{position:absolute;left:16px;right:74px;bottom:20px;pointer-events:none}
.pl-kick{display:inline-block;background:var(--blue);color:#04182b;font-weight:800;font-size:11.5px;letter-spacing:.9px;padding:3px 9px;border-radius:5px;margin-bottom:9px}
.pl-headline{font-size:19px;line-height:1.32;font-weight:600;text-shadow:0 1px 10px rgba(0,0,0,.65)}
.pl-sub{margin-top:9px;font-size:12.5px;color:#e2e2e2;display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;text-shadow:0 1px 6px rgba(0,0,0,.6)}
.pl-prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.22);z-index:2}
.pl-prog i{display:block;height:100%;background:#fff;transition:width .12s linear}
.pl-pp{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:66px;height:66px;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;animation:pop .2s;pointer-events:none}
.pl-close{position:absolute;left:18px;top:14px;z-index:3}
.pl-close .ibtn,.pl-nav .ibtn{background:var(--raised)}
.pl-rail{display:flex;flex-direction:column;justify-content:flex-end;gap:20px;padding:0 4px 6px 18px}
.rail-btn{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--txt)}
.rail-btn .ibtn{width:48px;height:48px}
.rail-btn .ibtn{background:var(--raised)}
.rail-btn .ibtn:hover{background:var(--hover)}
.rail-btn .liked{color:var(--red)}
.pl-nav{position:absolute;right:26px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:14px;z-index:3}
.pl-nav .ibtn{width:52px;height:52px}
.pl-nav .ibtn:disabled{opacity:.32;cursor:default}
.pl-nav .ibtn:disabled:hover{background:var(--raised)}

/* ── slide panel (summary / quiz — one shared shell) ── */
.pnl{position:absolute;top:20px;right:20px;bottom:20px;width:400px;max-width:calc(100vw - 32px);background:#212121;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:-6px 0 28px rgba(0,0,0,.45);animation:slide-l .22s cubic-bezier(.2,.7,.3,1);z-index:4}
.pnl-h{display:flex;align-items:center;gap:6px;padding:11px 10px 11px 18px;border-bottom:1px solid var(--line2);flex:none}
.pnl-h h3{font-size:16px;font-weight:600;flex:1;display:flex;align-items:center;gap:9px}
.pnl-h .ibtn{width:38px;height:38px}
.pnl-body{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.pnl-foot{flex:none;border-top:1px solid var(--line2);padding:10px 12px;background:#212121}
.tune{position:absolute;top:50px;right:54px;background:#2c2c2c;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:6px 0;z-index:5;animation:pop .14s;width:190px}
.tune button{display:flex;width:100%;padding:9px 15px;font-size:13.5px;gap:10px;align-items:center;text-align:left}
.tune button:hover{background:#383838}
.tune button.on{color:var(--blue);font-weight:600}

/* summary content */
.sum-p{font-size:14px;line-height:1.62;color:#e8e8e8}
.sum-sec{font-size:11px;font-weight:800;letter-spacing:1.2px;color:var(--txt2);margin-top:6px}
.sum-li{display:flex;gap:10px;font-size:13.5px;line-height:1.5;color:#ddd}
.sum-li i{color:var(--blue);flex:none;margin-top:2px;display:flex}
.sum-src{display:flex;align-items:center;gap:11px;background:var(--raised);border-radius:10px;padding:9px 12px;font-size:13px}
.sum-src small{color:var(--txt2);font-size:12px;display:block;margin-top:1px}
.mode-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.4px;color:var(--blue);background:rgba(62,166,255,.1);border:1px solid rgba(62,166,255,.35);border-radius:999px;padding:3px 9px;align-self:flex-start}
.regen{display:flex;align-items:center;gap:10px;color:var(--txt2);font-size:13px;padding:26px 0;justify-content:center}
.regen .spin{margin:0;width:18px;height:18px;border-width:2.5px}

/* chat */
.chat{display:flex;flex-direction:column;gap:10px}
.chat-hint{font-size:12px;color:var(--txt2);text-align:center;padding:2px 0 0}
.msg{max-width:86%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.52;white-space:pre-wrap;word-break:break-word;animation:pop .18s}
.msg.user{align-self:flex-end;background:var(--blue);color:#04182b;border-bottom-right-radius:4px;font-weight:500}
.msg.ai{align-self:flex-start;background:var(--raised);border-bottom-left-radius:4px}
.typing{display:inline-flex;gap:4px;padding:13px 15px;background:var(--raised);border-radius:14px;border-bottom-left-radius:4px;align-self:flex-start}
.typing i{width:6px;height:6px;border-radius:50%;background:#9a9a9a;animation:blink 1.2s infinite}
.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}
.ask-in{display:flex;align-items:center;gap:8px;background:var(--bg2);border:1px solid #303030;border-radius:999px;padding:4px 4px 4px 15px}
.ask-in:focus-within{border-color:var(--blue-d)}
.ask-in input{flex:1;font-size:13.5px;height:34px;min-width:0}
.send{width:36px;height:36px;border-radius:50%;background:var(--blue);color:#04182b;display:flex;align-items:center;justify-content:center;flex:none;transition:opacity .15s,transform .1s}
.send:active{transform:scale(.94)}
.send:disabled{opacity:.35;cursor:default}

/* quiz content */
.qz-top{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--txt2);font-weight:500}
.qz-pts{display:flex;align-items:center;gap:6px;color:var(--blue);font-weight:700}
.qz-bar{height:4px;border-radius:2px;background:#3a3a3a;overflow:hidden}
.qz-bar i{display:block;height:100%;background:var(--blue);transition:width .3s ease}
.qz-q{font-size:15.5px;font-weight:600;line-height:1.45;animation:pop .2s}
.qz-opt{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--raised);border:1.5px solid transparent;border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.4;transition:background .13s,border-color .13s;animation:pop .2s}
.qz-opt:hover:not(:disabled){background:var(--hover)}
.qz-opt:disabled{cursor:default}
.qz-opt.correct{border-color:var(--green);background:rgba(43,166,64,.14)}
.qz-opt.wrong{border-color:var(--red);background:rgba(255,78,69,.12);animation:shake .3s}
.qz-opt.dim{opacity:.45}
.qz-letter{width:26px;height:26px;border-radius:8px;background:#3a3a3a;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:700;flex:none}
.qz-fb{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;animation:pop .2s;min-height:20px}
.qz-done{display:flex;flex-direction:column;align-items:center;gap:11px;text-align:center;padding:24px 0;animation:pop .25s}
.qz-badge{width:74px;height:74px;border-radius:50%;background:rgba(62,166,255,.12);border:2px solid var(--blue);display:flex;align-items:center;justify-content:center;color:var(--blue)}
.qz-score{font-size:32px;font-weight:800}
.qz-sub{font-size:13px;color:var(--txt2);line-height:1.5}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--txt);color:var(--bg);font-weight:600;font-size:14px;border-radius:999px;padding:9px 20px;transition:opacity .15s,transform .1s}
.btn:hover{opacity:.9}
.btn:active{transform:scale(.98)}
.btn.ghost{background:var(--raised);color:var(--txt)}
.btn.blue{background:var(--blue);color:#04182b}

/* ── Ask AI page + Simplify page ── */
.aiv{max-width:760px;margin:0 auto;padding:30px 0 30px;display:flex;flex-direction:column;gap:16px;min-height:calc(100vh - 140px)}
.aiv-hero{text-align:center;padding:34px 0 8px;display:flex;flex-direction:column;align-items:center;gap:12px}
.aiv-hero h2{font-size:26px;font-weight:700}
.aiv-hero p{color:var(--txt2);font-size:14px;max-width:430px;line-height:1.55}
.aiv-glow{width:60px;height:60px;border-radius:50%;background:rgba(62,166,255,.12);border:1.5px solid rgba(62,166,255,.5);display:flex;align-items:center;justify-content:center;color:var(--blue)}
.sugg{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
.sugg button{border:1px solid var(--line);border-radius:999px;padding:8px 15px;font-size:13.5px;color:#ddd;transition:background .13s,border-color .13s}
.sugg button:hover{background:var(--raised);border-color:transparent}
.aiv .chat{padding:4px 2px}
.aiv-in{position:sticky;bottom:14px;margin-top:auto;background:var(--bg);padding-top:8px}
.smp{max-width:760px;margin:0 auto;padding:26px 0;display:flex;flex-direction:column;gap:14px}
.smp textarea{width:100%;min-height:190px;background:var(--bg2);border:1px solid #303030;border-radius:14px;padding:15px;font-size:14px;line-height:1.6;resize:vertical;transition:border-color .15s}
.smp textarea:focus{border-color:var(--blue-d)}
.smp-row{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap}
.smp-out{background:var(--raised);border-radius:14px;padding:17px;font-size:14px;line-height:1.65;white-space:pre-wrap;animation:pop .2s}
.smp-out h5{font-size:11px;font-weight:800;letter-spacing:1.2px;color:var(--blue);margin-bottom:9px}

/* ── google modal ── */
.gm-scrim{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:90;display:flex;align-items:center;justify-content:center;animation:fade .15s;padding:20px;border:0;width:100%}
.gm{width:400px;max-width:100%;background:#fff;color:#1f1f1f;border-radius:26px;padding:34px 30px 22px;text-align:center;animation:pop .2s;cursor:default}
.gm h4{font-size:22px;font-weight:500;margin:16px 0 5px}
.gm p{font-size:14px;color:#5f6368;margin-bottom:18px}
.gm-acc{display:flex;align-items:center;gap:13px;width:100%;padding:10px 13px;border-radius:14px;border:1px solid #dadce0;margin-top:10px;text-align:left;transition:background .12s;background:#fff}
.gm-acc:hover{background:#f6f8fa}
.gm-av{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:15px;flex:none}
.gm-acc b{font-size:14px;font-weight:500;display:block;color:#1f1f1f}
.gm-acc span{font-size:12.5px;color:#5f6368}
.gm-note{font-size:11.5px;color:#80868b;margin-top:18px;line-height:1.55;text-align:left}
.gm-cancel{margin-top:12px;color:#1a73e8;font-weight:500;font-size:14px;padding:8px 16px;border-radius:999px}
.gm-cancel:hover{background:#f0f6ff}

/* ── toasts ── */
.toasts{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:100;align-items:center;pointer-events:none}
.toast{background:#f1f1f1;color:#0f0f0f;font-size:13.5px;font-weight:500;border-radius:999px;padding:10px 19px;box-shadow:0 8px 24px rgba(0,0,0,.45);animation:toast-in .25s;display:flex;align-items:center;gap:9px;max-width:88vw}

/* ── keyframes ── */
@keyframes fade{from{opacity:0}}
@keyframes pop{from{opacity:0;transform:scale(.96)}}
@keyframes slide-l{from{transform:translateX(64px);opacity:0}}
@keyframes slide-r{from{transform:translateX(-100%)}}
@keyframes slide-up{from{transform:translateY(100%)}}
@keyframes shimmer{to{transform:translateX(100%)}}
@keyframes rot{to{transform:rotate(360deg)}}
@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
@keyframes kenburns{from{transform:scale(1)}to{transform:scale(1.15) translate(-1.6%,1.4%)}}
@keyframes toast-in{from{opacity:0;transform:translateY(16px)}}
@keyframes heart{0%{transform:scale(1)}35%{transform:scale(1.4)}}
.heart-anim{animation:heart .35s ease}

/* ── responsive ── */
@media(max-width:1279px){
  .player.panel-open .pl-stage{transform:none}
  .player.panel-open .pl-nav{display:none}
}
@media(max-width:767px){
  .page{padding:0 12px 100px}
  .grid{grid-template-columns:1fr;row-gap:26px;padding-top:14px}
  .hd{padding:0 6px}
  .hd-brand{padding:0 6px}
  .hd-center{padding:0 4px}
  .askbar-btn{width:48px}
  .menu{left:8px;right:8px;width:auto;top:calc(var(--hd-h) - 2px)}
  .main{padding-left:0 !important;padding-bottom:56px}
  .ph{font-size:18px;padding:16px 0 2px}
  .player{bottom:0;z-index:63}
  .pl-stage{height:100%;max-height:none;width:100%}
  .pl-video{aspect-ratio:auto;width:100%;height:100%;border-radius:0;box-shadow:none}
  .pl-rail{position:absolute;right:6px;bottom:26px;z-index:3;padding:0;gap:17px}
  .pl-info{right:70px;bottom:22px}
  .pl-nav{display:none}
  .pl-close{left:10px;top:10px}
  .pnl{top:auto;left:0;right:0;bottom:0;height:68%;width:auto;max-width:none;border-radius:16px 16px 0 0;animation:slide-up .24s ease}
  .player.panel-open .pl-stage{transform:none}
  .aiv{padding:16px 0}
  .aiv-hero{padding:20px 0 4px}
  .aiv-hero h2{font-size:22px}
  .toasts{bottom:76px}
}
`;
const CSS = CSS1 + CSS2;

/* ══════════════ 7 · ATOMS — tags, meta, toasts, thumbnail art ═══════ */

const BiasTag = ({ bias }) => {
  const b = BIAS[bias] || BIAS.centre;
  return (
    <span className="tag" style={{ color: b.color, borderColor: b.color + "59" }}>
      {b.label}
    </span>
  );
};

const FactTag = ({ fact }) => {
  const f = FACT[fact] || FACT.verified;
  return (
    <span className="tag" style={{ color: f.color, borderColor: f.color + "59" }}>
      <Icon name={f.icon} size={11} stroke={2.4} />
      {f.label}
    </span>
  );
};

const SourceAvatar = ({ name, size = 36 }) => {
  const m = sourceMeta(name);
  return (
    <div className="src-av" style={{ background: m.color, width: size, height: size, fontSize: size * 0.36 }}>
      {m.initials}
    </div>
  );
};

/** Source • bias • fact-check • timestamp — visual only, per spec (not clickable). */
const StoryMeta = ({ story, light }) => (
  <div className="card-meta" style={light ? { color: "#e2e2e2" } : null}>
    <span>{story.source}</span>
    <BiasTag bias={story.bias} />
    <FactTag fact={story.fact} />
    <span className="mdot">{timeAgo(story.publishedAt)}</span>
  </div>
);

const Toasts = ({ items }) => (
  <div className="toasts">
    {items.map((t) => (
      <div key={t.id} className="toast">
        <Icon name={t.icon || "check"} size={16} stroke={2.4} />
        {t.text}
      </div>
    ))}
  </div>
);

/* ── Designed thumbnail / video art ─────────────────────────────────
   Every story gets deterministic editorial artwork generated from its
   seed — a chart for finance, a globe with routes for geopolitics, a
   pitch with ball flight for sports. Same engine renders 16:9 cards
   and 9:16 video frames. Swap for real stills by replacing ThumbArt. */

function ThumbArt({ story, variant = "card", paused }) {
  const W = variant === "video" ? 360 : 640;
  const H = variant === "video" ? 640 : 360;
  const vertical = H > W;
  const rnd = seeded(story.seed * 7 + (vertical ? 991 : 17));
  const uid = story.id + "-" + variant;
  const cat = story.category;

  const PAL = {
    geopolitics: { a: "#0b1c31", b: "#17395e", acc: "#4da3ff", soft: "#9cc5f2" },
    finance: { a: "#0b2320", b: "#124038", acc: "#2bd4a0", soft: "#9fe8d2" },
    sports: { a: "#0d2a15", b: "#1c5a2e", acc: "#7ef29a", soft: "#c6f7d0" },
  };
  const pal = PAL[cat] || PAL.geopolitics;
  const finDown = cat === "finance" && rnd() < 0.42;
  const accent = finDown ? "#ff6b61" : pal.acc;

  let art = null;

  if (cat === "finance") {
    const n = 11;
    const x0 = W * 0.06, x1 = W * 0.94;
    const yTop = H * (vertical ? 0.3 : 0.24), yBot = H * (vertical ? 0.72 : 0.8);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const base = finDown ? yTop + (yBot - yTop) * t : yBot - (yBot - yTop) * t;
      const wob = (rnd() - 0.5) * (yBot - yTop) * 0.34;
      pts.push([x0 + (x1 - x0) * t, Math.max(yTop, Math.min(yBot, base + wob * (i === 0 || i === n - 1 ? 0.3 : 1)))]);
    }
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const area = line + " L" + x1 + "," + H + " L" + x0 + "," + H + " Z";
    const last = pts[n - 1];
    art = (
      <g>
        {[0.25, 0.45, 0.65, 0.85].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#ffffff" strokeOpacity="0.07" strokeWidth="1" />
        ))}
        {[0.2, 0.5, 0.8].map((f) => (
          <line key={f} x1={W * f} x2={W * f} y1={0} y2={H} stroke="#ffffff" strokeOpacity="0.045" strokeWidth="1" />
        ))}
        <path d={area} fill={"url(#area-" + uid + ")"} />
        <path d={line} fill="none" stroke={accent} strokeWidth={vertical ? 5 : 4} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={last[0]} cy={last[1]} r={vertical ? 13 : 10} fill={accent} opacity="0.22" />
        <circle cx={last[0]} cy={last[1]} r={vertical ? 6 : 5} fill={accent} />
        <path
          d={finDown
            ? "M" + (W * 0.82) + "," + (H * 0.18) + " l26,26 m0,-18 v18 h-18"
            : "M" + (W * 0.82) + "," + (H * 0.22) + " l26,-26 m0,18 v-18 h-18"}
          stroke={accent} strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.9"
        />
      </g>
    );
  } else if (cat === "sports") {
    const m = Math.min(W, H) * 0.09;
    const bx = W * (0.22 + rnd() * 0.1), by = H * (0.62 + rnd() * 0.12);
    const tx = W * (0.72 + rnd() * 0.12), ty = H * (0.2 + rnd() * 0.14);
    const midx = (bx + tx) / 2, midy = Math.min(by, ty) - H * 0.22;
    art = (
      <g>
        <ellipse cx={W / 2} cy={-H * 0.05} rx={W * 0.75} ry={H * 0.28} fill="#ffffff" opacity="0.06" />
        <g stroke="#ffffff" strokeOpacity="0.35" strokeWidth="2.5" fill="none">
          <rect x={m} y={m} width={W - 2 * m} height={H - 2 * m} rx="6" />
          {vertical ? (
            <line x1={m} x2={W - m} y1={H / 2} y2={H / 2} />
          ) : (
            <line x1={W / 2} x2={W / 2} y1={m} y2={H - m} />
          )}
          <circle cx={W / 2} cy={H / 2} r={Math.min(W, H) * 0.14} />
          <circle cx={W / 2} cy={H / 2} r="4" fill="#ffffff" fillOpacity="0.35" stroke="none" />
          {vertical ? (
            <g>
              <rect x={W * 0.28} y={m} width={W * 0.44} height={H * 0.1} />
              <rect x={W * 0.28} y={H - m - H * 0.1} width={W * 0.44} height={H * 0.1} />
            </g>
          ) : (
            <g>
              <rect x={m} y={H * 0.3} width={W * 0.1} height={H * 0.4} />
              <rect x={W - m - W * 0.1} y={H * 0.3} width={W * 0.1} height={H * 0.4} />
            </g>
          )}
        </g>
        <path d={"M" + bx + "," + by + " Q" + midx + "," + midy + " " + tx + "," + ty} fill="none" stroke={pal.acc} strokeWidth="3.5" strokeDasharray="2 11" strokeLinecap="round" />
        <circle cx={bx} cy={by} r={Math.min(W, H) * 0.052} fill="#ffffff" />
        <path
          d={"M" + (bx - 9) + "," + (by - 4) + " q9,-7 18,0 M" + (bx - 7) + "," + (by + 6) + " q7,5 14,0"}
          stroke="#1c1c1c" strokeWidth="2" fill="none" strokeLinecap="round"
        />
        <circle cx={tx} cy={ty} r="7" fill="none" stroke={pal.acc} strokeWidth="2.5" opacity="0.85" />
        <circle cx={tx} cy={ty} r="13" fill="none" stroke={pal.acc} strokeWidth="1.5" opacity="0.35" />
      </g>
    );
  } else {
    const gx = W * (vertical ? 0.5 : 0.66), gy = H * (vertical ? 0.42 : 0.52);
    const r = Math.min(W, H) * (vertical ? 0.52 : 0.46);
    const p1a = -0.6 - rnd() * 0.5, p2a = 0.4 + rnd() * 0.6, p3a = 1.7 + rnd() * 0.5;
    const pt = (ang, rr) => [gx + Math.cos(ang) * r * rr, gy + Math.sin(ang) * r * rr];
    const A = pt(p1a, 0.72), B = pt(p2a, 0.8), C = pt(p3a, 0.66);
    const arc = (P, Q) => {
      const mx = (P[0] + Q[0]) / 2 - (Q[1] - P[1]) * 0.35;
      const my = (P[1] + Q[1]) / 2 + (Q[0] - P[0]) * 0.35;
      return "M" + P[0].toFixed(1) + "," + P[1].toFixed(1) + " Q" + mx.toFixed(1) + "," + my.toFixed(1) + " " + Q[0].toFixed(1) + "," + Q[1].toFixed(1);
    };
    art = (
      <g>
        <circle cx={gx} cy={gy} r={r} fill={"url(#glb-" + uid + ")"} stroke={pal.soft} strokeOpacity="0.5" strokeWidth="1.5" />
        <g fill="none" stroke={pal.soft} strokeOpacity="0.34" strokeWidth="1.3">
          <ellipse cx={gx} cy={gy} rx={r * 0.55} ry={r} />
          <ellipse cx={gx} cy={gy} rx={r * 0.9} ry={r} />
          <ellipse cx={gx} cy={gy} rx={r} ry={r * 0.5} />
          <ellipse cx={gx} cy={gy} rx={r} ry={r * 0.85} />
          <line x1={gx - r} x2={gx + r} y1={gy} y2={gy} />
        </g>
        <g fill="none" stroke={accent} strokeWidth="2.6" strokeLinecap="round">
          <path d={arc(A, B)} strokeDasharray="1 9" />
          <path d={arc(B, C)} strokeDasharray="1 9" opacity="0.8" />
        </g>
        {[A, B, C].map((P, i) => (
          <g key={i}>
            <circle cx={P[0]} cy={P[1]} r="12" fill={accent} opacity="0.18" />
            <circle cx={P[0]} cy={P[1]} r="4.5" fill={accent} />
          </g>
        ))}
      </g>
    );
  }

  const kickSize = vertical ? 0 : story.kicker.length <= 10 ? 46 : story.kicker.length <= 15 ? 37 : 29;

  return (
    <svg viewBox={"0 0 " + W + " " + H} preserveAspectRatio="xMidYMid slice" className={variant === "video" ? cls("pl-kb", paused && "paused") : undefined} aria-hidden="true">
      <defs>
        <linearGradient id={"bg-" + uid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={pal.a} />
          <stop offset="1" stopColor={pal.b} />
        </linearGradient>
        <linearGradient id={"area-" + uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={accent} stopOpacity="0.34" />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </linearGradient>
        <radialGradient id={"glb-" + uid} cx="0.35" cy="0.3" r="1">
          <stop offset="0" stopColor={pal.soft} stopOpacity="0.26" />
          <stop offset="1" stopColor={pal.soft} stopOpacity="0.03" />
        </radialGradient>
        <radialGradient id={"vin-" + uid} cx="0.5" cy="0.42" r="0.85">
          <stop offset="0.55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.5" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={"url(#bg-" + uid + ")"} />
      {art}
      <rect width={W} height={H} fill={"url(#vin-" + uid + ")"} />
      {!vertical && (
        <g>
          <rect x="32" y={H - 84} width="44" height="6" rx="3" fill={accent} />
          <text x="32" y={H - 36} fill="#ffffff" fontFamily="Roboto,Arial,sans-serif" fontWeight="800" fontSize={kickSize} letterSpacing="1">
            {story.kicker}
          </text>
        </g>
      )}
      <text x={W - 18} y="30" textAnchor="end" fill="#ffffff" opacity="0.5" fontFamily="Roboto,Arial,sans-serif" fontWeight="800" fontSize="13" letterSpacing="2.5">
        N30
      </text>
    </svg>
  );
}

/* ═══════ 8 · CHROME — header, sidebar, drawer, nav, menus, auth ═════ */

const NAV = [
  { id: "home", label: "Home", icon: "home", short: "Home" },
  { id: "trending", label: "Trending", icon: "flame", short: "Trending" },
  { id: "saved", label: "Saved Stories", icon: "bookmark", short: "Saved" },
  { id: "askai", label: "Ask AI", icon: "sparkle", short: "Ask AI" },
  { id: "simplify", label: "Simplify Article", icon: "fileText", short: "Simplify" },
];

function Header({ onMenu, onBrand, query, setQuery, onAsk, notifCount, onBell, user, onProfile }) {
  return (
    <header className="hd">
      <div className="hd-left">
        <button className="ibtn" onClick={onMenu} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <button className="hd-brand" onClick={onBrand} aria-label="News30 home">
          <Brand height={21} />
        </button>
      </div>
      <div className="hd-center">
        <div className="askbar">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && query.trim()) onAsk(); }}
            placeholder="Ask AI anything — what's happening today?"
            aria-label="Ask AI"
          />
          <span className="ai-pill">AI</span>
          <button className="askbar-btn" onClick={onAsk} aria-label="Submit question">
            <Icon name="search" size={22} />
          </button>
        </div>
      </div>
      <div className="hd-right">
        <button className="ibtn" onClick={onBell} aria-label="Notifications">
          <Icon name="bell" />
          {notifCount > 0 && <span className="dot">{notifCount > 9 ? "9+" : notifCount}</span>}
        </button>
        <button className="ibtn" onClick={onProfile} aria-label="Profile">
          {user ? (
            <div className="avatar" style={{ background: user.color }}>
              {user.picture
                ? <img src={user.picture} alt="" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
                : user.name[0]}
            </div>
          ) : (
            <Icon name="person" />
          )}
        </button>
      </div>
    </header>
  );
}

function SidebarItems({ active, onNav, mini }) {
  return (
    <nav>
      {NAV.map((n) => (
        <button key={n.id} className={cls("sb-item", active === n.id && "on")} onClick={() => onNav(n.id)}>
          <Icon name={n.icon} size={mini ? 22 : 24} filled={active === n.id} />
          <span>{mini ? n.short : n.label}</span>
        </button>
      ))}
    </nav>
  );
}

function Sidebar({ mode, active, onNav }) {
  if (mode === "hidden") return null;
  const mini = mode === "mini";
  return (
    <aside className={cls("sb", mini && "mini")}>
      <SidebarItems active={active} onNav={onNav} mini={mini} />
      <div className="sb-sep" />
      <div className="sb-note">
        AI-condensed news in 30 seconds. Geopolitics · Finance · Sports.
        <br />
        <br />© 2026 News30
      </div>
    </aside>
  );
}

function Drawer({ open, active, onNav, onClose }) {
  if (!open) return null;
  return (
    <React.Fragment>
      <button className="scrim" onClick={onClose} aria-label="Close menu" />
      <aside className="drawer">
        <div className="drawer-h">
          <button className="ibtn" onClick={onClose} aria-label="Close menu">
            <Icon name="menu" />
          </button>
          <button className="hd-brand" onClick={() => { onNav("home"); onClose(); }}>
            <Brand height={20} />
          </button>
        </div>
        <SidebarItems active={active} onNav={(id) => { onNav(id); onClose(); }} />
        <div className="sb-sep" />
        <div className="sb-note">AI-condensed news in 30 seconds.<br />© 2026 News30</div>
      </aside>
    </React.Fragment>
  );
}

function BottomNav({ active, onNav }) {
  return (
    <nav className="bnav">
      {NAV.map((n) => (
        <button key={n.id} className={cls(active === n.id && "on")} onClick={() => onNav(n.id)}>
          <Icon name={n.icon} size={22} filled={active === n.id} />
          {n.short}
        </button>
      ))}
    </nav>
  );
}

const MenuScrim = ({ onClose }) => (
  <button
    onClick={onClose}
    aria-label="Close"
    style={{ position: "fixed", inset: 0, zIndex: 65, background: "transparent", cursor: "default" }}
  />
);

function NotifMenu({ items, onOpenStory, onMarkAll, onClose }) {
  const unread = items.filter((n) => !n.read).length;
  return (
    <React.Fragment>
      <MenuScrim onClose={onClose} />
      <div className="menu" role="menu">
        <div className="menu-h">
          Notifications
          {unread > 0 && <small onClick={onMarkAll}>Mark all as read</small>}
        </div>
        <div className="menu-list">
          {items.length === 0 && (
            <div className="menu-empty">
              <Icon name="bell" size={30} />
              <span>No notifications yet.<br />New stories will land here the moment they post.</span>
            </div>
          )}
          {items.map((n) => {
            const story = findStoryById(n.storyId);
            if (!story) return null;
            return (
              <button key={n.id} className="notif" onClick={() => onOpenStory(story)}>
                <div className="notif-thumb">
                  <ThumbArt story={story} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="notif-t">{n.title}</div>
                  <div className="notif-m">{story.source} · {timeAgo(n.at)}</div>
                </div>
                {!n.read && <span className="notif-dot" />}
              </button>
            );
          })}
        </div>
      </div>
    </React.Fragment>
  );
}

function ProfileMenu({ user, data, onGoogle, onSignOut, onSaved, onClose }) {
  const stats = [
    { k: "streak", label: "Day streak", val: (user ? data.loginActivity.streak : 0) + "d", icon: "flame" },
    { k: "points", label: "Points", val: user ? fmtCount(data.profile.totalPoints) : 0, icon: "star" },
    { k: "videos", label: "Videos watched", val: user ? data.engagement.videosWatched : 0, icon: "play" },
    { k: "acc", label: "Quiz accuracy", val: (user ? data.profile.quizAccuracy : 0) + "%", icon: "bolt" },
  ];
  return (
    <React.Fragment>
      <MenuScrim onClose={onClose} />
      <div className="menu" role="menu">
        <div className="pf-head">
          {user ? (
            <div className="avatar" style={{ background: user.color, width: 42, height: 42, fontSize: 17 }}>
              {user.picture
                ? <img src={user.picture} alt="" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
                : user.name[0]}
            </div>
          ) : (
            <div className="avatar" style={{ background: "#3a3a3a", width: 42, height: 42 }}>
              <Icon name="person" size={22} />
            </div>
          )}
          <div>
            <div className="pf-name">{user ? user.name : "Guest"}</div>
            <div className="pf-mail">{user ? user.email : "Not signed in"}</div>
          </div>
        </div>
        <div className="pf-stats">
          {stats.map((s) => (
            <div className="stat" key={s.k}>
              <b><Icon name={s.icon} size={16} stroke={2.2} /> {s.val}</b>
              <span>{s.label}</span>
            </div>
          ))}
          {!user && (
            <div className="pf-lock">
              <Icon name="lock" size={26} />
              <p>Sign up to track your streak, points, videos watched and quiz accuracy.</p>
              <button className="gbtn" onClick={onGoogle}>
                <GoogleG size={18} /> Sign up or Log in
              </button>
            </div>
          )}
        </div>
        <div style={{ borderTop: "1px solid rgba(255,255,255,.1)", padding: "6px 0" }}>
          <button className="pf-row" onClick={onSaved}>
            <Icon name="bookmark" size={20} /> Saved stories
          </button>
          {user && (
            <button className="pf-row" onClick={onSignOut}>
              <Icon name="arrowLeft" size={20} /> Sign out
            </button>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

/* Google sign-in modal — 🔌 GOOGLE OAUTH via Supabase Auth.
   Real path: tapping the button calls supabaseAuth.signInWithGoogle(),
   which redirects to Google and back through Supabase's own callback;
   App's supabaseAuth.onChange() listener picks up the resulting
   session (see App below) and calls onPick indirectly via runLoginFlow.
   Demo path: only shown if Supabase isn't configured yet, so sign-in
   stays testable before the backend is wired up.                     */
function GoogleModal({ onPick, onClose }) {
  const [busy, setBusy] = React.useState(false);
  const configured = supabaseAuth.configured();

  const continueWithGoogle = async () => {
    setBusy(true);
    try {
      await supabaseAuth.signInWithGoogle(); // redirects away from the page
    } catch (e) {
      setBusy(false);
    }
  };

  return (
    <div className="gm-scrim" onClick={onClose} role="button" aria-label="Close sign-in">
      <div className="gm" onClick={(e) => e.stopPropagation()} role="dialog">
        <GoogleG size={30} />
        <h4>{configured ? "Sign in to News30" : "Choose an account"}</h4>
        <p>to continue to <b style={{ color: "#1f1f1f" }}>News30</b></p>

        {configured ? (
          <React.Fragment>
            <button className="gbtn" onClick={continueWithGoogle} disabled={busy} style={{ margin: "14px auto 0" }}>
              <GoogleG size={18} /> {busy ? "Redirecting…" : "Continue with Google"}
            </button>
            <div className="gm-note">
              Real Google sign-in via Supabase Auth. Your streak, points and quiz
              accuracy attach to this account, protected by row-level security.
            </div>
          </React.Fragment>
        ) : (
          <React.Fragment>
            {MOCK_GOOGLE_ACCOUNTS.map((a) => (
              <button key={a.email} className="gm-acc" onClick={() => onPick(a)}>
                <span className="gm-av" style={{ background: a.color }}>{a.name[0]}</span>
                <span>
                  <b>{a.name}</b>
                  <span>{a.email}</span>
                </span>
              </button>
            ))}
            <div className="gm-note">
              Supabase isn't configured yet, so this is the demo chooser. It goes
              real once VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set and
              Google is enabled in Supabase → Authentication → Sign In / Providers.
            </div>
          </React.Fragment>
        )}

        <button className="gm-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/* ═══════════ 9 · VIEWS — feed, trending, saved, ask AI, simplify ════ */

function StoryCard({ story, onOpen, onCardMenu }) {
  return (
    <div className="card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="thumb">
        <ThumbArt story={story} />
        <span className="badge-date">{dateBadge(story.publishedAt)}</span>
        <span className="badge-dur">{story.duration}</span>
      </div>
      <div className="card-row">
        <SourceAvatar name={story.source} />
        <div className="card-body">
          <div className="card-title">{story.headline}</div>
          <StoryMeta story={story} />
        </div>
        <button className="ibtn more" aria-label="More options"
          onClick={(e) => { e.stopPropagation(); onCardMenu(e, story); }}>
          <Icon name="dotsVertical" size={20} />
        </button>
      </div>
    </div>
  );
}

const SkeletonCard = () => (
  <div className="card" aria-hidden="true">
    <div className="thumb shimmer" />
    <div className="card-row">
      <div className="src-av shimmer" style={{ background: "#1e1e1e" }} />
      <div className="card-body">
        <div className="sk-line shimmer" style={{ width: "92%", marginTop: 2 }} />
        <div className="sk-line shimmer" style={{ width: "58%" }} />
      </div>
    </div>
  </div>
);

const MAX_PAGES = 8;

function InfiniteFeed({ category, fresh, feedVersion, openPlayer, onCardMenu }) {
  const [pages, setPages] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const sentRef = React.useRef(null);

  React.useEffect(() => { setPages(1); }, [category]);

  const items = React.useMemo(() => {
    let out = [];
    for (let p = 0; p < pages; p++) out = out.concat(getFeed(category, p));
    const fr = (fresh || []).filter((s) => category === "all" || s.category === category);
    return [...fr, ...out];
  }, [category, pages, fresh, feedVersion]);

  const done = pages >= MAX_PAGES;

  React.useEffect(() => {
    const el = sentRef.current;
    if (!el || done) return;
    const io = new IntersectionObserver(
      (ents) => {
        if (ents[0].isIntersecting && !loading) {
          setLoading(true);
          setTimeout(() => { setPages((p) => p + 1); setLoading(false); }, 420);
        }
      },
      { rootMargin: "700px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loading, done, category]);

  return (
    <React.Fragment>
      <div className="grid">
        {items.map((s, i) => (
          <StoryCard key={s.id} story={s} onOpen={() => openPlayer(s, items, i)} onCardMenu={onCardMenu} />
        ))}
        {loading && <React.Fragment><SkeletonCard /><SkeletonCard /><SkeletonCard /></React.Fragment>}
      </div>
      <div ref={sentRef} style={{ height: 1 }} />
      {loading && <div className="spin" />}
      {done && <div className="feed-end">You're all caught up — that's the archive for now.</div>}
    </React.Fragment>
  );
}

function ChipsRow({ category, setCategory }) {
  return (
    <div className="chips-wrap">
      <div className="chips">
        {CATEGORIES.map((c) => (
          <button key={c.id} className={cls("chip", category === c.id && "on")} onClick={() => setCategory(c.id)}>
            {c.icon && <Icon name={c.icon} size={16} stroke={2} />}
            {c.label}
          </button>
        ))}
        {LOCKED_CATEGORIES.map((c) => (
          <span key={c.id} className="chip locked" title="News30 Pro — coming soon" aria-disabled="true">
            <Icon name="lock" size={13} stroke={2.2} />
            {c.label}
            <span className="pro">PRO</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function HomeView({ category, setCategory, fresh, feedVersion, openPlayer, onCardMenu }) {
  return (
    <div className="page">
      <ChipsRow category={category} setCategory={setCategory} />
      <InfiniteFeed category={category} fresh={fresh} feedVersion={feedVersion} openPlayer={openPlayer} onCardMenu={onCardMenu} />
    </div>
  );
}

function TrendingView({ feedVersion, openPlayer, onCardMenu }) {
  const items = React.useMemo(getTrending, [feedVersion]);
  return (
    <div className="page">
      <div className="ph"><Icon name="flame" size={24} /> Trending on News30</div>
      <div className="grid">
        {items.map((s, i) => (
          <StoryCard key={s.id} story={s} onOpen={() => openPlayer(s, items, i)} onCardMenu={onCardMenu} />
        ))}
      </div>
    </div>
  );
}

function SavedView({ savedIds, openPlayer, onCardMenu, goHome }) {
  const items = React.useMemo(
    () => savedIds.slice().reverse().map(findStoryById).filter(Boolean),
    [savedIds]
  );
  return (
    <div className="page">
      <div className="ph"><Icon name="bookmark" size={24} /> Saved stories</div>
      {items.length === 0 ? (
        <div className="empty">
          <Icon name="bookmark" size={34} />
          <b>No saved stories yet</b>
          <span>Tap the ⋮ menu on any story — or Save inside the player — and it lands here.</span>
          <button className="btn" onClick={goHome}>Browse today's stories</button>
        </div>
      ) : (
        <div className="grid">
          {items.map((s, i) => (
            <StoryCard key={s.id} story={s} onOpen={() => openPlayer(s, items, i)} onCardMenu={onCardMenu} />
          ))}
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  "What's happening in the World Cup today?",
  "Summarise today's top finance stories",
  "What did EU leaders agree on defence?",
  "Explain the Fed's latest signal simply",
];

function AskAIView({ thread, busy, onAsk }) {
  const [draft, setDraft] = React.useState("");
  const endRef = React.useRef(null);
  React.useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread, busy]);
  const send = () => {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft("");
    onAsk(q);
  };
  return (
    <div className="page">
      <div className="aiv">
        {thread.length === 0 && (
          <div className="aiv-hero">
            <div className="aiv-glow"><Icon name="sparkle" size={28} /></div>
            <h2>Ask AI anything</h2>
            <p>Live answers about geopolitics, finance and sport — grounded in today's news, with web search when it helps.</p>
            <div className="sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => onAsk(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        <div className="chat">
          {thread.map((m, i) => (
            <div key={i} className={cls("msg", m.role === "user" ? "user" : "ai")}>{m.text}</div>
          ))}
          {busy && <div className="typing"><i /><i /><i /></div>}
          <div ref={endRef} />
        </div>
        <div className="aiv-in">
          <div className="ask-in">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder="Ask about any story or topic…"
              aria-label="Ask AI"
            />
            <button className="send" onClick={send} disabled={!draft.trim() || busy} aria-label="Send">
              <Icon name="send" size={17} />
            </button>
          </div>
          <div className="chat-hint">Answers can use live web search · verify important facts</div>
        </div>
      </div>
    </div>
  );
}

function SimplifyView({ text, setText, result, busy, onRun }) {
  return (
    <div className="page">
      <div className="smp">
        <div className="aiv-hero" style={{ padding: "26px 0 4px" }}>
          <div className="aiv-glow"><Icon name="fileText" size={26} /></div>
          <h2>Simplify any article</h2>
          <p>Paste an article or dense paragraph — get it back in plain English, every fact intact.</p>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste article text here…"
          aria-label="Article text"
        />
        <div className="smp-row">
          <span style={{ fontSize: 12.5, color: "var(--txt2)" }}>{text.trim() ? text.trim().split(/\s+/).length + " words" : "Waiting for text"}</span>
          <button className="btn blue" onClick={onRun} disabled={!text.trim() || busy}>
            <Icon name="sparkle" size={16} /> {busy ? "Simplifying…" : "Simplify"}
          </button>
        </div>
        {busy && <div className="regen"><div className="spin" /> Rewriting in plain English…</div>}
        {!busy && result && (
          <div className="smp-out">
            <h5>PLAIN-ENGLISH VERSION</h5>
            {result}
            <div style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => copyText(result)}>
                <Icon name="share" size={15} /> Copy
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═════ 10 · STORY INSIGHT — summaries + quizzes (data + logic) ════ */

/* Hand-written editorial content for flagship stories; every other
   story gets structured generated content so the panels always work.
   🔌 Replace with real editorial/AI pipeline output later.           */
const CURATED_INSIGHT = {
  s1: {
    intro: [
      "Kylian Mbappé scored twice as France beat their quarter-final opponents to reach the 2026 World Cup semi-finals, extending a run in which he has scored in every knockout round so far.",
      "France meet England in Tuesday's semi-final, and the staff are expected to keep the same starting eleven that has carried them through the knockouts.",
    ],
    points: [
      "Mbappé scored both goals in France's quarter-final win",
      "France reach the 2026 World Cup semi-finals",
      "Semi-final against England is scheduled for Tuesday",
      "He has now scored in every knockout round this tournament",
    ],
    sources: [["Reuters", "Original match report"], ["AFP", "Wire photo + follow-up coverage"]],
    simple: "France won their quarter-final and are in the World Cup semi-finals. Mbappé scored both goals. They play England on Tuesday.",
    extra: [
      "Context: France came into the tournament as one of the favourites, but their group stage was shaky — this knockout surge has been built almost entirely on Mbappé's form and a much tighter back line.",
      "What to watch: whether England double-mark Mbappé on Tuesday, and who France trust on the opposite wing if they do.",
    ],
  },
  s3: {
    intro: [
      "Norway's first World Cup knockout run of the modern era ended at the quarter-final stage, the squad applauded off by a huge travelling support after the final whistle.",
      "It was Norway's first World Cup since 1998, and the campaign is being framed at home as a generational breakthrough rather than a failure.",
    ],
    points: [
      "Norway eliminated in the 2026 World Cup quarter-finals",
      "First World Cup appearance for Norway since 1998",
      "Squad's young core is expected to stay together for the next cycle",
      "NRK reports record Norwegian TV audiences across the run",
    ],
    sources: [["NRK", "Original reporting"], ["BBC Sport", "Match analysis"]],
    simple: "Norway are out of the World Cup after losing their quarter-final. It was still their best run in decades, and most of the team is young enough to come back stronger.",
    extra: [
      "Context: qualification alone ended a 28-year drought; reaching the last eight beat every pre-tournament expectation at home.",
      "What to watch: contract decisions on the young core this summer, and whether the federation keeps the coaching staff through the next qualifying cycle.",
    ],
  },
  f1: {
    intro: [
      "The US Federal Reserve signalled patience on interest rates after core inflation cooled to 2.4%, its lowest reading in over a year.",
      "Officials want several more months of consistent data before committing to cuts, while markets moved to price in easing later this year.",
    ],
    points: [
      "Core inflation cooled to 2.4%, the lowest in over a year",
      "The Fed held rates and signalled patience, not urgency",
      "Markets now price the first cut later this year",
      "Officials want several more months of confirming data",
    ],
    sources: [["Bloomberg", "Original report"], ["Reuters", "Market reaction"]],
    simple: "US inflation keeps falling — now 2.4%. The central bank left interest rates alone and hinted cuts could come later this year if the trend holds.",
    extra: [
      "Context: the Fed has been burned before by inflation re-accelerating after early optimism, which is why the language stays cautious even as the data improves.",
      "What to watch: the next two monthly inflation prints and the labour-market data — softness there is what would actually move the cut forward.",
    ],
  },
  f2: {
    intro: [
      "Crude prices fell around 3% after OPEC+ unexpectedly agreed to raise output quotas, wrong-footing traders positioned for an extension of existing curbs.",
      "Analysts read the move as a shift toward defending market share, with attention now on how quickly the extra barrels actually reach the market.",
    ],
    points: [
      "Oil fell roughly 3% on the surprise announcement",
      "OPEC+ agreed to raise output quotas",
      "The move is read as defending market share over price",
      "Pace of real supply increases is the next key question",
    ],
    sources: [["Reuters", "Original report"], ["FT", "Analyst reaction"]],
    simple: "Oil got about 3% cheaper. The big oil-producing countries surprised everyone by deciding to pump more, and traders had bet on the opposite.",
    extra: [
      "Context: quota announcements and delivered barrels are different things — several members already pump near capacity, so the real supply add may be smaller than the headline.",
      "What to watch: tanker-tracking data over the next month, and whether cheaper crude starts showing up in fuel prices.",
    ],
  },
  g1: {
    intro: [
      "EU leaders reached a provisional agreement on a joint defence fund after a marathon overnight summit — a step several capitals had resisted for years.",
      "The deal still needs parliamentary sign-off in member states, and officials caution that the financing details remain open.",
    ],
    points: [
      "Provisional deal reached on a joint EU defence fund",
      "Agreement followed an overnight negotiating session",
      "National parliaments still have to ratify it",
      "Financing split between members is not yet settled",
    ],
    sources: [["Reuters", "Original report"], ["DW", "Summit analysis"]],
    simple: "EU countries have agreed in principle to fund defence together for the first time at this scale. It is not final — national parliaments still have to approve it.",
    extra: [
      "Context: joint borrowing for defence crosses a line the EU has debated since 2022; the compromise reportedly involves opt-outs for traditionally neutral members.",
      "What to watch: ratification votes in the most sceptical parliaments, and whether the fund's first procurement list favours European manufacturers.",
    ],
  },
  g2: {
    intro: [
      "Ceasefire negotiations resumed in Cairo, where mediators tabled a new framework aimed at sequencing a truce with phased humanitarian access.",
      "Delegations described the atmosphere as cautious but engaged. No timeline has been agreed, and previous rounds have collapsed at similar stages.",
    ],
    points: [
      "Talks resumed in Cairo with a new mediator framework",
      "Proposal sequences a truce with phased humanitarian access",
      "Delegations cautious; no timeline agreed",
      "Earlier rounds collapsed at comparable stages",
    ],
    sources: [["AP", "Original report"], ["Al Jazeera", "Regional coverage"]],
    simple: "Peace talks have restarted in Cairo with a new plan on the table. Both sides are talking, but nothing is agreed yet and similar talks have failed before.",
    extra: [
      "Context: the new framework's sequencing — truce first, access second — is designed to get around the trust gap that sank earlier drafts.",
      "What to watch: whether either delegation publicly endorses the framework this week; silence has historically preceded collapse.",
    ],
  },
};

const CAT_CONTEXT = {
  geopolitics: {
    scene: "The story lands amid a crowded diplomatic calendar, and officials quoted in early coverage stress that positions can shift quickly between formal sessions.",
    back: "Context: files like this rarely move in a straight line — public statements are often negotiating positions, and the substance tends to be settled in unpublicised working groups.",
    watch: "What to watch: follow-up statements from the main parties in the next 48 hours, which usually reveal whether this holds.",
  },
  finance: {
    scene: "Early market reaction has been orderly, with desks treating the move as information rather than shock — positioning data over the next sessions will show whether that holds.",
    back: "Context: single prints and single headlines rarely change the macro picture on their own; trend confirmation is what moves policy and portfolios.",
    watch: "What to watch: the next scheduled data release in this series, and any follow-through in rates and FX markets.",
  },
  sports: {
    scene: "The result feeds directly into the 2026 World Cup picture, where fine margins across the knockout bracket are deciding who peaks at the right moment.",
    back: "Context: tournament football compresses form — one performance can rewrite a team's ceiling, in both directions.",
    watch: "What to watch: team news and fitness updates before the next fixture window.",
  },
};

function altSource(story) {
  const pool = (ARCH[story.category] || ARCH.geopolitics).sources.filter((s) => s !== story.source);
  return pool[story.seed % pool.length];
}

/** Returns { intro:[…], points:[…], sources:[[name,note]…] } for a mode. */
function getSummary(story, mode) {
  const c = CURATED_INSIGHT[story.id];
  if (c) {
    if (mode === "simple") return { intro: [c.simple], points: c.points.slice(0, 2), sources: c.sources };
    if (mode === "detailed") return { intro: [...c.intro, ...c.extra], points: c.points, sources: c.sources };
    return { intro: c.intro, points: c.points, sources: c.sources };
  }
  const ctx = CAT_CONTEXT[story.category] || CAT_CONTEXT.geopolitics;
  const p1 = story.headline + ". " + story.source + " filed the report " + timeAgo(story.publishedAt) +
    ", and News30's fact-check layer currently marks it " + FACT[story.fact].label + ".";
  const base = {
    intro: [p1, ctx.scene],
    points: [
      story.headline,
      "Source: " + story.source + " — " + BIAS[story.bias].label + " outlet",
      "Fact-check status: " + FACT[story.fact].label,
      "Published " + fullDate(story.publishedAt) + " (" + timeAgo(story.publishedAt) + ")",
    ],
    sources: [[story.source, "Original report"], [altSource(story), "Related coverage"]],
  };
  if (mode === "simple") {
    return {
      intro: ["In short: " + story.headline.toLowerCase().replace(/^./, (ch) => ch.toUpperCase()) + ". It comes from " + story.source + " and is marked " + FACT[story.fact].label + "."],
      points: base.points.slice(0, 2),
      sources: base.sources,
    };
  }
  if (mode === "detailed") return { ...base, intro: [...base.intro, ctx.back, ctx.watch] };
  return base;
}

/* ── Quiz bank ──────────────────────────────────────────────────────
   🔌 QUIZ DATA: separated from stories on purpose — shaped like the
   quiz tables a backend would serve ({ q, opts[4], correct }).      */
const POINTS_PER_CORRECT = 10;

const CURATED_QUIZ = {
  s1: [
    { q: "How many goals did Mbappé score in the quarter-final?", opts: ["One", "Two", "Three", "None — he assisted both"], correct: 1 },
    { q: "What stage have France now reached?", opts: ["Quarter-finals", "Semi-finals", "The final", "Round of 16"], correct: 1 },
    { q: "Who do France face next, and when?", opts: ["Spain, on Wednesday", "England, on Tuesday", "Brazil, on Friday", "Germany, on Sunday"], correct: 1 },
  ],
  s3: [
    { q: "At what stage did Norway's run end?", opts: ["Round of 16", "Group stage", "Quarter-finals", "Semi-finals"], correct: 2 },
    { q: "When had Norway last played at a World Cup?", opts: ["2010", "1994", "2006", "1998"], correct: 3 },
    { q: "How is the campaign being described at home?", opts: ["A national embarrassment", "A generational breakthrough", "A refereeing scandal", "A financial disaster"], correct: 1 },
  ],
  f1: [
    { q: "What did core inflation cool to?", opts: ["3.1%", "2.9%", "2.4%", "1.8%"], correct: 2 },
    { q: "What did the Fed do with rates?", opts: ["Cut immediately", "Raised them", "Held, signalling patience", "Announced an emergency meeting"], correct: 2 },
    { q: "What do markets now expect?", opts: ["A hike next month", "Cuts later this year", "No change for two years", "Negative rates"], correct: 1 },
  ],
  f2: [
    { q: "Roughly how far did oil fall?", opts: ["1%", "3%", "8%", "12%"], correct: 1 },
    { q: "What triggered the move?", opts: ["A surprise OPEC+ output increase", "A refinery fire", "New sanctions", "A demand collapse in Asia"], correct: 0 },
    { q: "How are analysts reading the decision?", opts: ["Defending market share", "A push for higher prices", "A clerical error", "A response to green policy"], correct: 0 },
  ],
  g1: [
    { q: "What did EU leaders provisionally agree on?", opts: ["A joint defence fund", "A new trade tariff", "Enlargement talks", "A digital currency"], correct: 0 },
    { q: "What still has to happen for the deal to stand?", opts: ["A public referendum in every state", "Parliamentary sign-off in member states", "UN approval", "Nothing — it is final"], correct: 1 },
    { q: "Which detail remains unresolved?", opts: ["The fund's name", "The financing split", "The summit venue", "The launch date of the euro"], correct: 1 },
  ],
  g2: [
    { q: "Where did ceasefire talks resume?", opts: ["Geneva", "Doha", "Cairo", "Oslo"], correct: 2 },
    { q: "What does the new framework sequence a truce with?", opts: ["Prisoner releases only", "Phased humanitarian access", "Immediate elections", "Border redrawing"], correct: 1 },
    { q: "How did delegations describe the mood?", opts: ["Cautious but engaged", "Openly hostile", "Celebratory", "Indifferent"], correct: 0 },
  ],
};

function shuffleSeeded(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function getQuiz(story) {
  if (CURATED_QUIZ[story.id]) return CURATED_QUIZ[story.id];
  const rnd = seeded(story.seed + 5);
  const srcPool = shuffleSeeded((ARCH[story.category] || ARCH.geopolitics).sources.filter((s) => s !== story.source), rnd).slice(0, 3);
  const srcOpts = shuffleSeeded([story.source, ...srcPool], rnd);
  const catOpts = ["Geopolitics", "Finance", "Sports", "Technology"];
  const kickPool = shuffleSeeded(CURATED[story.category].map((s) => s.kicker).filter((k) => k !== story.kicker), rnd).slice(0, 3);
  const kickOpts = shuffleSeeded([story.kicker, ...kickPool], rnd);
  return [
    { q: "Which outlet published this story?", opts: srcOpts, correct: srcOpts.indexOf(story.source) },
    { q: "Which News30 category does it sit in?", opts: catOpts, correct: catOpts.indexOf(catLabel(story.category)) },
    { q: "Which tagline matches this story?", opts: kickOpts, correct: kickOpts.indexOf(story.kicker) },
  ];
}

/* ══════ 11 · SLIDE PANELS — one shared shell for Summary & Quiz ═════ */

function SlidePanel({ title, icon, headerExtra, footer, onClose, children }) {
  return (
    <div className="pnl" role="dialog" aria-label={title}>
      <div className="pnl-h">
        <h3><Icon name={icon} size={19} /> {title}</h3>
        {headerExtra}
        <button className="ibtn" onClick={onClose} aria-label="Close panel">
          <Icon name="x" size={20} />
        </button>
      </div>
      <div className="pnl-body">{children}</div>
      {footer && <div className="pnl-foot">{footer}</div>}
    </div>
  );
}

const SUMMARY_MODES = [
  { id: "standard", label: "Standard", icon: "fileText" },
  { id: "simple", label: "Simplify", icon: "sparkle" },
  { id: "detailed", label: "More detail", icon: "search" },
];

function SummaryPanel({ story, onClose }) {
  const [mode, setMode] = React.useState("standard");
  const [tuneOpen, setTuneOpen] = React.useState(false);
  const [regen, setRegen] = React.useState(false);
  const [thread, setThread] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const endRef = React.useRef(null);

  React.useEffect(() => {
    setMode("standard"); setThread([]); setDraft(""); setTuneOpen(false);
  }, [story.id]);

  React.useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [thread, busy]);

  const changeMode = (m) => {
    setTuneOpen(false);
    if (m === mode) return;
    setRegen(true);
    setMode(m);
    setTimeout(() => setRegen(false), 550); // instant local regenerate
  };

  const ask = async (qRaw) => {
    const q = qRaw.trim();
    if (!q || busy) return;
    setDraft("");
    const next = [...thread, { role: "user", text: q }];
    setThread(next);
    setBusy(true);
    const answer = await aiService.askStory(story, q, next); // 🔌 AI API
    setThread((t) => [...t, { role: "ai", text: answer }]);
    setBusy(false);
  };

  const s = getSummary(story, mode);
  const modeMeta = SUMMARY_MODES.find((m) => m.id === mode);

  return (
    <SlidePanel
      title="Summary"
      icon="comment"
      onClose={onClose}
      headerExtra={
        <button className="ibtn" onClick={() => setTuneOpen((o) => !o)} aria-label="Summary options">
          <Icon name="tune" size={19} />
        </button>
      }
      footer={
        <div className="ask-in">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ask(draft); }}
            placeholder="Ask AI about this story…"
            aria-label="Ask about this story"
          />
          <button className="send" onClick={() => ask(draft)} disabled={!draft.trim() || busy} aria-label="Send">
            <Icon name="send" size={16} />
          </button>
        </div>
      }
    >
      {tuneOpen && (
        <div className="tune">
          {SUMMARY_MODES.map((m) => (
            <button key={m.id} className={cls(mode === m.id && "on")} onClick={() => changeMode(m.id)}>
              <Icon name={m.icon} size={16} />
              {m.label}
              {mode === m.id && <span style={{ marginLeft: "auto", display: "flex" }}><Icon name="check" size={15} stroke={2.6} /></span>}
            </button>
          ))}
        </div>
      )}

      {regen ? (
        <div className="regen"><div className="spin" /> Regenerating {modeMeta.label.toLowerCase()} summary…</div>
      ) : (
        <React.Fragment>
          {mode !== "standard" && (
            <span className="mode-pill">
              <Icon name={modeMeta.icon} size={12} stroke={2.4} />
              {mode === "simple" ? "SIMPLIFIED" : "DETAILED"} VIEW
            </span>
          )}
          {s.intro.map((p, i) => (
            <p className="sum-p" key={i}>{p}</p>
          ))}
          <div className="sum-sec">KEY POINTS</div>
          {s.points.map((p, i) => (
            <div className="sum-li" key={i}>
              <i><Icon name="checkCircle" size={15} /></i>
              {p}
            </div>
          ))}
          <div className="sum-sec">SOURCES</div>
          {s.sources.map(([name, note]) => (
            <div className="sum-src" key={name}>
              <SourceAvatar name={name} size={28} />
              <div>
                {name}
                <small>{note}</small>
              </div>
            </div>
          ))}
        </React.Fragment>
      )}

      {(thread.length > 0 || busy) && (
        <React.Fragment>
          <div className="sum-sec">ASK ABOUT THIS STORY</div>
          <div className="chat">
            {thread.map((m, i) => (
              <div key={i} className={cls("msg", m.role === "user" ? "user" : "ai")}>{m.text}</div>
            ))}
            {busy && <div className="typing"><i /><i /><i /></div>}
          </div>
        </React.Fragment>
      )}
      <div ref={endRef} />
    </SlidePanel>
  );
}

function QuizPanel({ story, user, dispatch, onClose }) {
  const quiz = React.useMemo(() => getQuiz(story), [story.id]);
  const [qi, setQi] = React.useState(0);
  const [sel, setSel] = React.useState(null);
  const [answers, setAnswers] = React.useState([]);
  const [done, setDone] = React.useState(false);
  const awardedRef = React.useRef(false);

  React.useEffect(() => {
    setQi(0); setSel(null); setAnswers([]); setDone(false);
    awardedRef.current = false;
  }, [story.id]);

  const q = quiz[qi];
  const nCorrect = answers.filter((a) => a.correct).length;
  const points = nCorrect * POINTS_PER_CORRECT;

  const pick = (i) => {
    if (sel !== null) return;
    setSel(i);
    const correct = i === q.correct;
    track("quiz_answer", { storyId: story.id, question: qi + 1, correct }); // 🔌 per-answer event
    setAnswers((a) => [...a, { q: q.q, chosen: q.opts[i], correct }]);
    setTimeout(() => {
      if (qi + 1 < quiz.length) { setQi(qi + 1); setSel(null); }
      else setDone(true);
    }, 950);
  };

  React.useEffect(() => {
    if (!done || awardedRef.current) return;
    awardedRef.current = true;
    dispatch({
      type: "QUIZ_COMPLETE",
      result: {
        storyId: story.id,
        answers,
        points: answers.filter((a) => a.correct).length * POINTS_PER_CORRECT,
        completedAt: new Date().toISOString(), // 🔌 lands in quiz_results table
      },
    });
  }, [done]);

  const retake = () => { setQi(0); setSel(null); setAnswers([]); setDone(false); };

  return (
    <SlidePanel title="Quiz" icon="bolt" onClose={onClose}>
      {!done ? (
        <React.Fragment>
          <div className="qz-top">
            <span>Question {qi + 1} of {quiz.length}</span>
            <span className="qz-pts"><Icon name="star" size={14} filled /> {points} pts</span>
          </div>
          <div className="qz-bar"><i style={{ width: ((qi + (sel !== null ? 1 : 0)) / quiz.length) * 100 + "%" }} /></div>
          <div className="qz-q" key={qi}>{q.q}</div>
          {q.opts.map((opt, i) => {
            const state =
              sel === null ? "" : i === q.correct ? "correct" : i === sel ? "wrong" : "dim";
            return (
              <button key={i} className={cls("qz-opt", state)} disabled={sel !== null} onClick={() => pick(i)}>
                <span className="qz-letter">{"ABCD"[i]}</span>
                {opt}
              </button>
            );
          })}
          <div className="qz-fb">
            {sel !== null && (sel === q.correct ? (
              <span style={{ color: "var(--green)", display: "flex", alignItems: "center", gap: 7 }}>
                <Icon name="checkCircle" size={17} /> Correct · +{POINTS_PER_CORRECT} pts
              </span>
            ) : (
              <span style={{ color: "var(--red)", display: "flex", alignItems: "center", gap: 7 }}>
                <Icon name="x" size={17} stroke={2.6} /> Not quite — the right answer is highlighted
              </span>
            ))}
          </div>
        </React.Fragment>
      ) : (
        <div className="qz-done">
          <div className="qz-badge"><Icon name="bolt" size={30} filled /></div>
          <div className="qz-score">{nCorrect}/{quiz.length}</div>
          <div style={{ color: "var(--blue)", fontWeight: 800, fontSize: 17 }}>+{points} pts</div>
          <div className="qz-sub">
            {awardedRef.current && user
              ? "Saved to your profile — open the avatar menu to see your totals."
              : user
                ? "Practice round — points were counted on your first run."
                : "Sign in with Google to keep your points, streak and accuracy."}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <button className="btn ghost" onClick={retake}><Icon name="bolt" size={15} /> Retake</button>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </div>
      )}
    </SlidePanel>
  );
}

/* ═════ 12 · PLAYER — fullscreen vertical story player (Shorts-style) ═ */

function Player({ story, list, index, onNavIndex, onClose, user, userData, dispatch, toast }) {
  const [playing, setPlaying] = React.useState(true);
  const [progress, setProgress] = React.useState(0);
  const [panel, setPanel] = React.useState(null); // null | 'summary' | 'quiz'
  const [ppKey, setPpKey] = React.useState(0);
  const [heartKey, setHeartKey] = React.useState(0);
  const watchedRef = React.useRef({});
  const touchRef = React.useRef(null);

  React.useEffect(() => { setProgress(0); setPlaying(true); }, [story.id]);

  /* simulated playback clock — swap for real <video> timeupdate later */
  React.useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      setProgress((p) => Math.min(1, p + 0.1 / story.durationSec));
    }, 100);
    return () => clearInterval(iv);
  }, [playing, story.id, story.durationSec]);

  /* auto-advance to the next story when this one ends */
  React.useEffect(() => {
    if (progress < 1) return;
    if (index < list.length - 1) {
      const t = setTimeout(() => onNavIndex(index + 1), 350);
      return () => clearTimeout(t);
    }
    setPlaying(false);
  }, [progress, index, list.length, onNavIndex]);

  /* 🔌 VIDEO ENGAGEMENT: counts as watched at 90% */
  React.useEffect(() => {
    if (progress > 0.9 && !watchedRef.current[story.id]) {
      watchedRef.current[story.id] = true;
      dispatch({ type: "VIDEO_WATCHED", story });
    }
  }, [progress, story.id, story.category, dispatch]);

  const next = React.useCallback(() => { if (index < list.length - 1) onNavIndex(index + 1); }, [index, list.length, onNavIndex]);
  const prev = React.useCallback(() => { if (index > 0) onNavIndex(index - 1); }, [index, onNavIndex]);
  const togglePlay = () => { setPlaying((p) => !p); setPpKey((k) => k + 1); };

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); next(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); prev(); }
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); setPpKey((k) => k + 1); }
      else if (e.key === "Escape") { if (panel) setPanel(null); else onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, panel, onClose]);

  const liked = userData.engagement.likedIds.includes(story.id);
  const likeCount = Math.floor(story.views * 0.042) + (liked ? 1 : 0);
  const doLike = () => {
    if (!liked) setHeartKey((k) => k + 1);
    dispatch({ type: "LIKE_TOGGLED", storyId: story.id }); // 🔌 engagement event
  };
  const doShare = async () => {
    const url = window.location.origin + window.location.pathname + "#/story/" + story.id;
    const ok = await copyText(url);
    toast(ok ? "Link copied" : url, "share");
  };

  const onTouchStart = (e) => { touchRef.current = { y: e.touches[0].clientY, x: e.touches[0].clientX }; };
  const onTouchEnd = (e) => {
    const t = touchRef.current;
    if (!t) return;
    const dy = e.changedTouches[0].clientY - t.y;
    const dx = e.changedTouches[0].clientX - t.x;
    touchRef.current = null;
    if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx)) { if (dy < 0) next(); else prev(); }
  };

  const catIcon = (CATEGORIES.find((c) => c.id === story.category) || {}).icon || "globe";

  return (
    <div className={cls("player", panel && "panel-open")}>
      <div className="pl-close">
        <button className="ibtn" onClick={onClose} aria-label="Back to feed">
          <Icon name="arrowLeft" size={22} />
        </button>
      </div>

      <div className="pl-stage">
        <div className="pl-video" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <ThumbArt story={story} variant="video" paused={!playing} />
          <div className="pl-grad" />
          <button className="pl-tap" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} />
          <div className="pl-topline">
            <span className="pl-cat"><Icon name={catIcon} size={14} stroke={2.2} /> {catLabel(story.category)}</span>
          </div>
          {ppKey > 0 && (
            <div className="pl-pp" key={ppKey}>
              <Icon name={playing ? "play" : "pause"} size={30} filled />
            </div>
          )}
          <div className="pl-info">
            <span className="pl-kick">{story.kicker}</span>
            <div className="pl-headline">{story.headline}</div>
            <div className="pl-sub">
              <span>{story.source}</span>
              <BiasTag bias={story.bias} />
              <FactTag fact={story.fact} />
              <span className="mdot">{timeAgo(story.publishedAt)}</span>
              <span className="mdot">{fmtCount(story.views)} views</span>
            </div>
          </div>
          <div className="pl-prog"><i style={{ width: progress * 100 + "%" }} /></div>
        </div>

        <div className="pl-rail">
          <div className="rail-btn">
            <button className={cls("ibtn", liked && "liked")} onClick={doLike} aria-label="Like">
              <span key={heartKey} className={heartKey ? "heart-anim" : undefined} style={{ display: "flex" }}>
                <Icon name="heart" size={24} filled={liked} />
              </span>
            </button>
            {fmtCount(likeCount)}
          </div>
          <div className="rail-btn">
            <button className="ibtn" onClick={() => setPanel(panel === "summary" ? null : "summary")}
              style={panel === "summary" ? { background: "var(--hover)" } : null} aria-label="Summary">
              <Icon name="comment" size={23} />
            </button>
            Summary
          </div>
          <div className="rail-btn">
            <button className="ibtn" onClick={() => setPanel(panel === "quiz" ? null : "quiz")}
              style={panel === "quiz" ? { background: "var(--hover)" } : null} aria-label="Quiz">
              <Icon name="bolt" size={23} />
            </button>
            Quiz
          </div>
          <div className="rail-btn">
            <button className="ibtn" onClick={doShare} aria-label="Share">
              <Icon name="share" size={23} />
            </button>
            Share
          </div>
        </div>
      </div>

      <div className="pl-nav">
        <button className="ibtn" onClick={prev} disabled={index === 0} aria-label="Previous story">
          <Icon name="arrowUp" size={24} />
        </button>
        <button className="ibtn" onClick={next} disabled={index === list.length - 1} aria-label="Next story">
          <Icon name="arrowDown" size={24} />
        </button>
      </div>

      {panel === "summary" && <SummaryPanel story={story} onClose={() => setPanel(null)} />}
      {panel === "quiz" && <QuizPanel story={story} user={user} dispatch={dispatch} onClose={() => setPanel(null)} />}
    </div>
  );
}

/* ═══════════════════ 13 · APP ROOT — state + wiring ════════════════ */

function useViewport() {
  const [w, setW] = React.useState(typeof window !== "undefined" ? window.innerWidth : 1280);
  React.useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

const seedNotifications = () => [
  { id: "n1", storyId: "f1", title: "Fed holds rates as inflation cools to 2.4%", at: NOW - 42 * 60000, read: false },
  { id: "n2", storyId: "s1", title: "Mbappé double sends France to the semi-finals", at: NOW - 3 * 3600000, read: false },
  { id: "n3", storyId: "g3", title: "China and India agree to de-escalate border tensions", at: NOW - 9 * 3600000, read: true },
];

function App() {
  const vw = useViewport();
  const mobile = vw < 768;
  const canFull = vw >= 1100;

  const [view, setView] = React.useState("home");
  const [category, setCategory] = React.useState("all");
  const [sbFull, setSbFull] = React.useState(true);   // desktop full vs mini
  const [drawer, setDrawer] = React.useState(false);  // mobile / mid overlay

  const [user, setUser] = React.useState(null);
  const [userData, dispatch] = React.useReducer(userDataReducer, undefined, initialUserData);

  const [toasts, setToasts] = React.useState([]);
  const [notifs, setNotifs] = React.useState(seedNotifications);
  const [menu, setMenu] = React.useState(null); // 'bell' | 'profile'
  const [cardMenu, setCardMenu] = React.useState(null); // { x, y, story }
  const [googleOpen, setGoogleOpen] = React.useState(false);

  const [player, setPlayer] = React.useState(null); // { list, index }
  const [fresh, setFresh] = React.useState([]);     // breaking stories prepended to feed

  const [query, setQuery] = React.useState("");
  const [askThread, setAskThread] = React.useState([]);
  const [askBusy, setAskBusy] = React.useState(false);
  const [smpText, setSmpText] = React.useState("");
  const [smpResult, setSmpResult] = React.useState("");
  const [smpBusy, setSmpBusy] = React.useState(false);

  const toast = React.useCallback((text, icon) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  /* one-time document chrome: styles, font, favicon, title, deep-link */
  React.useEffect(() => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const font = document.createElement("link");
    font.rel = "stylesheet";
    font.href = "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;800&display=swap";
    document.head.appendChild(font);

    let fav = document.querySelector('link[rel="icon"]');
    if (!fav) { fav = document.createElement("link"); fav.rel = "icon"; document.head.appendChild(fav); }
    if (FAVICON_SRC) fav.href = FAVICON_SRC;

    const prevTitle = document.title;
    document.title = "News30 — AI news in 30 seconds";

    // 🔌 SHARE deep-link: #/story/{id} opens that story on load
    const m = window.location.hash.match(/#\/story\/([\w-]+)/);
    if (m) {
      const s = findStoryById(m[1]);
      if (s) setPlayer({ list: [s], index: 0 });
    }
    return () => { document.head.removeChild(style); document.title = prevTitle; };
  }, []);

  /* 🔌 LIVE NEWS: pull real headlines on mount via the /api/news proxy.
     `newsVersion` bumps once loaded so the feed re-renders with real
     stories; on failure everything stays on the curated samples. */
  const [newsVersion, setNewsVersion] = React.useState(0);
  React.useEffect(() => {
    newsService.load().then((ok) => {
      if (ok) { setNewsVersion(1); toast("Live headlines loaded", "flame"); }
    });
  }, [toast]);

  /* Demo of "breaking news" — a sample story posts 30s after load,
     lands top of feed + fires a notification + toast. Skipped once
     real NewsAPI headlines are live. 🔌 Real build: websocket /
     polling NEWS_API pushes into `fresh` + `notifs`.                 */
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (newsService.isLive()) return;
      const b = makeBreakingStory();
      setFresh((f) => [b, ...f]);
      setNotifs((n) => [{ id: "live-" + b.id, storyId: b.id, title: b.headline, at: b.publishedAt, read: false }, ...n]);
      toast("New story just posted", "flame");
    }, 30000);
    return () => clearTimeout(t);
  }, [toast]);

  /* 🔌 SUPABASE PERSISTENCE: debounced whole-state upsert on every
     change while signed in. Guests / unconfigured = local-only. */
  const userRef = React.useRef(null);
  userRef.current = user;
  React.useEffect(() => {
    if (!user || !db.enabled()) return;
    const t = setTimeout(() => db.saveUserData(user.email, userData), 800);
    return () => clearTimeout(t);
  }, [userData, user]);

  /* Same dispatch the UI always used, plus a mirrored row in the
     Supabase events table when signed in (fire-and-forget). */
  const dispatchTracked = React.useCallback((action) => {
    dispatch(action);
    const u = userRef.current;
    if (u && (action.type === "VIDEO_WATCHED" || action.type === "LIKE_TOGGLED" || action.type === "SAVE_TOGGLED" || action.type === "QUIZ_COMPLETE")) {
      db.logEvent(u.email, action.type, action.result || { storyId: action.storyId || (action.story && action.story.id) });
    }
  }, []);

  /* lock body scroll while the player is open */
  React.useEffect(() => {
    document.body.classList.toggle("no-scroll", !!player);
    return () => document.body.classList.remove("no-scroll");
  }, [player]);

  const unread = notifs.filter((n) => !n.read).length;

  const goNav = (id) => { setView(id); setPlayer(null); window.scrollTo(0, 0); };

  const openPlayer = React.useCallback((story, list, i) => {
    setPlayer({ list: list && list.length ? list : [story], index: i ?? 0 });
    setMenu(null); setCardMenu(null);
  }, []);

  const openFromNotif = (story) => {
    setNotifs((n) => n.map((x) => ({ ...x, read: true })));
    openPlayer(story, [story], 0);
  };

  const onMenuBtn = () => {
    if (mobile || !canFull) setDrawer((d) => !d);
    else setSbFull((f) => !f);
  };

  /* Ask AI (header submit + Ask AI page). 🔌 aiService.askNews → Gemini */
  const runAsk = async (q) => {
    setView("askai"); setPlayer(null);
    const next = [...askThread, { role: "user", text: q }];
    setAskThread(next);
    setAskBusy(true);
    const ans = await aiService.askNews(q, next);
    setAskThread((t) => [...t, { role: "ai", text: ans }]);
    setAskBusy(false);
  };
  const headerAsk = () => { const q = query.trim(); if (!q) return; setQuery(""); runAsk(q); };

  const runSimplify = async () => {
    if (!smpText.trim()) return;
    setSmpBusy(true); setSmpResult("");
    const out = await aiService.simplify(smpText.trim());
    setSmpResult(out); setSmpBusy(false);
  };

  /* card ⋮ menu */
  const onCardMenu = (e, story) => {
    const pad = 210;
    setCardMenu({ x: Math.min(e.clientX, window.innerWidth - pad), y: e.clientY, story });
  };
  const saved = userData.engagement.savedIds;
  const toggleSave = (story) => {
    const has = saved.includes(story.id);
    dispatchTracked({ type: "SAVE_TOGGLED", storyId: story.id });
    toast(has ? "Removed from Saved" : "Saved to your stories", "bookmark");
    setCardMenu(null);
  };
  const askAboutCard = (story) => {
    setCardMenu(null);
    runAsk("Tell me more about: " + story.headline);
  };

  /* 🔌 GOOGLE OAUTH via Supabase Auth — runLoginFlow is the single
     place that turns "we have a signed-in identity" (real Supabase
     session OR a picked demo account) into app state: sets `user`,
     captures the email, hydrates persisted data, and runs the login
     streak logic. handledEmailRef guards against re-firing this on
     token refreshes that Supabase's listener also reports.           */
  const handledEmailRef = React.useRef(null);
  const runLoginFlow = React.useCallback(async (u) => {
    if (handledEmailRef.current === u.email) return;
    handledEmailRef.current = u.email;
    setUser(u);
    emailService.captureEmail(u.email, u.name, "google_signin"); // 🔌 Mailchimp/Resend
    /* 🔌 SUPABASE: pull this account's persisted state first, then run
       the LOGIN streak logic on top of it. Local-only if unconfigured. */
    const saved = await db.loadUserData(u.email);
    if (saved) dispatch({ type: "HYDRATE", data: saved });
    dispatch({ type: "LOGIN" });
    db.logEvent(u.email, "LOGIN", { at: new Date().toISOString() });
    toast("Signed in as " + u.name.split(" ")[0], "check");
  }, [toast]);

  /* On mount: pick up an already-active Supabase session (e.g. after
     the OAuth redirect lands back on the page), then keep listening
     for sign-in/out events for as long as the app is open. No-op when
     Supabase isn't configured (supabaseAuth methods are safe null-ops). */
  React.useEffect(() => {
    if (!supabaseAuth.configured()) return;
    let mounted = true;
    supabaseAuth.getUser().then((supaUser) => {
      if (mounted && supaUser) runLoginFlow(buildAppUser(supaUser));
    });
    const unsub = supabaseAuth.onChange((supaUser) => {
      if (supaUser) runLoginFlow(buildAppUser(supaUser));
    });
    return () => { mounted = false; unsub(); };
  }, [runLoginFlow]);

  /* Demo-chooser path (Supabase not configured yet): GoogleModal calls
     this directly with a mock account, same shape as a real session. */
  const onGooglePick = async (acct) => {
    if (!acct) return;
    setGoogleOpen(false);
    await runLoginFlow({
      name: acct.name,
      email: acct.email,
      color: acct.color || colorForEmail(acct.email),
      picture: acct.picture || null,
    });
  };

  const signOut = async () => {
    await supabaseAuth.signOut();
    handledEmailRef.current = null;
    dispatch({ type: "RESET" }); // account data lives server-side
    setUser(null); setMenu(null); toast("Signed out", "person");
  };

  const mainCls = cls("main", !mobile && (canFull && sbFull ? "sb-full" : "sb-mini-pad"));
  const sbMode = mobile ? "hidden" : canFull && sbFull ? "full" : "mini";

  return (
    <React.Fragment>
      <Header
        onMenu={onMenuBtn}
        onBrand={() => goNav("home")}
        query={query} setQuery={setQuery} onAsk={headerAsk}
        notifCount={unread}
        onBell={() => setMenu(menu === "bell" ? null : "bell")}
        user={user}
        onProfile={() => setMenu(menu === "profile" ? null : "profile")}
      />

      <Sidebar mode={sbMode} active={view} onNav={goNav} />
      <Drawer open={drawer} active={view} onNav={goNav} onClose={() => setDrawer(false)} />
      {mobile && <BottomNav active={view} onNav={goNav} />}

      <main className={mainCls}>
        {view === "home" && (
          <HomeView category={category} setCategory={setCategory} fresh={fresh}
            feedVersion={newsVersion} openPlayer={openPlayer} onCardMenu={onCardMenu} />
        )}
        {view === "trending" && <TrendingView feedVersion={newsVersion} openPlayer={openPlayer} onCardMenu={onCardMenu} />}
        {view === "saved" && (
          <SavedView savedIds={saved} openPlayer={openPlayer} onCardMenu={onCardMenu} goHome={() => goNav("home")} />
        )}
        {view === "askai" && <AskAIView thread={askThread} busy={askBusy} onAsk={runAsk} />}
        {view === "simplify" && (
          <SimplifyView text={smpText} setText={setSmpText} result={smpResult} busy={smpBusy} onRun={runSimplify} />
        )}
      </main>

      {player && (
        <Player
          story={player.list[player.index]}
          list={player.list}
          index={player.index}
          onNavIndex={(i) => setPlayer((p) => ({ ...p, index: i }))}
          onClose={() => setPlayer(null)}
          user={user}
          userData={userData}
          dispatch={dispatchTracked}
          toast={toast}
        />
      )}

      {menu === "bell" && (
        <NotifMenu
          items={notifs}
          onOpenStory={openFromNotif}
          onMarkAll={() => setNotifs((n) => n.map((x) => ({ ...x, read: true })))}
          onClose={() => setMenu(null)}
        />
      )}
      {menu === "profile" && (
        <ProfileMenu
          user={user} data={userData}
          onGoogle={() => { setMenu(null); setGoogleOpen(true); }}
          onSignOut={signOut}
          onSaved={() => { setMenu(null); goNav("saved"); }}
          onClose={() => setMenu(null)}
        />
      )}

      {cardMenu && (
        <React.Fragment>
          <MenuScrim onClose={() => setCardMenu(null)} />
          <div className="cmenu" style={{ left: cardMenu.x, top: cardMenu.y }}>
            <button onClick={() => toggleSave(cardMenu.story)}>
              <Icon name="bookmark" size={19} filled={saved.includes(cardMenu.story.id)} />
              {saved.includes(cardMenu.story.id) ? "Remove from Saved" : "Save story"}
            </button>
            <button onClick={async () => {
              const url = window.location.origin + window.location.pathname + "#/story/" + cardMenu.story.id;
              const ok = await copyText(url); setCardMenu(null); toast(ok ? "Link copied" : url, "share");
            }}>
              <Icon name="share" size={19} /> Copy link
            </button>
            <button onClick={() => askAboutCard(cardMenu.story)}>
              <Icon name="sparkle" size={19} /> Ask AI about this
            </button>
          </div>
        </React.Fragment>
      )}

      {googleOpen && <GoogleModal onPick={onGooglePick} onClose={() => setGoogleOpen(false)} />}

      <Toasts items={toasts} />
    </React.Fragment>
  );
}

export default App;
