import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    // The opt-in PostgreSQL suites create, clone and drop databases in
    // parallel; a DROP DATABASE waits for a checkpoint and can exceed the 10 s
    // default under that load. Fast hooks are unaffected.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // See tests/stubs/server-only.ts - build-time marker with no runtime.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
