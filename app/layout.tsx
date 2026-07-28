import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Manrope } from "next/font/google";
import "./globals.css";
import "./job-detail.css";
import "./job-detail-overrides.css";
import "./motion-3d.css";
import "./redesign.css";
import { AppShell } from "@/components/app-shell";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "RoboMotion",
  description: "Motion-to-policy operations for humanoid robotics.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
