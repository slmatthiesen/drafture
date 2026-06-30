import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "jobs/**/*.test.ts"],
    // DynamoDB integration tests run under vitest.dynamo.config.ts (they need the
    // emulator); keep them out of the fast/hermetic default suite.
    exclude: ["**/node_modules/**", "**/*.dynamo.test.ts"],
    globals: false,
  },
});
