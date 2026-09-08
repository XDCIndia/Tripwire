import type { Metadata } from "next";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import DocsContent from "@/components/DocsContent";

export const metadata: Metadata = {
  title: "Documentation — Tripwire",
  description:
    "Complete documentation and guides for Tripwire. Setup, policy reference, and integrations.",
};

const NAV_GROUPS = [
  {
    title: "Getting Started",
    links: ["Introduction", "Protecting your first Safe", "Configuration"],
  },
  {
    title: "Protection",
    links: ["Spending limits", "Cooling-off delays", "Emergency freeze"],
  },
  {
    title: "Risk engine",
    links: ["Signals", "Fork simulation", "Reasoning pass"],
  },
  {
    title: "Policy",
    links: ["Natural-language policy", "Policy reference"],
  },
  {
    title: "Operations",
    links: ["Running it yourself", "Audit trail"],
  },
];

export default function DocsPage() {
  return (
    <div className="antialiased bg-theme-dark min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <section className="border-y border-white/20 mb-20">
          <div className="max-w-7xl mx-auto px-6">
            <div className="border-x border-white/20 sm:flex">
              <aside className="px-6 py-8 lg:py-16 sm:w-70 border-r flex flex-col justify-between border-white/20">
                <div className="flex-1">
                  {NAV_GROUPS.map((group) => (
                    <div key={group.title}>
                      <span className="border-b border-white/20 py-2 text-xs text-white/40 block">
                        {group.title}
                      </span>
                      <ul className="space-y-5 py-4">
                        {group.links.map((link, i) => (
                          <li key={link}>
                            <a
                              href="#"
                              className={`font-medium text-sm ${
                                group.title === "Getting Started" && i === 0
                                  ? "text-white"
                                  : "text-white/60"
                              }`}
                            >
                              {link}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                <div className="mt-16">
                  <h3 className="text-base text-white font-medium">
                    Need Help?
                  </h3>
                  <a href="#" className="text-sm text-white/60">
                    support@tripwire.example
                  </a>
                </div>
              </aside>

              <DocsContent />
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
