// /api/ask-ai.js
// 🔌 GEMINI SERVER PROXY — runs on Vercel's servers (Node.js runtime),
// never in the browser.
//
// WHY THIS EXISTS: the Gemini key was previously read client-side via
// VITE_GEMINI_API_KEY, which ships the real key inside the public JS
// bundle — anyone visiting news30.live could open dev tools and read
// it. Google's abuse scanners found it, a third party used it, and the
// project got suspended. Routing every Gemini call through this
// endpoint means the real key only ever lives on the server.
//
// SECURITY RULES ENFORCED HERE:
//   1. Key read from process.env only — never a VITE_ var, never hardcoded.
//   2. Key sent as a header, not a ?key= query string (query strings end
//      up in logs, error traces, and proxy records).
//   3. Upstream error details are logged server-side but NEVER forwarded
//      to the browser — Google's error payloads can echo the request URL
//      back, which would leak the key to any visitor who triggers an error.
//   4. CORS locked to our own origins, so other sites can't burn our quota.
//
// Setup in Vercel → Settings → Environment Variables:
//   GEMINI_API_KEY = your real AI Studio key   (NO "VITE_" prefix)
// Delete the old VITE_GEMINI_API_KEY var entirely — nothing reads it now.
//
// Frontend contract (unchanged):
//   POST /api/ask-ai   body: { system, messages, useWebSearch, model? }
//   → { text: "..." } on success, { error: "..." } on failure.

// Gemini 2.0 Flash and 2.0 Flash-Lite were shut down on 1 June 2026 and
// now return 404 — do not put them back. 2.5 Flash-Lite is Google's
// recommended replacement and the cheapest capable option, which suits
// the short summaries and answers this endpoint produces.
// Model retirements have broken this project twice now; worth checking
// https://ai.google.dev/gemini-api/docs/models periodically rather than
// finding out through a 404 in production.
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Only these origins may call this endpoint. Add Vercel preview URLs here
// if you test against them; keep the list tight otherwise.
const ALLOWED_ORIGINS = [
  "https://news30.live",
  "https://www.news30.live",
  "http://localhost:5173", // Vite dev server
];

// Models the client is permitted to request. Prevents someone pointing an
// arbitrary/expensive model at your key via the optional `model` field.
const ALLOWED_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[ask-ai] GEMINI_API_KEY is not set in the environment");
    // Generic message — never hint at key material or config specifics.
    res.status(500).json({ error: "AI service unavailable" });
    return;
  }

  const { system, messages, useWebSearch, model } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages is required" });
    return;
  }

  // Allowlist check — unknown models silently fall back to the default
  // rather than being passed through to Google.
  const useModel = ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;

  const body = {
    contents: messages,
    generationConfig: { maxOutputTokens: 1000 },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (useWebSearch) {
    body.tools = [{ google_search: {} }];
  }

  try {
    const upstream = await fetch(
      ENDPOINT + "/" + useModel + ":generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Key travels in a header, never in the URL.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      // Full detail goes to Vercel logs only — you can read it there.
      console.error(
        "[ask-ai] upstream error",
        upstream.status,
        JSON.stringify(data)
      );
      // Client gets the status code and nothing else.
      res.status(upstream.status).json({
        error: "AI request failed (" + upstream.status + ")",
      });
      return;
    }

    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map((pt) => pt.text || "").join("").trim();

    if (!text) {
      console.error("[ask-ai] empty response from model", JSON.stringify(data));
      res.status(502).json({ error: "Empty AI response" });
      return;
    }

    res.status(200).json({ text });
  } catch (e) {
    // String(e) on a fetch failure can contain the full request URL.
    // Log it, never send it.
    console.error("[ask-ai] request threw:", e);
    res.status(500).json({ error: "AI request failed" });
  }
}
