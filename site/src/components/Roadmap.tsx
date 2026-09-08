"use client";

import { motion } from "motion/react";

/**
 * Shipped and planned, side by side and labelled. Three things that read like
 * roadmap items are in the left column because they exist in the repository —
 * behavioural baselines, the reasoning pass, and the natural-language policy
 * compiler. Under-claiming shipped work is as misleading as over-claiming
 * unbuilt work.
 */
const SHIPPED = [
  {
    title: "Behavioural baselines",
    description:
      "Per-wallet history — typical amounts, how often it transacts, which counterparties it already knows — so an outlier is measured against that wallet, not a global rule.",
  },
  {
    title: "Fork simulation",
    description:
      "Replays the transaction against a copy of chain state and compares what actually moves with what the transaction claims to do.",
  },
  {
    title: "Natural-language policy",
    description:
      "Write the policy as a sentence and it compiles to the exact Guard configuration, with a preview in plain English before anything is activated.",
  },
  {
    title: "Auditable decision trail",
    description:
      "Every verdict is recorded with the signals behind it, and reconciled against what the chain actually enforced.",
  },
];

const PLANNED = [
  {
    title: "Pre-deployment contract scanning",
    description:
      "Static analysis of contract source before it is trusted, feeding the same risk engine.",
  },
  {
    title: "Wallets beyond Safe",
    description:
      "Tripwire attaches through Safe's Guard interface today. Other wallet standards need their own enforcement hook.",
  },
  {
    title: "Multi-signer treasury view",
    description:
      "One dashboard across several wallets, with per-signer context for teams and DAOs.",
  },
  {
    title: "Deeper XDC-native integrations",
    description:
      "Closer ties to XDC tooling and explorers as the deployment target firms up.",
  },
];

function Column({
  label,
  tone,
  items,
}: {
  label: string;
  tone: "shipped" | "planned";
  items: { title: string; description: string }[];
}) {
  return (
    <div className="divide-y divide-white/20">
      <div className="px-6 lg:px-8 py-5 flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${
            tone === "shipped" ? "bg-white" : "bg-white/30"
          }`}
        />
        <h3 className="font-mono text-xs uppercase tracking-[0.12em] text-white/60">
          {label}
        </h3>
      </div>
      {items.map((item) => (
        <div
          key={item.title}
          className="px-6 lg:px-8 py-6 hover:bg-white/5 transition duration-300"
        >
          <h4
            className={`mb-2 text-lg -tracking-[0.3px] ${
              tone === "shipped" ? "text-white" : "text-white/70"
            }`}
          >
            {item.title}
          </h4>
          <p className="text-base text-white/70">{item.description}</p>
        </div>
      ))}
    </div>
  );
}

export default function Roadmap() {
  return (
    <section className="border-y border-white/20 mb-20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="border-x border-white/20 py-10 xl:py-20 px-6 xl:px-12">
          <div className="max-w-[600px] mx-auto text-center mb-14">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="text-3xl sm:text-4xl mb-6 font-medium text-white"
            >
              What exists, and what is planned
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
              className="text-base text-white/80"
            >
              The left column is running code you can read in the repository.
              The right column is not built yet, and is listed so it is not
              mistaken for something that is.
            </motion.p>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
            className="border border-white/20"
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-white/20">
              <Column label="Implemented today" tone="shipped" items={SHIPPED} />
              <Column label="Planned — not built" tone="planned" items={PLANNED} />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
