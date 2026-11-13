import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/server/src/**/*.test.ts",
      "apps/server/test/**/*.test.ts",
      "apps/web/src/lib/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
    pool: "forks",
  },
});
