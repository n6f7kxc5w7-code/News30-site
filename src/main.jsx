import React from "react";
import { createRoot } from "react-dom/client";
import { inject } from "@vercel/analytics";
import App, { analytics } from "./App.jsx";

/* Legacy share links were #/story/pub-<uuid>. The fragment never reaches
   the server, so hop to /story/<uuid>; api/seo.js 301s that to the
   canonical /story/<slug>-<uuid>. */
const legacy = window.location.hash.match(
  /^#\/story\/(?:pub-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
);
const rootEl = document.getElementById("root");

if (legacy) {
  window.location.replace("/story/" + legacy[1].toLowerCase());
} else if (rootEl.dataset.story && rootEl.dataset.video === "0") {
  /* Story whose video has been deleted (videos expire after 3 days): the
     server-rendered article + transcript IS the page, so don't mount the
     video feed over it. Page-view analytics still run, and the visit is
     logged so these pages' bounce rate can be measured. */
  inject();
  analytics.sessionStart();
} else {
  /* Story page with a live video: the server already rendered the story
     row and a muted, autoplaying copy of the video. Read both before
     React replaces that markup, so the player opens on the first render
     and carries on from the same second (and with sound, if the visitor
     already tapped for it) instead of flashing the feed and restarting. */
  let handoff = null;
  try {
    const json = document.getElementById("n30-story");
    if (json && rootEl.dataset.story) {
      const hero = rootEl.querySelector("video[data-n30-hero]");
      handoff = {
        row: JSON.parse(json.textContent),
        time: hero && Number.isFinite(hero.currentTime) ? hero.currentTime : 0,
        muted: hero ? hero.muted : true,
      };
      if (hero) hero.pause();
    }
  } catch (e) {
    handoff = null; // fall back to the normal deep-link fetch
  }
  createRoot(rootEl).render(
    <React.StrictMode>
      <App handoff={handoff} />
    </React.StrictMode>
  );
}
