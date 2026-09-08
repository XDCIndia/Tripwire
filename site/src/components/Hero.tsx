"use client";

import { motion } from "motion/react";
import AsciiField from "./AsciiField";
import ButtonLink from "./ButtonLink";
import { DASHBOARD_URL } from "@/lib/links";

export default function Hero() {
  return (
    <section className="border-y border-white/20 overflow-hidden relative">
      {/* The ASCII field sits furthest back; the bloom washes over it, and the
          copy sits above both on z-20. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <AsciiField className="absolute inset-0 block h-full w-full" />
        <div className="bloom bloom-hero" />
      </div>

      <div className="max-w-7xl mx-auto px-6 relative z-20">
        <div className="border-x border-white/20 pt-6 xl:py-30">
          <div className="max-w-md lg:max-w-2xl xl:max-w-4xl mx-auto px-4 py-14">
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="text-4xl lg:text-5xl -tracking-[1.5px] xl:text-6xl font-normal text-white text-center xl:leading-16 mb-6"
            >
              Protect every transaction before it becomes irreversible.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
              className="text-white/80 text-base max-w-2xl text-center mx-auto mb-10"
            >
              Tripwire is a smart-contract financial guardian. It monitors wallet
              activity, detects suspicious transactions, evaluates risk, and
              enforces the protection you configured &mdash; before funds move.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
              className="flex flex-col sm:flex-row gap-4 justify-center"
            >
              <ButtonLink
                href={DASHBOARD_URL}
                text="Open the Dashboard"
                className="bg-white px-6 py-3.5 text-theme-dark-500 transition-all duration-300 text-base hover:bg-white/90 font-mono"
              />
              <ButtonLink
                href="/docs"
                text="View Docs"
                className="text-white bg-white/5 ring ring-white/40 py-3.5 px-6 text-base font-mono transition-all duration-300 hover:bg-white/10"
              />
            </motion.div>

          </div>
        </div>
      </div>
    </section>
  );
}
