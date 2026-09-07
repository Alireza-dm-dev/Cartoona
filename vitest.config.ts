import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // See tests/stubs/server-only.ts - build-time marker with no runtime.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
