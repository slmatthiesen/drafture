import { defineConfig } from "vitest/config";

/**
 * Integration tests for the DynamoDB store impls — gated behind their own config so the
 * default `pnpm test` stays fast/hermetic (SQLite, no emulator). Run with `pnpm test:dynamo`.
 * globalSetup starts DynamoDB Local (Docker) and tears it down; tests share that one
 * emulator, so file parallelism is off to avoid table-name races.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.dynamo.test.ts"],
    globalSetup: ["./test/dynamo/globalSetup.ts"],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
