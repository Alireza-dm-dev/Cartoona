import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Standalone output (V0.1.35).
   *
   * `next build` emits `.next/standalone` — a self-contained server bundle with
   * only the production dependencies it actually traced. The Docker runtime
   * image copies that plus `.next/static` and `public`, and runs
   * `node server.js`; it needs neither the source tree nor `node_modules`.
   * Harmless outside Docker: `npm run dev` / `npm start` are unaffected.
   */
  output: "standalone",
};

export default nextConfig;
