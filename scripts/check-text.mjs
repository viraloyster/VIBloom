// Fails if a tracked text file contains non-ASCII, invisible or control
// characters, or anything shaped like a credential.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .toString()
  .split("\0")
  .filter(Boolean);

const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i;
let problems = 0;

// A bearer token, an assigned key or token literal, or a private key block.
const secrets = [
  /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /(api[_-]?key|secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{20,}["']/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

for (const file of files) {
  if (binary.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (secrets.some((r) => r.test(line))) {
      console.error(`${file}:${String(i + 1)} looks like a credential`);
      problems++;
    }
    for (let col = 0; col < line.length; col++) {
      const code = line.charCodeAt(col);
      if (code === 9 || (code >= 32 && code < 127)) continue;
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      console.error(`${file}:${String(i + 1)}:${String(col + 1)} U+${hex}`);
      problems++;
    }
  });
}

if (problems > 0) {
  console.error(`${String(problems)} problem(s) found.`);
  process.exit(1);
}
