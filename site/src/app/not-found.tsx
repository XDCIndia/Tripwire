import type { Metadata } from "next";
import Link from "next/link";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "404 — Page Not Found | Tripwire",
  description:
    "The page you're looking for couldn't be found. Return to the homepage.",
};

export default function NotFound() {
  return (
    <div className="antialiased bg-theme-dark min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <section className="border-y border-white/20 relative mb-20">
          <div className="max-w-7xl mx-auto px-6 relative">
            <div className="border-x border-white/20">
              <div className="max-w-xl mx-auto pt-20 lg:pt-30 pb-15 text-center relative z-20">
                <h2 className="text-white font-medium text-3xl lg:text-4xl mb-3">
                  Page Not Found!
                </h2>
                <p className="text-base text-white/80 mb-5 lg:mb-10">
                  It seems the page you were looking for could not be found.
                </p>
                <Link
                  href="/"
                  className="text-white shrink-0 font-normal bg-white/5 border py-3 border-white/40 transition-all hover:bg-white/10 px-6 inline-flex font-mono items-center justify-center text-base"
                >
                  Back to Homepage
                </Link>
              </div>
              {/* The template shipped this as a 2.2 MB PNG of a glowing "404".
                  Same treatment, drawn as type over a CSS bloom: sharp at any
                  size, no asset to license, nothing to download. */}
              <div
                className="relative z-10 h-[26vw] max-h-[300px] min-h-[150px]"
                aria-hidden="true"
              >
                <div className="bloom bloom-404" />
                <svg
                  viewBox="0 0 600 240"
                  className="relative w-full h-full"
                  role="presentation"
                >
                  <defs>
                    <linearGradient id="nf-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
                      <stop offset="100%" stopColor="#ffffff" stopOpacity="0.03" />
                    </linearGradient>
                  </defs>
                  <text
                    x="300"
                    y="182"
                    textAnchor="middle"
                    fontSize="220"
                    fontWeight="700"
                    letterSpacing="6"
                    fill="url(#nf-fill)"
                    stroke="rgb(255 255 255 / 0.28)"
                    strokeWidth="1.5"
                    style={{ fontFamily: "var(--font-sans)" }}
                  >
                    404
                  </text>
                </svg>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
