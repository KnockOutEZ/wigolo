import AnnouncementBar from "@/components/AnnouncementBar";
import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import FeatureMarquee from "@/components/FeatureMarquee";
import Stats from "@/components/Stats";
import HowItWorks from "@/components/HowItWorks";
import TrustedBy from "@/components/TrustedBy";
import Tools from "@/components/Tools";
import OpenSource from "@/components/OpenSource";
import Testimonials from "@/components/Testimonials";
import Parity from "@/components/Parity";
import StartShipping from "@/components/StartShipping";
import Quickstart from "@/components/Quickstart";
import Feedback from "@/components/Feedback";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <AnnouncementBar />
      <Nav />
      <main>
        <Hero />
        <FeatureMarquee />
        <Stats />
        <HowItWorks />
        <TrustedBy />
        <Tools />
        <OpenSource />
        <Testimonials />
        <Parity />
        <StartShipping />
        <Quickstart />
        <Feedback />
      </main>
      <Footer />
    </>
  );
}
