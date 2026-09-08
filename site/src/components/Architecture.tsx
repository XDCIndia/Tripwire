"use client";

import { useRef, useSyncExternalStore } from "react";
import type { MotionValue } from "motion/react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";

/**
 * The path a transaction takes, top to bottom. Each stage names what it is and
 * where it runs, because the off-chain/on-chain boundary is the part that
 * decides whether any of this is enforceable.
 */
const STAGES = [
  {
    name: "Wallet",
    note: "A Safe with the Guard enabled",
    where: "on-chain",
  },
  {
    name: "Transaction monitor",
    note: "Sees the transaction while it is still pending",
    where: "off-chain",
  },
  {
    name: "Risk engine",
    note: "Rules, fork simulation, and a reasoning pass",
    where: "off-chain",
  },
  {
    name: "Risk Registry",
    note: "The verdict, written where the Guard can read it",
    where: "on-chain",
  },
  {
    name: "Tripwire Guard",
    note: "Checks the verdict and the limits at execution",
    where: "on-chain",
  },
  {
    name: "Allow / Delay / Block",
    note: "The outcome the owner configured",
    where: "on-chain",
  },
  {
    name: "Blockchain",
    note: "Only what survived the Guard settles",
    where: "on-chain",
  },
];

/** A store that never emits: `useSyncExternalStore` only needs the snapshots. */
const NEVER_CHANGES = () => () => {};

/**
 * One stage, revealed by scroll position rather than by a timer.
 *
 * Each stage owns a slice of the section's scroll progress, so they arrive in
 * order as the reader moves down and retreat again on the way back up — the
 * diagram is drawn by scrolling it, which is the point: a transaction moving
 * through the stages is exactly what the reader is doing.
 *
 * The reveal is a `useTransform` off a shared progress value rather than
 * GSAP ScrollTrigger. Same scrubbed behaviour, and the page already ships
 * `motion` for every other animation, so it costs nothing to add.
 *
 * `animate` gates the whole thing, and it is false until after mount. The
 * markup therefore ships *revealed*, and the animation only ever subtracts
 * from a diagram that is already readable — which is what keeps it visible
 * with JavaScript off, and under reduced motion. Applying the hidden state
 * during SSR instead put `opacity: 0` in the server HTML, and React's
 * hydration trusts server markup rather than patching attributes against it,
 * so the diagram stayed invisible.
 */
function Stage({
  stage,
  index,
  total,
  progress,
  animate,
  isLast,
}: {
  stage: (typeof STAGES)[number];
  index: number;
  total: number;
  progress: MotionValue<number>;
  animate: boolean;
  isLast: boolean;
}) {
  // Windows overlap, so the next stage starts arriving before the previous one
  // has settled. Without the overlap the stack reads as a series of jumps.
  const step = 0.78 / total;
  const start = index * step;
  const end = start + step * 2.4;

  const opacity = useTransform(progress, [start, end], [0, 1]);
  const y = useTransform(progress, [start, end], [26, 0]);
  const dotScale = useTransform(progress, [start, end], [0.35, 1]);
  const borderColor = useTransform(
    progress,
    [start, end],
    ["rgba(255,255,255,0.08)", "rgba(255,255,255,0.28)"],
  );
  const onChain = stage.where === "on-chain";

  return (
    <li className="relative">
      {/* The node on the rail. Filled for on-chain, hollow for off — the
          trust boundary, encoded in the diagram rather than only in the tag. */}
      <motion.span
        aria-hidden="true"
        style={animate ? { scale: dotScale, opacity } : undefined}
        className={`absolute -left-10 top-[1.35rem] size-[15px] rounded-full border ${
          onChain ? "border-white bg-white" : "border-white/70 bg-theme-dark"
        }`}
      />

      <motion.div
        style={animate ? { opacity, y, borderColor } : undefined}
        className="border border-white/20 bg-white/3 px-5 py-4 flex items-baseline justify-between gap-4"
      >
        <div>
          <p className="text-white text-lg -tracking-[0.3px]">{stage.name}</p>
          <p className="text-white/60 text-sm">{stage.note}</p>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/45 shrink-0">
          {stage.where}
        </span>
      </motion.div>

      {!isLast && (
        <motion.div
          aria-hidden="true"
          style={animate ? { opacity } : undefined}
          className="flex justify-center py-2 text-white/30"
        >
          &darr;
        </motion.div>
      )}
    </li>
  );
}

export default function Architecture() {
  const stackRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;

  // False through SSR and the hydration pass, true afterwards, so the diagram
  // is in the markup fully drawn and the scroll reveal is switched on only
  // once the client has taken over -- and only when motion is welcome.
  const mounted = useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false,
  );
  const animate = mounted && !reduced;

  // Progress runs from the stack entering the bottom of the viewport to its
  // last stage reaching the middle. Stretched deliberately: a shorter window
  // finished the reveal while there was still half the diagram left to scroll,
  // which is the opposite of the effect — the drawing should last as long as
  // the reading does.
  const { scrollYProgress } = useScroll({
    target: stackRef,
    offset: ["start 0.95", "end 0.5"],
  });

  // The rail leads the cards slightly, so the line arrives at a stage a moment
  // before the stage itself does.
  const railFill = useTransform(scrollYProgress, [0, 0.92], [0, 1]);

  return (
    <section id="architecture" className="border-y border-white/20 mb-20 scroll-mt-24">
      <div className="max-w-7xl mx-auto px-6">
        <div className="border-x border-white/20 p-5 lg:p-20">
          <div className="lg:max-w-2xl mb-14">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="text-3xl sm:text-4xl mb-6 font-medium text-white"
            >
              How a transaction moves
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
              className="text-base text-white/80"
            >
              A Safe transaction is not instant. It is proposed, it waits for
              signatures, and only then does anyone execute it. That pause is
              where the risk engine does its work &mdash; so the Guard never has
              to make an off-chain call mid-transaction.
            </motion.p>
          </div>

          <div ref={stackRef} className="relative max-w-2xl mx-auto">
            {/* The rail the transaction travels down: an unlit track, and the
                lit line that fills as the reader scrolls. */}
            <div
              aria-hidden="true"
              className="absolute left-[7px] top-6 bottom-6 w-px bg-white/12"
            />
            <motion.div
              aria-hidden="true"
              style={animate ? { scaleY: railFill } : undefined}
              className="absolute left-[7px] top-6 bottom-6 w-px origin-top bg-white/70"
            />

            <ol className="pl-10">
              {STAGES.map((stage, i) => (
                <Stage
                  key={stage.name}
                  stage={stage}
                  index={i}
                  total={STAGES.length}
                  progress={scrollYProgress}
                  animate={animate}
                  isLast={i === STAGES.length - 1}
                />
              ))}
            </ol>
          </div>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
            className="text-sm text-white/50 mt-10 max-w-2xl mx-auto text-center"
          >
            The spending limits are enforced by the Guard independently of any
            verdict, so they still hold if the off-chain engine is offline.
          </motion.p>
        </div>
      </div>
    </section>
  );
}
