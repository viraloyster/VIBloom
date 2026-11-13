#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { main } from "../src/cli.ts";

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: () => readFileSync(0, "utf8"),
  out: (s) => {
    process.stdout.write(`${s}\n`);
  },
  err: (s) => {
    process.stderr.write(`${s}\n`);
  },
});
