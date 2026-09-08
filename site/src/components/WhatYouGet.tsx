"use client";

import { useRef } from "react";
import { motion } from "motion/react";
import { Swiper, SwiperSlide } from "swiper/react";
import { Navigation } from "swiper/modules";
import type { Swiper as SwiperClass } from "swiper";
import "swiper/css";

/**
 * The six capabilities Tripwire actually ships today. Each maps to a real part
 * of the implementation — the icons are abstract geometry rather than literal
 * pictograms, matching the rest of the site's hairline treatment.
 */
const FEATURES = [
  {
    title: "Real-time transaction monitoring",
    description:
      "Watches Safe wallet transactions from the moment one is proposed, while it is still pending signatures — before it can execute.",
    icon: (
      <>
        <circle cx="24" cy="24" r="6" />
        <circle cx="24" cy="24" r="14" strokeOpacity="0.55" />
        <circle cx="24" cy="24" r="22" strokeOpacity="0.25" />
      </>
    ),
  },
  {
    title: "Risk-based protection",
    description:
      "Scores each transaction on amount, recipient history, contract reputation and the function being called, producing one decision with its reasons attached.",
    icon: (
      <>
        <path d="M2 40 L14 26 L24 33 L34 14 L46 6" />
        <path d="M2 46 H46" strokeOpacity="0.35" />
      </>
    ),
  },
  {
    title: "Spending limits",
    description:
      "A per-transaction ceiling and a rolling 24-hour cap, held in the Guard's own storage. Anything over the line does not execute.",
    icon: (
      <>
        <rect x="2" y="14" width="44" height="20" />
        <path d="M14 14 V34" strokeOpacity="0.5" />
        <path d="M34 14 V34" strokeOpacity="0.5" />
      </>
    ),
  },
  {
    title: "Cooling-off delays",
    description:
      "High-risk transactions enter a timed hold instead of executing. The window is the chance to review, and to cancel before it fires.",
    icon: (
      <>
        <circle cx="24" cy="24" r="20" />
        <path d="M24 12 V24 L33 30" />
      </>
    ),
  },
  {
    title: "Emergency freeze",
    description:
      "One switch stops every outgoing call from the wallet. The risk engine can trip it; only the owner can lift it.",
    icon: (
      <>
        <path d="M24 4 V44" />
        <path d="M6 14 L42 34" strokeOpacity="0.6" />
        <path d="M42 14 L6 34" strokeOpacity="0.6" />
      </>
    ),
  },
  {
    title: "On-chain enforcement",
    description:
      "Decisions are written to the Risk Registry and read by the Tripwire Guard at execution time. Enforcement lives in the contract, not the dashboard.",
    icon: (
      <>
        <rect x="4" y="4" width="18" height="18" />
        <rect x="26" y="26" width="18" height="18" />
        <path d="M22 13 H36 V26" strokeOpacity="0.55" />
      </>
    ),
  },
];

function FeatureCard({
  title,
  description,
  icon,
}: (typeof FEATURES)[number]) {
  return (
    <div className="p-8 border border-white/20 group duration-300 ease-in-out hover:border-white/60 transition-all relative overflow-hidden h-full">
      <div className="relative z-10">
        <div className="mb-6">
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            stroke="white"
            strokeWidth="0.75"
            aria-hidden="true"
          >
            {icon}
          </svg>
        </div>
        <h3 className="text-white mb-3 text-2xl -tracking-[1px]">{title}</h3>
        <p className="text-base text-white/80">{description}</p>
      </div>
      <div className="bloom bloom-corner-br opacity-0 group-hover:opacity-100 transition duration-300" />
    </div>
  );
}

export default function WhatYouGet() {
  const swiperRef = useRef<SwiperClass | null>(null);

  return (
    <section className="border-y border-white/20 mb-20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="border-x border-white/20 p-5 lg:p-20">
          <div className="flex flex-col sm:flex-row justify-between gap-5 lg:items-end mb-16">
            <div className="lg:max-w-xl">
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="font-mono text-xs uppercase tracking-[0.12em] text-white/50 mb-4 flex items-center gap-2.5"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-white" />
                Available now
              </motion.p>
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="text-3xl sm:text-4xl mb-6 font-medium text-white"
              >
                What Tripwire does
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
                className="text-base text-white/80"
              >
                Six controls that exist in the codebase today, configured in
                advance and enforced at the contract layer. Nothing here depends
                on a user noticing a warning in time.
              </motion.p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => swiperRef.current?.slidePrev()}
                aria-label="Previous"
                className="ring size-12 ring-white/40 items-center justify-center cursor-pointer bg-white/5 text-white font-mono flex hover:bg-white/10 transition duration-300"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 11.9966L20.0014 11.9966M9.99599 6L4 11.9998L9.99599 18"
                    stroke="white"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                onClick={() => swiperRef.current?.slideNext()}
                aria-label="Next"
                className="ring size-12 ring-white/40 items-center justify-center cursor-pointer bg-white/5 text-white font-mono flex hover:bg-white/10 transition duration-300"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M20.0014 11.9966L4 11.9966M14.0054 6L20.0014 11.9998L14.0054 18"
                    stroke="white"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
          >
            <Swiper
              modules={[Navigation]}
              loop
              spaceBetween={8}
              slidesPerView={1}
              onSwiper={(s) => {
                swiperRef.current = s;
              }}
              breakpoints={{
                640: { slidesPerView: 1 },
                1024: { slidesPerView: 2 },
                1280: { slidesPerView: 3 },
              }}
            >
              {FEATURES.map((feature) => (
                <SwiperSlide key={feature.title} className="h-auto">
                  <FeatureCard {...feature} />
                </SwiperSlide>
              ))}
            </Swiper>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
