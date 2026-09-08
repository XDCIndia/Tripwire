"use client";

import { motion } from "motion/react";

/**
 * The division of authority, stated plainly. This matters more than any feature
 * claim: a model that could move funds would be a liability, so the page says
 * exactly where the model's authority ends.
 */
const SPLIT = [
  {
    label: "What the model does",
    items: [
      "Reads the transaction in context — what the contract is, how old it is, who the recipient is",
      "Weighs signals a fixed rule cannot: an unlimited approval to a known exchange is routine, the same call to a contract deployed an hour ago is not",
      "Writes the plain-English reason attached to the decision",
    ],
  },
  {
    label: "What the model cannot do",
    items: [
      "Move funds, or approve a transaction on its own",
      "Override a spending limit, a delay, or a freeze",
      "Block the pipeline — if it is slow or unavailable, the deterministic verdict stands unchanged",
    ],
  },
];

export default function AiSection() {
  return (
    <section className="border-y border-white/20 mb-20">
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
              AI explains the risk. Smart contracts enforce the policy.
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
              className="text-base text-white/80"
            >
              A language model is good at judging context and bad at being
              trusted with money. Tripwire uses it for the first and never the
              second: the deterministic rules and the on-chain Guard make every
              decision that touches funds.
            </motion.p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 border border-white/20 divide-y lg:divide-y-0 lg:divide-x divide-white/20">
            {SPLIT.map((column, i) => (
              <motion.div
                key={column.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut", delay: i * 0.1 }}
                className="p-6 lg:p-10"
              >
                <h3 className="font-mono text-xs uppercase tracking-[0.12em] text-white/50 mb-6">
                  {column.label}
                </h3>
                <ul className="space-y-4">
                  {column.items.map((item) => (
                    <li
                      key={item}
                      className="text-base text-white/80 flex gap-3"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-2.5 h-px w-4 bg-white/30 shrink-0"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
            className="text-sm text-white/50 mt-8 max-w-3xl"
          >
            The Guard fails closed: a transaction with no recorded verdict is
            blocked, never allowed. That property holds whether or not any model
            was reachable.
          </motion.p>
        </div>
      </div>
    </section>
  );
}
