import { defineConfig } from "vite";

// In development the API runs under `wrangler dev`; in production the Worker
// serves both the API and these files.
export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { target: "es2022" },
});
