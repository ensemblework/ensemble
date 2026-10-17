import type { NextConfig } from "next";

// A static site: `next build` writes plain files to out/. No server, no API calls, no cookies.
const config: NextConfig = {
  output: "export",
  transpilePackages: ["@ensemble/brand", "@ensemble/shared-types"],
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
};

export default config;
