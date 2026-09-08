"use client";

import { motion } from "motion/react";

export default function DocsContent() {
  return (
    <div className="flex-1 p-5 sm:p-10 lg:p-20">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      >
        <div className="mb-8">
          <h2 className="mb-5 text-white text-3xl">Introduction</h2>
          <p className="text-white/80 text-base">
            Tripwire is a guard that sits on a Safe wallet and checks every
            transaction before it executes. It is made of two halves: an
            off-chain engine that watches and scores, and on-chain contracts
            that enforce.
          </p>
        </div>

        <div className="space-y-5">
          <h3 className="text-base font-medium text-white">Why it works</h3>
          <p className="text-white/80 text-base">
            A Safe transaction is not instant. Someone proposes it, it waits for
            signatures, and only then does anyone call{" "}
            <code className="font-mono text-sm text-white">execTransaction</code>.
            Tripwire does its work inside that pause, which is why the Guard
            never has to make an off-chain call while a transaction is executing.
          </p>

          <h3 className="text-base font-medium text-white">The three controls</h3>
          <p className="text-white/80 text-base">
            <span className="font-medium text-white">Spending limits</span> are a
            per-transaction ceiling and a rolling 24-hour cap, held in the
            Guard&apos;s own storage and enforced regardless of any verdict.{" "}
            <span className="font-medium text-white">Cooling-off delays</span>{" "}
            hold a risky transaction for a configured window rather than
            executing it, and the engine can escalate it to blocked before the
            window ends. <span className="font-medium text-white">Freeze</span>{" "}
            stops every outgoing call; the risk engine can trip it, and only the
            owner can lift it.
          </p>

          <h3 className="text-base font-medium text-white">What gets scored</h3>
          <p className="text-white/80 text-base">
            Function calls that grant standing permission over your assets,
            unlimited allowances, off-chain signature approvals, first-seen
            counterparties, unverified or freshly deployed contracts, amounts far
            outside this wallet&apos;s own history, and reputation-feed matches.
            A fork simulation replays the transaction and compares what actually
            changes with what the transaction claims to do.
          </p>

          <h3 className="text-base font-medium text-white">Fail-closed</h3>
          <p className="text-white/80 text-base">
            A transaction with no recorded verdict is blocked, never allowed.
            This is the default rather than an edge case: if the engine is down,
            slow, or wrong about being reachable, nothing moves. The spending
            limits hold independently, so an outage makes Tripwire stricter.
          </p>

          <h3 className="text-base font-medium text-white">Writing a policy</h3>
          <p className="text-white/80 text-base">
            Policies are written as sentences and compiled to Guard
            configuration. Anything the compiler cannot map is a hard error
            rather than a silently dropped clause, and the compiled policy is
            rendered back in English for review before it is activated.
          </p>

          <h3 className="text-base font-medium text-white">Where it runs</h3>
          <p className="text-white/80 text-base">
            XDC Network is the intended deployment target. The contracts,
            engine, and dashboard run locally today against a development chain;
            see the repository for the current deployment status before relying
            on any network.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
