// /api/_rate-limit.js
// 🔒 SHARED RATE LIMITER — protects the paid endpoints from being
// scripted. Imported by ask-ai.js, generate-audio.js and
// generate-video.js.
//
// WHY THIS EXISTS: /api/ask-ai is a public endpoint that spends money
// on every call. A single Gemini call costs a fraction of a penny, so
// no human will run up a bill by hand — but a loop hitting the
// endpoint a few thousand times will, and there is nothing stopping
// anyone from writing one. CORS restricts *browsers* on other origins;
// it does nothing about curl.
//
// The counter lives in Supabase rather than in memory because Vercel
// functions are stateless: each invocation may be a brand new process,
// so an in-memory counter would reset constantly and enforce nothing.
//
// Requires the rate_limits table — see rate-limits-table.sql.

import { createClient } from "@supabase/supabase-js";

// Identify the caller. Vercel populates x-forwarded-for; the first
// entry is the real client IP, the rest are proxy hops.
//
// Honest limitation: IP is imperfect. Users behind the same office or
// school NAT share a limit, and anyone determined can rotate IPs. It
// is a speed bump against casual abuse and runaway loops, not a wall
// against a motivated attacker. Tightening this properly means
// requiring a signed-in user and limiting per auth.uid().
export function callerKey(req) {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (typeof fwd === "string" ? fwd.split(",")[0] : "").trim();
  return ip || req.headers["x-real-ip"] || "unknown";
}

/**
 * Checks and increments a counter.
 *
 * @param {string} bucket     e.g. "ask-ai" — separate budgets per endpoint
 * @param {string} key        caller identity, from callerKey(req)
 * @param {number} limit      max requests allowed in the window
 * @param {number} windowMins length of the window in minutes
 * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number }}
 *
 * Fails OPEN. If Supabase is unreachable, requests are allowed through
 * rather than blocked. That is a deliberate trade: a database blip
 * should degrade into "unprotected" rather than "site is down". The
 * risk it accepts is that an outage briefly removes the cap, which is
 * why PIPELINE_ENABLED exists as a manual hard stop.
 */
export async function checkRateLimit(bucket, key, limit, windowMins) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("[rate-limit] not configured — allowing request");
    return { allowed: true, remaining: limit, retryAfterSec: 0 };
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Bucketing the window into the key means expiry is automatic: a new
  // window produces a new key with a fresh count, so there is no reset
  // logic to get wrong and no race on clearing counters.
  const windowMs = windowMins * 60 * 1000;
  const windowId = Math.floor(Date.now() / windowMs);
  const rowKey = bucket + ":" + key + ":" + windowId;

  try {
    const { data: existing } = await supabase
      .from("rate_limits")
      .select("count")
      .eq("key", rowKey)
      .maybeSingle();

    const current = existing ? existing.count : 0;

    if (current >= limit) {
      const nextWindowMs = (windowId + 1) * windowMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((nextWindowMs - Date.now()) / 1000)),
      };
    }

    await supabase
      .from("rate_limits")
      .upsert(
        { key: rowKey, count: current + 1, window_start: new Date().toISOString() },
        { onConflict: "key" }
      );

    return { allowed: true, remaining: limit - current - 1, retryAfterSec: 0 };
  } catch (e) {
    console.error("[rate-limit] check failed — allowing request:", e);
    return { allowed: true, remaining: limit, retryAfterSec: 0 };
  }
}

/**
 * Convenience wrapper. Applies the limit and writes the 429 response
 * itself if the caller is over. Returns true when the request should
 * proceed.
 */
export async function enforceRateLimit(req, res, bucket, limit, windowMins) {
  // The cron worker legitimately fires nine renders in a few minutes,
  // which is exactly the pattern this limiter exists to block. It
  // authenticates with CRON_SECRET, so it is exempt.
  //
  // Note this is a shared secret, not per-user auth: anyone holding
  // CRON_SECRET can bypass every limit here. It lives only in Vercel's
  // environment variables and must never reach client code.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["x-pipeline-secret"] === secret) {
    return true;
  }

  const key = callerKey(req);
  const result = await checkRateLimit(bucket, key, limit, windowMins);

  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));

  if (!result.allowed) {
    console.warn("[rate-limit] blocked", bucket, key);
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({
      error: "Too many requests. Please wait a moment and try again.",
      retryAfter: result.retryAfterSec,
    });
    return false;
  }

  return true;
}
