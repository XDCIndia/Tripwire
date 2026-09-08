"use client";

import { motion } from "motion/react";
import ButtonLink from "./ButtonLink";

const FIELD_CLASS =
  "h-12 border bg-white/5 w-full placeholder:text-white/80 p-5 border-white/20 focus:outline-0 text-white focus:border-white/50";

export default function SupportSection() {
  return (
    <section className="border-y border-white/20 mb-20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="px-8 py-10 lg:p-20 border-x border-white/20">
          <div>
            <div className="max-w-xl mx-auto text-center mb-16">
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="mb-6 text-4xl text-white font-medium"
              >
                Tripwire Support
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
                className="text-theme-dark-50"
              >
                Questions about setting a policy, reading a verdict, or running
                the engine yourself. We answer them.
              </motion.p>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
                className="sm:w-5/12"
              >
                <div className="border border-white/20 py-8 px-6 relative h-full">
                  <div className="bloom bloom-corner-tl" />
                  <div className="relative z-10">
                    <h3 className="text-white font-medium text-lg mb-1">
                      Get Quick Answer
                    </h3>
                    <p className="text-base text-white/80 mb-8">
                      Setup, policy syntax, and what each verdict means
                    </p>
                    <ButtonLink
                      href="/docs"
                      text="Browse FAQs"
                      className="text-white bg-white/5 border py-3 border-white/40 transition-all hover:bg-white/10 px-6 inline-flex font-mono items-center justify-center text-base"
                    />
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: "easeOut", delay: 0.3 }}
                className="sm:w-7/12"
              >
                <div className="border border-white/20 py-8 px-6 relative">
                  <div className="mb-6">
                    <h2 className="text-xl mb-1 font-medium text-white">
                      Contact Support
                    </h2>
                    <p className="text-base text-white/80">
                      Tell us what you are protecting and where you are stuck.
                    </p>
                  </div>

                  <form onSubmit={(e) => e.preventDefault()}>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <div>
                        <input
                          type="text"
                          aria-label="Name"
                          placeholder="Name*"
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div>
                        <input
                          type="email"
                          aria-label="Email"
                          placeholder="Email*"
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div className="col-span-full">
                        <input
                          type="text"
                          aria-label="Subject"
                          placeholder="Subject*"
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div className="col-span-full">
                        <textarea
                          name="message"
                          aria-label="Describe your issue"
                          placeholder="Describe your issue*"
                          className="h-32 py-3 px-5 border bg-white/5 w-full placeholder:text-white/80 border-white/20 focus:outline-0 text-white focus:border-white/50"
                        />
                      </div>
                    </div>
                    <div className="mt-6">
                      <ButtonLink
                        text="Send Message"
                        className="bg-white px-6 cursor-pointer py-3 text-theme-dark-500 transition-all w-full inline-flex items-center justify-center text-base hover:bg-white/90 font-mono"
                      />
                    </div>
                  </form>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
