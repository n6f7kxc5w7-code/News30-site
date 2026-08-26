// scripts/get-refresh-token.js
// 🔑 RUN THIS ONCE. Not part of the pipeline.
//
// Exchanges the OAuth client credentials for a refresh token, which is
// the thing GitHub Actions actually needs. Refresh tokens do not expire
// while the app stays in "Testing" WITH you listed as a test user — if
// you ever remove yourself as a test user, the token dies in 7 days.
//
// ─── WHY THIS IS A COPY-PASTE FLOW ──────────────────────────────────
// The normal desktop OAuth flow spins up a local web server on
// 127.0.0.1 and catches the redirect automatically. That needs a
// terminal and a browser on the SAME machine. On an iPad, or in a
// Codespace where the browser is somewhere else entirely, they are not
// the same machine and the redirect goes nowhere useful.
//
// So this uses the manual variant. Google redirects to
// http://localhost:8080/?code=... — that page fails to load, which is
// FINE and expected. The authorisation code is sitting in the address
// bar. Copy it from there and paste it in here.
//
// ─── HOW TO RUN IT ──────────────────────────────────────────────────
// Anywhere with Node and your client_secret JSON:
//
//   node scripts/get-refresh-token.js /path/to/client_secret_xxx.json
//
// On iPad, a GitHub Codespace on this repo gives you a browser-based
// terminal that can do this. Upload the JSON into the Codespace first.
//
// The refresh token it prints is a CREDENTIAL. It goes straight into
// GitHub repo secrets. Do not paste it into a chat, a screenshot, a
// commit, or anywhere a log could pick it up.

import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Upload-only. Deliberately NOT youtube.force-ssl or the full youtube
// scope: this token should be able to add videos and nothing else, so a
// leak cannot be used to delete the channel's back catalogue or change
// channel settings.
const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

// Google still honours a localhost redirect for Desktop clients. The
// page will not load — that is the point. The code is in the URL.
const REDIRECT = "http://localhost:8080";

const secretPath = process.argv[2];
if (!secretPath) {
  console.error("Usage: node scripts/get-refresh-token.js <client_secret.json>");
  process.exit(1);
}

let creds;
try {
  const raw = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  // Desktop clients land under `installed`; web clients under `web`.
  creds = raw.installed || raw.web;
  if (!creds || !creds.client_id || !creds.client_secret) {
    throw new Error("no client_id/client_secret found");
  }
} catch (e) {
  console.error("Could not read that client secret file:", e.message);
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    // access_type=offline is what makes Google issue a refresh token at
    // all. prompt=consent forces a fresh one even if you have authorised
    // this app before — without it a re-run often returns an access
    // token only, and you end up staring at `undefined`.
    access_type: "offline",
    prompt: "consent",
  }).toString();

console.log("\n1. Open this URL in a browser signed in as the channel owner:\n");
console.log(authUrl);
console.log(
  "\n2. Approve it. You will be told the site cannot be reached — that is expected." +
  "\n3. Copy the value of `code=` out of the ADDRESS BAR." +
  "\n   It starts with 4/ and ends before any `&scope=`.\n"
);

const rl = readline.createInterface({ input, output });
const code = (await rl.question("Paste the code here: ")).trim();
rl.close();

if (!code) {
  console.error("No code entered.");
  process.exit(1);
}

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code: decodeURIComponent(code),
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }),
});

const data = await res.json();

if (!res.ok || !data.refresh_token) {
  console.error("\nToken exchange failed:", JSON.stringify(data, null, 2));
  console.error(
    "\nIf you see invalid_grant: the code is single-use and expires in " +
    "about a minute. Re-run and be quicker, or make sure you copied the " +
    "whole code and nothing after the &."
  );
  process.exit(1);
}

console.log("\n✅ Done. Add these three as GitHub repo secrets");
console.log("   (Settings → Secrets and variables → Actions → New repository secret):\n");
console.log("   YOUTUBE_CLIENT_ID      =", creds.client_id);
console.log("   YOUTUBE_CLIENT_SECRET  =", creds.client_secret);
console.log("   YOUTUBE_REFRESH_TOKEN  =", data.refresh_token);
console.log("\nThen delete the client_secret JSON. You will not need it again.\n");
