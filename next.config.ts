import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep development and production artifacts isolated. Running a validation
  // build while the local dashboard is open must not replace the dev server's
  // webpack chunks.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;
