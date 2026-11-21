// /api/_gemini.js
// Shared Gemini caller for generate-audio.js (scripts) and ask-ai.js.
// The leading underscore means Vercel does NOT turn this into its own
// endpoint (and it doesn't count towards Hobby's function limit).
//
// Setup in Vercel → Settings → Environment Variables:
//   GEMINI_API_KEY = key from aistudio.google.com → "Get API key"
//                    (NO "VITE_" prefix — that ships it to the browser,
//                    which is exactly what got the old key suspended)
//   GEMINI_MODEL   = optional. Leave unset to use Google's "latest Flash"
//                    alias, which moves to new versions by itself.
//
// WHY A MODEL CHAIN: Google renames and retires model IDs often, and the
// free tier has per-model daily caps. Each call tries the models below in
// order and moves on when one is missing (404), rate-limited (429) or
// overloaded (5xx), so one retired name or one exhausted quota never
// stops the pipeline on its own.

const API = "https://generativelanguage.googleapis.com/v1beta/models/";

function modelChain() {
  const chain = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-flash-lite-latest"];
  return [...new Set(chain.filter(Boolean))];
}

// News is full of wars, crime and politics. The default filters can block
// a perfectly normal news summary, so only block what is clearly harmful.
const SAFETY = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);

export function geminiConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * @param {object} o
 * @param {string}  [o.system]     system instruction
 * @param {Array}   o.contents     [{ role: "user"|"model", text }]
 * @param {boolean} [o.json]       ask for a JSON response
 * @param {boolean} [o.search]     ground answers with Google Search
 * @param {number}  [o.maxTokens]  output cap (includes "thinking" tokens on
 *                                 newer models, so keep it generous)
 * @param {number}  [o.timeoutMs]  per-attempt timeout
 * @param {number}  [o.totalMs]    budget for ALL attempts together (Vercel
 *                                 kills functions at 60s, so this matters)
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function geminiGenerate({ system, contents, json = false, search = false, maxTokens = 4096, timeoutMs = 25000, totalMs = 45000 }) {
  const deadline = Date.now() + totalMs;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const body = {
    contents: contents.map((m) => ({
      role: m.role === "model" || m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    })),
    generationConfig: { maxOutputTokens: maxTokens },
    safetySettings: SAFETY,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = "application/json";
  if (search) body.tools = [{ google_search: {} }];

  let lastErr = null;
  for (const model of modelChain()) {
    let attemptBody = body;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 3000) throw lastErr || new Error("Gemini: out of time");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, left));
      try {
        const r = await fetch(API + encodeURIComponent(model) + ":generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(attemptBody),
          signal: ctrl.signal,
        });
        const data = await r.json().catch(() => ({}));

        if (!r.ok) {
          const msg = (data.error && data.error.message) || "";
          // Search grounding not allowed on this model/key → same model, no search.
          if (r.status === 400 && attemptBody.tools) {
            const { tools, ...rest } = attemptBody;
            attemptBody = rest;
            continue;
          }
          lastErr = new Error("Gemini " + model + " " + r.status + ": " + msg.slice(0, 160));
          console.error("[gemini]", lastErr.message);
          if (RETRYABLE.has(r.status)) break; // next model
          throw lastErr;                       // 400/401/403: config problem, stop
        }

        const cand = data.candidates && data.candidates[0];
        const text = ((cand && cand.content && cand.content.parts) || [])
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("")
          .trim();

        if (!text) {
          const why = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || "empty";
          lastErr = new Error("Gemini " + model + " returned no text (" + why + ")");
          console.error("[gemini]", lastErr.message);
          break; // next model
        }
        return { text, model };
      } catch (e) {
        if (e && e.name === "AbortError") {
          lastErr = new Error("Gemini " + model + " timed out");
          console.error("[gemini]", lastErr.message);
          break; // next model
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastErr || new Error("Gemini: no model available");
}
