import Header from "@/components/Header";
import Hero from "@/components/Hero";
import Pipeline from "@/components/Pipeline";
import WhatYouGet from "@/components/WhatYouGet";
import Architecture from "@/components/Architecture";
import RiskExamples from "@/components/RiskExamples";
import AiSection from "@/components/AiSection";
import Roadmap from "@/components/Roadmap";
import Testimonials from "@/components/Testimonials";
import Faq from "@/components/Faq";
import Cta from "@/components/Cta";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <div className="antialiased bg-theme-dark">
      <Header />
      <Hero />
      <Pipeline />
      <WhatYouGet />
      <Architecture />
      <RiskExamples />
      <AiSection />
      <Roadmap />
      <Testimonials />
      <Faq />
      <Cta />
      <Footer />
    </div>
  );
}
