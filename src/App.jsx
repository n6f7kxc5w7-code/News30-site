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
    // 🔌 NEWS API — LIVE ─────────────────────────────────────────────
    // With VITE_NEWSAPI_KEY set, the feed pulls real top headlines and
    // maps them onto the app's story shape (see newsService below).
    // Without it — or if the request fails — the curated sample
    // stories load instead, so the app never breaks.
    // NOTE: newsapi.org's free Developer tier only allows browser
    // requests from localhost; on a deployed domain use a paid plan or
    // proxy this call through a serverless function.
    ENDPOINT: "https://newsapi.org/v2/top-headlines",
    API_KEY: env("VITE_NEWSAPI_KEY"),
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
const LOGO_SRC = "__RESTORE_LOGO_SRC_FROM_YOUR_REPO__";
const FAVICON_SRC = "__RESTORE_FAVICON_SRC_FROM_YOUR_REPO__";

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
   🔌 With VITE_NEWSAPI_KEY set, newsService.load() pulls real top
   headlines per category and maps every article onto the exact story
   shape the whole UI already consumes — cards, player, panels, quizzes
   and deep links all work unchanged. Falls back to the curated sample
   stories whenever the key is missing or a request fails.            */

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
  enabled() { return !!CONFIG.NEWS_API.API_KEY; },
  isLive() { return LIVE.ready; },
  async load() {
    if (!this.enabled()) return false;
    try {
      const cats = Object.keys(NEWS_CATEGORY_MAP);
      const results = await Promise.all(cats.map(async (cat) => {
        const u = CONFIG.NEWS_API.ENDPOINT +
          "?category=" + NEWS_CATEGORY_MAP[cat] +
          "&language=en&pageSize=30&apiKey=" + CONFIG.NEWS_API.API_KEY;
        const r = await fetch(u);
        if (!r.ok) throw new Error("NewsAPI " + r.status);
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
  /* 🔌 SUPABASE — LIVE via PostgREST (fetch-only, no client library).
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

     Pre-alpha note: the anon key + open tables means anyone could write
     rows. Fine while testing; before launch move to Supabase Auth
     (verify the Google ID token server-side) with per-user RLS
     policies keyed on the authenticated identity.                     */
  enabled() {
    return !!(CONFIG.DATABASE.SUPABASE_URL && CONFIG.DATABASE.SUPABASE_ANON_KEY);
  },
  headers(extra) {
    return Object.assign(
      {
        "Content-Type": "application/json",
        apikey: CONFIG.DATABASE.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + CONFIG.DATABASE.SUPABASE_ANON_KEY,
      },
      extra || {}
    );
  },
  url(path) {
    return CONFIG.DATABASE.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path;
  },
  /** Fetch a user's persisted state; null when absent/disabled/failed. */
  async loadUserData(email) {
    if (!this.enabled()) return null;
    try {
      const r = await fetch(
        this.url("user_state?user_email=eq." + encodeURIComponent(email) + "&select=data"),
        { headers: this.headers() }
      );
      if (!r.ok) throw new Error("load " + r.status);
      const rows = await r.json();
      return rows.length ? rows[0].data : null;
    } catch (e) {
      track("db_load_failed", { error: String(e) });
      return null;
    }
  },
  /** Upsert the entire user state blob (called debounced from App). */
  async saveUserData(email, data) {
    if (!this.enabled()) return false;
    try {
      const r = await fetch(this.url("user_state?on_conflict=user_email"), {
        method: "POST",
        headers: this.headers({ Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify({ user_email: email, data, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) throw new Error("save " + r.status);
      return true;
    } catch (e) {
      track("db_save_failed", { error: String(e) });
      return false;
    }
  },
  /** Fire-and-forget event stream (quiz answers, watches, logins…). */
  logEvent(email, event, payload) {
    if (!this.enabled()) return;
    fetch(this.url("events"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ user_email: email || null, event, payload: payload || null }),
    }).catch(() => {});
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
  const res = await fetch(CONFIG.AI.ENDPOINT + "/" + CONFIG.AI.MODEL + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": CONFIG.AI.API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("AI request failed: " + res.status);
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
      return mockAI.news(question);
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
      return mockAI.story(story, question);
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
      return mockAI.simplify(text);
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

  /* 🔌 LIVE NEWS: pull real headlines on mount when VITE_NEWSAPI_KEY is
     set. `newsVersion` bumps once loaded so the feed re-renders with
     real stories; on failure everything stays on the curated samples. */
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
