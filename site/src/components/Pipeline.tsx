"use client";

import { motion } from "motion/react";

/**
 * The product in six steps. This is the single thing a visitor should retain,
 * so it gets its own band rather than a line of small text: each stage is a
 * box, the arrows show direction, and the last stage is the only one filled —
 * because the outcome is the point.
 */
const STAGES = [
  { name: "Transaction", note: "proposed, not yet executed" },
  { name: "Monitor", note: "seen while still pending" },
  { name: "Analyze", note: "signals, simulation, context" },
  { name: "Risk score", note: "0–100, with reasons" },
  { name: "Policy", note: "the rules you set" },
  { name: "Allow / Delay / Block", note: "enforced on-chain", terminal: true },
];

export default function Pipeline() {
  return (
    <section className="border-y border-white/20 mb-20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="border-x border-white/20 px-5 py-12 lg:px-20 lg:py-16">
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="font-mono text-xs uppercase tracking-[0.12em] text-white/50 mb-10 text-center"
          >
            Every transaction takes this path
          </motion.p>

          <ol className="flex flex-col lg:flex-row lg:items-stretch gap-0">
            {STAGES.map((stage, i) => (
              <motion.li
                key={stage.name}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, ease: "easeOut", delay: i * 0.07 }}
                className="flex flex-col lg:flex-row lg:flex-1 items-stretch"
              >
                <div
                  className={`flex-1 border px-4 py-4 text-center flex flex-col justify-center ${
                    stage.terminal
                      ? "border-white/60 bg-white/10"
                      : "border-white/20 bg-white/3"
                  }`}
                >
                  <p
                    className={`text-sm font-mono uppercase tracking-[0.06em] ${
                      stage.terminal ? "text-white" : "text-white/85"
                    }`}
                  >
                    {stage.name}
                  </p>
                  <p className="text-white/45 text-xs mt-1.5">{stage.note}</p>
                </div>

                {i < STAGES.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="flex items-center justify-center text-white/30 py-2 lg:py-0 lg:px-3 shrink-0"
                  >
                    <span className="lg:hidden">&darr;</span>
                    <span className="hidden lg:inline">&rarr;</span>
                  </span>
                )}
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
