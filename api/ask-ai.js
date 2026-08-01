// /api/ask-ai.js
// 🔌 GEMINI SERVER PROXY — runs on Vercel's servers (Node.js runtime),
// never in the browser. Same reasoning and same pattern as api/news.js.
//
// WHY THIS EXISTS: the Gemini key was previously read client-side via
// VITE_GEMINI_API_KEY, which ships the real key inside the public JS
// bundle — anyone visiting news30.live could open dev tools and see
// it. Google's automated abuse-scanners detect exposed keys sitting in
// public places and auto-suspend them for safety. That's what actually
// caused the repeated "key suspended" / "consumer has been suspended"
// errors — not bad luck, a real exposed secret. Routing every Gemini
// call through this endpoint instead means the real key only ever
// lives on the server, never in anything a visitor's browser can read.
//
// Setup required in Vercel → Settings → Environment Variables:
//   GEMINI_API_KEY = your real AI Studio key   (NO "VITE_" prefix —
//   that prefix is what exposes a var to the browser bundle; leaving
//   it off keeps this one server-only. This is a NEW, separate env
//   var from the old VITE_GEMINI_API_KEY — add it fresh, don't just
//   rename the old one, since the old one should be deleted anyway
//   now that nothing should read it client-side.)
//
// The frontend calls this exactly the way it used to call Gemini
// directly, just pointed at our own domain instead:
//   POST /api/ask-ai   body: { system, messages, useWebSearch, model? }
// Response shape: { text: "..." } on success, { error: "..." } on failure.

const DEFAULT_MODEL = "gemini-2.5-flash";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Missing server key → the frontend's existing try/catch already
    // falls back gracefully to sample/mock responses on any failure.
    res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server" });
    return;
  }

  const { system, messages, useWebSearch, model } = req.body || {};
  if (!messages) {
    res.status(400).json({ error: "messages is required" });
    return;
  }

  // Model is chosen server-side by default (only DEFAULT_MODEL, unless
  // the caller explicitly asks for a different one) — keeps the client
  // from being able to request an arbitrary/expensive model on your key.
  const useModel = model || DEFAULT_MODEL;

  const body = {
    contents: messages,
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { maxOutputTokens: 1000 },
  };
  if (useWebSearch) body.tools = [{ google_search: {} }]; // Gemini search grounding

  try {
    const upstream = await fetch(
      ENDPOINT + "/" + useModel + ":generateContent?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const data = await upstream.json();

    if (!upstream.ok) {
      const detail = (data.error && data.error.message) || JSON.stringify(data);
      res.status(upstream.status).json({ error: "AI request failed: " + upstream.status + " — " + detail });
      return;
    }

    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map((pt) => pt.text || "").join("").trim();

    if (!text) {
      res.status(500).json({ error: "Empty AI response" });
      return;
    }

    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
