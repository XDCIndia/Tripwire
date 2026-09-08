"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const FAQS = [
  {
    question: "What is Tripwire?",
    answer:
      "A security layer for wallets that hold real money. It watches transactions as they are proposed, scores them for risk, and enforces the protection you configured — a spending limit, a cooling-off delay, or a freeze — at the smart-contract layer, before funds move.",
  },
  {
    question: "How is this different from a wallet warning?",
    answer:
      "A warning can be clicked through. Tripwire runs as a Guard on the wallet itself, so when it says no the transaction reverts on-chain. The decision is not advisory.",
  },
  {
    question: "What happens if your backend goes down?",
    answer:
      "The Guard fails closed. A transaction with no recorded verdict is blocked, never allowed, and the spending limits are enforced on-chain independently of the risk engine. An outage makes Tripwire stricter, not weaker.",
  },
  {
    question: "Does an AI model decide whether my funds move?",
    answer:
      "No. The model reads context and writes the explanation attached to a verdict. Deterministic rules and the on-chain Guard make every decision that touches funds, and the pipeline produces the same verdict if the model is unavailable.",
  },
  {
    question: "Which wallets does it support?",
    answer:
      "Safe wallets, which is where the enforcement hook exists — Tripwire attaches as a Zodiac Guard. Support for other wallet standards is on the roadmap, not built.",
  },
  {
    question: "Can I write my own policy?",
    answer:
      "Yes, in plain English. \"Allow payments below $500 to addresses I have paid before, delay everything else an hour, freeze anything above $10,000\" compiles into the exact Guard configuration, and you see it rendered back before anything is activated.",
  },
];

function FaqItem({
  question,
  answer,
  isOpen,
  onClick,
}: {
  question: string;
  answer: string;
  isOpen: boolean;
  onClick: () => void;
}) {
  return (
    <div className="py-6 border-b border-white/10">
      <button
        className="faq-btn flex w-full text-left cursor-pointer items-center justify-between"
        onClick={onClick}
        aria-expanded={isOpen}
      >
        <h3 className="text-lg text-zinc-50 -tracking-[0.18px]">{question}</h3>
        <span
          className={`text-white/80 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M5.75 9.625L12 15.875L18.25 9.625"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <p className="mt-4 text-white/80 pb-2">{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="border-y border-white/20 mb-20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="border-x border-white/20 p-5 lg:p-20">
          <div className="grid grid-cols-1 lg:grid-cols-2 lg:gap-28">
            <div className="mb-10 lg:mb-0">
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="text-3xl sm:text-4xl mb-6 font-medium text-white"
              >
                Frequently Asked Questions
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
                className="text-base text-white/80 mb-6"
              >
                How the protection works, what happens when things fail, and
                where the limits are. If something is missing, ask us.
              </motion.p>
            </div>

            <div>
              {FAQS.map((faq, i) => (
                <motion.div
                  key={faq.question}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{
                    duration: 0.6,
                    ease: "easeOut",
                    delay: 0.2 + i * 0.1,
                  }}
                >
                  <FaqItem
                    question={faq.question}
                    answer={faq.answer}
                    isOpen={openIndex === i}
                    onClick={() => setOpenIndex(openIndex === i ? null : i)}
                  />
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
