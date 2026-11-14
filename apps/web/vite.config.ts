import { defineConfig } from "vite";

// The idea tree is a static app. AI is optional: when connected, the browser
// talks to the chosen provider directly with the person's own key.
const AI_HOSTS = [
  "https://api.anthropic.com",
  "https://api.openai.com",
  "https://api.x.ai",
  "https://generativelanguage.googleapis.com",
  "https://openrouter.ai",
  "http://localhost:*",
  "http://127.0.0.1:*",
];
const CSP = [
  "default-src 'self'",
  `connect-src 'self' ${AI_HOSTS.join(" ")}`,
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
  build: {
    target: "es2022",
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
