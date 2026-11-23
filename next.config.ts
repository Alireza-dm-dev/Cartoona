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

  /**
   * Content-addressed public media (performance pass).
   *
   * Next serves every `public/` file with `Cache-Control: public, max-age=0`,
   * because a public file may change in place. Files under `/media/` never do:
   * each name carries the first 10 hex of the file's SHA-256 (a static test
   * enforces it), so a new version is a new URL and the old one can be cached
   * forever, by browsers and by the CDN, like `/_next/static`.
   *
   * Only shipped, non-personal homepage assets live there. Private uploads,
   * signed Storage URLs and authenticated responses never pass through this
   * rule.
   */
  async headers() {
    return [
      {
        source: "/media/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
