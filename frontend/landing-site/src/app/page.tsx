import { FeaturesSection } from "@/components/landing/features-section";
import { HeroSection } from "@/components/landing/hero-section";
import { PricingSection } from "@/components/landing/pricing-section";

export default function HomePage() {
  return (
    <main className="overflow-hidden">
      <HeroSection />
      <FeaturesSection />
      <PricingSection />
    </main>
  );
}
