import type { Metadata } from "next";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import SupportSection from "@/components/SupportSection";

export const metadata: Metadata = {
  title: "Support — Tripwire",
  description:
    "Get quick answers and support from our team. Browse FAQs or contact us about Tripwire.",
};

export default function SupportPage() {
  return (
    <div className="antialiased bg-theme-dark min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <SupportSection />
      </main>
      <Footer />
    </div>
  );
}
