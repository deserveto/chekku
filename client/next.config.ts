import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Emit a self-contained Node server under `.next/standalone` for container
  // production builds. Combined with `outputFileTracingRoot`, Next.js traces
  // the `@chekku/storage` workspace (raw TypeScript, exported from `storage/`)
  // and its `@aws-sdk/client-s3` dependency into the standalone bundle so the
  // runtime image needs no `npm install`.
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname, ".."),
  transpilePackages: ["@chekku/storage"],
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
};

export default nextConfig;
