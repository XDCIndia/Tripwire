"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Hamburger that morphs into a close cross.
 *
 * Not part of the pasted snippet — `header-2.tsx` imports it, so it is
 * reconstructed here to match the call site: `open` drives the shape and
 * `duration` (ms) the transition.
 *
 * Each bar is translated onto the centre line first and then rotated about the
 * viewBox centre, so the two strokes meet cleanly rather than crossing off-axis.
 */
export function MenuToggleIcon({
  open = false,
  duration = 300,
  className,
  ...props
}: React.ComponentProps<"svg"> & { open?: boolean; duration?: number }) {
  const bar: React.CSSProperties = {
    transformBox: "view-box",
    transformOrigin: "center",
    transition: `transform ${duration}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path
        d="M4 7h16"
        style={{
          ...bar,
          transform: open ? "rotate(45deg) translateY(5px)" : "none",
        }}
      />
      <path
        d="M4 12h16"
        style={{
          ...bar,
          opacity: open ? 0 : 1,
          transform: open ? "scaleX(0.4)" : "none",
        }}
      />
      <path
        d="M4 17h16"
        style={{
          ...bar,
          transform: open ? "rotate(-45deg) translateY(-5px)" : "none",
        }}
      />
    </svg>
  );
}
