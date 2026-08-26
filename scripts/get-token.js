// scripts/get-token.js
// 🔑 RUN THIS ONCE. Not part of the pipeline.
//
// Same job as get-refresh-token.js, but it asks for the client ID and
// secret one at a time instead of reading a JSON file. That removes the
// shell-quoting step, which is the fiddly part on a tablet keyboard —
// pasting a JSON blob between single quotes goes wrong easily and fails
// in ways that are hard to read.
//
// Run it with no arguments:
//
//   node scripts/get-token.js
//
// It asks three things in order: client ID, client secret, and then the
// authorisation code you get back from Google.
//
// The refresh token it prints is a CREDENTIAL. It goes into GitHub repo
// secrets. Not into a chat, a screenshot, or a commit.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Upload-only. Deliberately NOT the full youtube scope: this token
// should be able to add videos and nothing else, so a leak cannot be
// used to delete the channel's back catalogue.
const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

// Google still honours a localhost redirect for Desktop clients. The
// page will not load — that is the point. The code is in the URL bar.
const REDIRECT = "http://localhost:8080";

const rl = readline.createInterface({ input, output });

/* Pasting on a tablet often drags in a trailing newline or stray
   whitespace, which then silently breaks the token exchange with an
   unhelpful error. Strip it here rather than making that the user's
   problem. */
async function ask(question) {
  const answer = await rl.question(question);
  return answer.trim().replace(/\s/g, "");
}

console.log("\n─────────────────────────────────────────────");
console.log(" YouTube refresh token setup");
console.log("─────────────────────────────────────────────\n");

const clientId = await ask("1. Paste your CLIENT ID (ends .apps.googleusercontent.com):\n   ");
if (!clientId.endsWith(".apps.googleusercontent.com")) {
  console.log("\n   ⚠️  That does not look like a client ID — they normally end");
  console.log("      with .apps.googleusercontent.com. Carrying on anyway.\n");
}

const clientSecret = await ask("\n2. Paste your CLIENT SECRET (usually starts GOCSPX-):\n   ");

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    // access_type=offline is what makes Google issue a refresh token at
    // all. prompt=consent forces a fresh one even if you have authorised
    // before — without it a re-run often returns an access token only.
    access_type: "offline",
    prompt: "consent",
  }).toString();

console.log("\n─────────────────────────────────────────────");
console.log(" 3. Open this URL in a NEW browser tab:\n");
console.log(authUrl);
console.log("\n 4. Sign in as the account that owns the channel.");
console.log("    You will see an 'unverified app' warning — that is");
console.log("    expected for an app in Testing mode. Click Advanced,");
console.log("    then continue.");
console.log("\n 5. The page will fail to load. THIS IS CORRECT.");
console.log("    Look at the ADDRESS BAR. Copy everything between");
console.log("    `code=` and `&scope`. It starts with 4/");
console.log("\n    Be quick — the code expires in about a minute.");
console.log("─────────────────────────────────────────────\n");

const code = await ask("6. Paste the code here:\n   ");
rl.close();

if (!code) {
  console.error("\nNo code entered. Run the script again.\n");
  process.exit(1);
}

console.log("\nExchanging code for a refresh token...");

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code: decodeURIComponent(code),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }),
});

const data = await res.json();

if (!res.ok || !data.refresh_token) {
  console.error("\n❌ That did not work.\n");
  console.error("   Google said:", data.error || "(no error given)");
  if (data.error_description) console.error("  ", data.error_description);

  if (data.error === "invalid_grant") {
    console.error("\n   invalid_grant almost always means one of:");
    console.error("     • the code expired (it only lasts about a minute)");
    console.error("     • the code was already used once");
    console.error("     • you copied the &scope part on the end too");
    console.error("\n   Just run the script again and be quicker.");
  }
  if (data.error === "invalid_client") {
    console.error("\n   invalid_client means the client ID or secret is wrong.");
    console.error("   Check for a missing character at the start or end.");
  }
  console.error("");
  process.exit(1);
}

console.log("\n✅ Success.\n");
console.log("Copy the line below into GitHub:");
console.log("  Settings → Secrets and variables → Actions → New repository secret");
console.log("  Name it exactly: YOUTUBE_REFRESH_TOKEN\n");
console.log("─────────────────────────────────────────────");
console.log(data.refresh_token);
console.log("─────────────────────────────────────────────\n");
console.log("This token does not expire while you are listed as a test");
console.log("user on the OAuth consent screen. If you ever remove");
console.log("yourself as a test user, it dies after 7 days.\n");
