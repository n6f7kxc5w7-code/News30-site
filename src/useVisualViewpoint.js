/* ─────────────────── useVisualViewport ──────────────────────────────

   FIXES THE iOS KEYBOARD BUG on the Ask AI input.

   THE PROBLEM. Every browser has two viewports. The LAYOUT viewport is
   what CSS sizes against — what `100vh`, `position: fixed` and
   `bottom: 0` resolve to. The VISUAL viewport is the part the user can
   actually see right now.

   On desktop and on Android they mostly agree. On iOS Safari they do
   not: when the keyboard opens, the layout viewport stays at FULL
   SCREEN HEIGHT and only the visual viewport shrinks. So an input
   pinned to `bottom: 0` is still pinned to the bottom of the whole
   screen — which is now underneath the keyboard. Safari then scrolls
   the page up to drag the focused field into view, and that scroll is
   what pushes everything else out of place. The strip of page content
   visible between the input and the keyboard is exactly that offset.

   THIS IS NOT A DEVICE-DETECTION PROBLEM. Sniffing the user agent means
   maintaining a list of devices forever and getting it wrong on the
   next one. The browser already exposes the real answer through
   window.visualViewport; the fix is to read it rather than guess.

   WHAT THIS RETURNS. `keyboardOffset`: how many pixels of the layout
   viewport are currently covered by the keyboard. Zero when it's
   closed. Apply it as `bottom` on whatever is pinned to the bottom and
   it sits on top of the keyboard instead of underneath it.

   Safari fires resize and scroll on visualViewport many times per
   second while the keyboard animates, so the work here is deliberately
   tiny — one subtraction and a state write — and rAF-throttled so React
   re-renders at most once per frame.
*/

import { useState, useEffect } from "react";

export function useVisualViewport() {
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    // Not supported (older browsers, some in-app webviews). Returning 0
    // leaves the layout exactly as it behaves today rather than breaking
    // it differently.
    if (!vv) return;

    let frame = null;

    const update = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;

        /* How much of the layout viewport is hidden.

           innerHeight is the layout viewport. vv.height is what's
           visible. vv.offsetTop is how far Safari has scrolled the
           visual viewport within the layout one — it is non-zero when
           Safari shoves the page up to reveal a focused field, and
           leaving it out is what makes the input drift as you type.

           Clamped at zero because the value goes slightly negative
           while the URL bar collapses on scroll, which would otherwise
           lift the input off the bottom of the screen for no reason. */
        const hidden = window.innerHeight - vv.height - vv.offsetTop;
        setKeyboardOffset(Math.max(0, Math.round(hidden)));
      });
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return { keyboardOffset, keyboardOpen: keyboardOffset > 0 };
}
