import { defineConfig } from "vite";

// The idea tree is a static app: the browser talks to the Meta Model API
// directly with the person's own key. The chemistry bench (bench.html) still
// needs the API under `wrangler dev` in development.
const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.meta.ai",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'self' blob:",
].join("; ");

export default defineConfig({
  // Relative paths, so the same build works at a domain root or under
  // /VIBloom/ on GitHub Pages.
  base: "./",
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: {
    target: "es2022",
    rolldownOptions: { input: { index: "index.html", bench: "bench.html" } },
  },
  plugins: [
    {
      name: "csp",
      apply: "build",
      transformIndexHtml: (html) =>
        html.replace(
          "<head>",
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        ),
    },
  ],
});
