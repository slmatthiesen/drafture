import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 127.0.0.1, NOT localhost: on Windows `localhost` resolves to IPv6 ::1, but
      // the API binds IPv4 — the proxy then gets ECONNREFUSED ::1:8080 and 500s.
      "/api": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
