// Fails if a tracked text file contains non-ASCII, invisible or control characters.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .toString()
  .split("\0")
  .filter(Boolean);

const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i;
let problems = 0;

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
  console.error(`${String(problems)} disallowed character(s) found.`);
  process.exit(1);
}
