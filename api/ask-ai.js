// /api/ask-ai.js
// 🔌 AI SERVER PROXY — runs on Vercel's servers, never in the browser.
//
// Switched to DeepSeek after Gemini's suspension went unanswered for
// over a week, and after Claude's per-token cost proved too high for
// this project's £50/month ceiling. DeepSeek's API is OpenAI-compatible
// (same request/response shape as OpenAI's chat completions), which is
// why this rewrite is a smaller diff than the Gemini→Claude one was.
//
// ⚠️ KNOWN LIMITATION: DeepSeek has no hosted web-search tool the way
// Gemini (google_search) and Claude (web_search_20250305) do. The
// `useWebSearch` flag from the frontend is accepted but currently a
// no-op — answers come from the model's training data only, not live
// results. "Ask AI" questions about breaking news will be less current
// than before. If that turns out to matter, the fix is pairing this
// with a separate cheap search API (e.g. Brave Search, Tavily) rather
// than switching providers again.
//
// The wire contract with the frontend is UNCHANGED — App.jsx still
// sends { system, messages, useWebSearch } with messages shaped as
// { role: "user"|"model", parts: [{ text }] } (the Gemini shape it was
// already using). That shape is translated to OpenAI-style { role,
// content } internally, so App.jsx never needs to change.
//
// Setup in Vercel → Settings → Environment Variables:
//   DEEPSEEK_API_KEY = your real key from platform.deepseek.com
//   (NO "VITE_" prefix — that ships it to the browser bundle, which is
//   the exact mistake that got the original Gemini key suspended.)
//
// Frontend contract (unchanged):
//   POST /api/ask-ai   body: { system, messages, useWebSearch, model? }
//   → { text: "..." } on success, { error: "..." } on failure.

import { enforceRateLimit } from "./_rate-limit.js";

const DEFAULT_MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MAX_TOKENS = 1000;

// Models the client is permitted to request. deepseek-reasoner does
// chain-of-thought and costs more per token — allowed, but never the
// default, since Ask AI's questions don't need heavy reasoning.
const ALLOWED_MODELS = ["deepseek-chat", "deepseek-reasoner"];

const ALLOWED_ORIGINS = [
  "https://news30.live",
  "https://www.news30.live",
  "http://localhost:5173",
];

// Frontend sends Gemini-shaped history: { role: "user"|"model", parts:
// [{ text }] }. OpenAI-compatible APIs want { role: "user"|"assistant",
// content: "..." }. Translating here means App.jsx never has to change.
function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of Array.isArray(messages) ? messages : []) {
    const text = Array.isArray(m.parts)
      ? m.parts.map((p) => p.text || "").join("")
      : (m.text || "");
    if (!text.trim()) continue;
    out.push({
      role: m.role === "model" || m.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }
  return out;
}

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

  // 30 questions per IP per hour. Someone reading and asking follow-ups
  // will never come close; a script hits it in seconds. The pipeline
  // worker bypasses this via x-pipeline-secret — see _rate-limit.js.
  if (!(await enforceRateLimit(req, res, "ask-ai", 30, 60))) return;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("[ask-ai] DEEPSEEK_API_KEY is not set in the environment");
    res.status(500).json({ error: "AI service unavailable" });
    return;
  }

  const { system, messages, model } = req.body || {};
  // useWebSearch is destructured but intentionally unused — see the
  // limitation note at the top of this file.

  const chatMessages = toOpenAIMessages(system, messages);
  if (chatMessages.filter((m) => m.role !== "system").length === 0) {
    res.status(400).json({ error: "messages is required" });
    return;
  }

  const useModel = ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;

  try {
    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey, // header, never a query string
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: MAX_TOKENS,
        messages: chatMessages,
      }),
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      // Full detail to Vercel logs only. Upstream error payloads can
      // include request context; never forward that to the browser.
      console.error("[ask-ai] upstream error", upstream.status, JSON.stringify(data));
      res.status(upstream.status).json({
        error: "AI request failed (" + upstream.status + ")",
      });
      return;
    }

    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();

    if (!text) {
      console.error("[ask-ai] empty response from model", JSON.stringify(data));
      res.status(502).json({ error: "Empty AI response" });
      return;
    }

    res.status(200).json({ text });
  } catch (e) {
    // String(e) on a fetch failure can contain the request URL — log
    // only, never return to the client.
    console.error("[ask-ai] request threw:", e);
    res.status(500).json({ error: "AI request failed" });
  }
}
