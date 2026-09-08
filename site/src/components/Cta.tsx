"use client";

import { motion } from "motion/react";
import ButtonLink from "./ButtonLink";
import { DASHBOARD_URL } from "@/lib/links";
import RibbonField from "./RibbonField";

export default function Cta() {
  return (
    <section className="bg-theme-dark py-20 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <RibbonField className="block w-full h-full" />
      </div>

      <div className="max-w-2xl mx-auto relative z-10 px-5">
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="text-white text-5xl text-center mb-4"
        >
          Nothing leaves the wallet unchecked.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
          className="mb-8 text-white text-center"
        >
          Open source, self-hostable, and enforced on-chain. Built for secure financial operations on XDC Network.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
          className="flex flex-col sm:flex-row gap-6 justify-center"
        >
          <ButtonLink
            href={DASHBOARD_URL}
            text="Open the Dashboard"
            className="bg-white px-6 py-3 text-theme-dark-500 transition-all duration-300 w-auto text-base hover:bg-white/90 font-mono inline-flex items-center justify-center"
          />
          <ButtonLink
            href="/docs"
            text="View docs"
            className="text-white bg-white/5 border py-3 border-white/40 transition-all duration-300 hover:bg-white/50 px-6 w-auto text-base inline-flex items-center justify-center"
          />
        </motion.div>
      </div>
    </section>
  );
}
