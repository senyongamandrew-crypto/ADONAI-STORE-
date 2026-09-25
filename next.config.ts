import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Arena preview proxies the dev server under https://{port}-{sandbox}.e2b.app
  allowedDevOrigins: ["*.e2b.app", "localhost"],
  output: "standalone",
};

export default nextConfig;
