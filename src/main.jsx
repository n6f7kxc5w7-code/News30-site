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
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
