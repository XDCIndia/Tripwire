"use client";

import * as React from "react";

/**
 * Tracks whether the window has been scrolled past `threshold` pixels.
 *
 * Not part of the pasted snippet — `header-2.tsx` imports it, so it is
 * reconstructed here. Reads once on mount so a page restored mid-scroll starts
 * in the correct state, and listens passively to avoid blocking scrolling.
 */
export function useScroll(threshold = 0) {
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  return scrolled;
}
