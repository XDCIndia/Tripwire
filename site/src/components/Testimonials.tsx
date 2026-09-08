"use client";

import { motion } from "motion/react";

type Testimonial = {
  name: string;
  /** A role, not a social handle: an invented @handle can collide with a real
   *  account, and these quotes are illustrative. */
  role: string;
  quote: string;
};

const ROW_ONE: Testimonial[] = [
  {
    name: "Lydia Carter",
    role: "Marketing Lead",
    quote:
      "The delay window has caught two payments that were going to the wrong address. Neither was an attack — both would have been unrecoverable.",
  },
  {
    name: "Marcus Thompson",
    role: "Founder",
    quote:
      "We set the policy in a sentence and could read back exactly what the Guard would enforce. That was the moment the team trusted it.",
  },
  {
    name: "Sarah Mitchell",
    role: "Content Strategist",
    quote:
      "A drainer approval got blocked before anyone on the team had even opened the wallet. The explanation told us why in one line.",
  },
  {
    name: "James Wilson",
    role: "Head of Growth",
    quote:
      "Knowing it fails closed is the part that lets me sleep. If the service is down, nothing moves.",
  },
];

const ROW_TWO: Testimonial[] = [
  {
    name: "Emily Davis",
    role: "Operations Lead",
    quote:
      "The rolling limit stopped a compromised signer from draining the treasury in one go. It bought us the hours we needed.",
  },
  {
    name: "David Brown",
    role: "Product Marketer",
    quote:
      "Every verdict comes with the signals behind it, so we can argue with a block instead of just accepting it.",
  },
  {
    name: "Jessica Taylor",
    role: "Editorial Manager",
    quote:
      "We run it ourselves, on our own infrastructure, with our own key. For a treasury that mattered more than any feature.",
  },
  {
    name: "Michael Johnson",
    role: "Treasury Manager",
    quote:
      "It caught an approval to a contract deployed forty minutes earlier. No rule we would have written by hand would have found that.",
  },
];

/** Initials, so nobody's likeness is attached to a quote they did not give. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function Card({ name, role, quote }: Testimonial) {
  return (
    <li className="p-6 border border-white/10 bg-white/3 min-w-[420px]">
      <div className="flex gap-3 items-center mb-2">
        <div
          aria-hidden="true"
          className="size-12 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-white/70 font-mono text-sm shrink-0"
        >
          {initials(name)}
        </div>
        <div>
          <h4 className="text-xl text-white font-medium">{name}</h4>
          <span className="text-zinc-400 text-base">{role}</span>
        </div>
      </div>
      <div>
        <p className="text-base text-zinc-400">{quote}</p>
      </div>
    </li>
  );
}

function Marquee({
  items,
  direction,
  className,
}: {
  items: Testimonial[];
  direction: "left" | "right";
  className?: string;
}) {
  const animation =
    direction === "left" ? "animate-scroll-left" : "animate-scroll-right";

  return (
    <div
      className={`w-full inline-flex flex-nowrap overflow-hidden marquee-mask ${
        className ?? ""
      }`}
    >
      {[false, true].map((isDuplicate) => (
        <ul
          key={String(isDuplicate)}
          aria-hidden={isDuplicate || undefined}
          className={`flex items-center justify-center md:justify-start [&_li]:mx-3 ${animation}`}
        >
          {items.map((item, i) => (
            <Card key={`${item.name}-${i}`} {...item} />
          ))}
        </ul>
      ))}
    </div>
  );
}

export default function Testimonials() {
  return (
    <section className="mb-20 border-y border-white/20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="py-20">
          <div className="lg:max-w-lg mx-auto text-center mb-16">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="text-3xl sm:text-4xl mb-6 font-medium text-white"
            >
              What protection feels like in practice
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
              className="text-base text-white/80"
            >
              How teams describe running a treasury with a guard in front of
              it &mdash; what it caught, and what it cost them to trust it.
            </motion.p>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
              className="text-xs font-mono uppercase tracking-[0.12em] text-white/40 mt-6"
            >
              Sample content &mdash; illustrative, not real customer quotes
            </motion.p>
          </div>

          <Marquee items={ROW_ONE} direction="left" className="mb-6" />
          <Marquee items={ROW_TWO} direction="right" />
        </div>
      </div>
    </section>
  );
}
