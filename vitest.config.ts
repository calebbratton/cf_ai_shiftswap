import { defineConfig } from "vitest/config";

// Pure unit tests run in plain Node, without the Cloudflare Vite plugin
// (which would try to open a remote Workers AI proxy session).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
