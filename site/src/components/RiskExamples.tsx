"use client";

import { motion } from "motion/react";

type Example = {
  transaction: string;
  detail: string;
  signals: string[];
  score: number;
  level: "HIGH" | "CRITICAL";
  action: string;
  outcome: string;
};

const EXAMPLES: Example[] = [
  {
    transaction: "$25,000",
    detail: "to a new counterparty",
    signals: [
      "Recipient never used by this wallet before",
      "Amount far above this wallet's usual spend",
      "Target contract deployed recently",
      "Calls a function that grants standing permission",
    ],
    score: 87,
    level: "HIGH",
    action: "Transaction delayed for review",
    outcome:
      "It sits in a cooling-off window instead of executing. The engine can still escalate it to blocked before the window ends.",
  },
  {
    transaction: "setApprovalForAll",
    detail: "to an unverified contract",
    signals: [
      "Grants control of an entire token collection",
      "Contract has no verified source",
      "Counterparty appears on a scam-address feed",
      "Simulation shows an allowance change the transaction does not describe",
    ],
    score: 96,
    level: "CRITICAL",
    action: "Transaction blocked",
    outcome:
      "The Guard reverts it at execution. Retrying does nothing while the verdict stands.",
  },
];

function ScoreBar({ score, level }: { score: number; level: Example["level"] }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="font-mono text-xs uppercase tracking-[0.12em] text-white/50">
          Risk
        </span>
        <span className="font-mono text-sm text-white">{level}</span>
        <span className="text-white/40 text-sm">&mdash;</span>
        <span className="text-white text-2xl font-medium tabular-nums">
          {score}
        </span>
        <span className="text-white/50 text-sm">/100</span>
      </div>
      <div
        className="h-1 w-full bg-white/10"
        role="img"
        aria-label={`Risk score ${score} out of 100`}
      >
        <div
          className={`h-full ${level === "CRITICAL" ? "bg-white" : "bg-white/60"}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

function ExampleCard({ example, index }: { example: Example; index: number }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, ease: "easeOut", delay: index * 0.1 }}
      className="border border-white/20 bg-white/3 p-6 lg:p-8 flex flex-col gap-7"
    >
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-white/50 mb-3">
          Transaction
        </p>
        <p className="text-white text-2xl -tracking-[0.5px] break-words">
          {example.transaction}
        </p>
        <p className="text-white/60 text-base">{example.detail}</p>
      </div>

      <div>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-white/50 mb-3">
          Risk signals
        </p>
        <ul className="space-y-2">
          {example.signals.map((signal) => (
            <li key={signal} className="text-white/80 text-base flex gap-3">
              <span
                aria-hidden="true"
                className="mt-2.5 h-px w-3 bg-white/30 shrink-0"
              />
              {signal}
            </li>
          ))}
        </ul>
      </div>

      <ScoreBar score={example.score} level={example.level} />

      <div className="border-t border-white/15 pt-6 mt-auto">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-white/50 mb-2">
          Action
        </p>
        <p className="text-white text-lg mb-2">{example.action}</p>
        <p className="text-white/60 text-sm">{example.outcome}</p>
      </div>
    </motion.article>
  );
}

export default function RiskExamples() {
  return (
    <section className="border-y border-white/20 mb-20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="border-x border-white/20 p-5 lg:p-20">
          <div className="lg:max-w-2xl mb-12">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="text-3xl sm:text-4xl mb-6 font-medium text-white"
            >
              What a decision looks like
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
              className="text-base text-white/80"
            >
              Every verdict carries the signals behind it, so a delay or a block
              can be understood and argued with rather than simply obeyed.
            </motion.p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {EXAMPLES.map((example, i) => (
              <ExampleCard key={example.transaction} example={example} index={i} />
            ))}
          </div>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
            className="font-mono text-xs uppercase tracking-[0.12em] text-white/40 mt-8"
          >
            Illustrative examples &mdash; not generated from live data
          </motion.p>
        </div>
      </div>
    </section>
  );
}
