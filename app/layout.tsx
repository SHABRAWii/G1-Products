import type { Metadata } from "next";
import "./globals.css";
import "./job-detail.css";
import "./job-detail-overrides.css";
import "./motion-3d.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "RoboMotion",
  description: "Motion-to-policy operations for humanoid robotics.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AppShell>{children}</AppShell></body></html>;
}
