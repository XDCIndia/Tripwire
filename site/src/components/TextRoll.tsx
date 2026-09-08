"use client";

import { motion } from "motion/react";

/**
 * The label treatment on every CTA in the original template: two stacked copies
 * of the text, the visible one sliding out the top while a duplicate rises into
 * its place on hover.
 *
 * Drives off variants, so the parent owns the trigger — it must set
 * `initial="initial"`, `whileHover="hover"` and clip with `overflow-hidden`.
 */

const OUTGOING = { initial: { y: 0 }, hover: { y: "-100%" } };
const INCOMING = { initial: { y: "100%" }, hover: { y: 0 } };
const TRANSITION = { duration: 0.3, ease: "easeInOut" } as const;

export default function TextRoll({ children }: { children: React.ReactNode }) {
  return (
    <span className="block relative h-full w-full overflow-hidden">
      <motion.span
        className="flex h-full w-full items-center justify-center"
        variants={OUTGOING}
        transition={TRANSITION}
      >
        {children}
      </motion.span>
      {/* Hidden from assistive tech so the label is not announced twice. */}
      <motion.span
        aria-hidden="true"
        className="absolute top-0 left-0 w-full h-full flex items-center justify-center"
        variants={INCOMING}
        transition={TRANSITION}
      >
        {children}
      </motion.span>
    </span>
  );
}
