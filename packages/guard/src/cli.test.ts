import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./cli.ts";

// A stand-in for `forge test --json`: it fails the invariant while src/C.sol
// still contains "bug".
const FAKE_RUNNER = `
const { readFileSync } = require("node:fs");
const bug = readFileSync("src/C.sol", "utf8").includes("bug");
console.log(JSON.stringify({ "test/C.t.sol:CT": { test_results: {
  "invariant_sum()": { status: bug ? "Failure" : "Success", reason: bug ? "drift" : null },
} } }));
process.exit(bug ? 1 : 0);
`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "vibloom-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src/C.sol"), "contract C { /* bug */ }");
  writeFileSync(join(dir, "test/C.t.sol"), "contract CT { function invariant_sum() public {} }");
  writeFileSync(join(dir, "runner.cjs"), FAKE_RUNNER);
  return dir;
}

function cli(dir: string, args: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, {
    cwd: dir,
    env: {},
    stdin: () => stdin,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("vibloom", () => {
  it("goes from init to a broken run, a blocked stop, a fix and a clean stop", () => {
    const dir = project();
    expect(cli(dir, ["init"]).out).toMatch(/1 invariant tests found/);

    const mapPath = join(dir, ".vibloom/roots.json");
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { runner: string[]; nodes: object[] };
    map.runner = ["node", "runner.cjs"];
    map.nodes.push({
      id: "asm.exact",
      kind: "assumption",
      title: "exact",
      depends_on: ["inv.sum"],
      watch: ["src/C.sol"],
    });
    writeFileSync(mapPath, JSON.stringify(map));

    const first = cli(dir, ["check"]);
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/inv\.sum: untested -> BROKEN/);
    expect(first.out).toMatch(/asm\.exact: hypothetical -> UNSUPPORTED/);

    const blocked = cli(dir, ["hook", "stop"], JSON.stringify({ cwd: dir }));
    expect(JSON.parse(blocked.out)).toMatchObject({ decision: "block" });

    writeFileSync(join(dir, "src/C.sol"), "contract C { }");
    expect(cli(dir, ["status"]).out).toMatch(/BROKEN/);

    const rerun = cli(
      dir,
      ["hook", "post-tool"],
      JSON.stringify({ cwd: dir, tool_name: "Bash", tool_input: { command: "forge test" } }),
    );
    expect(rerun.out).toMatch(/none need attention/);
    expect(cli(dir, ["hook", "stop"], JSON.stringify({ cwd: dir })).out).toBe("");
    expect(cli(dir, ["verify"]).out).toBe("2 runs, chain intact.");
  });

  it("records a run whose output is not a report as an error instead of a pass", () => {
    const dir = project();
    cli(dir, ["init"]);
    const mapPath = join(dir, ".vibloom/roots.json");
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { runner: string[] };
    map.runner = ["node", "-e", "console.error('Compiler run failed'); process.exit(1)"];
    writeFileSync(mapPath, JSON.stringify(map));
    const r = cli(dir, ["check"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/recorded with an error: the runner printed no JSON report/);
    expect(cli(dir, ["status"]).out).toMatch(/untested/);
  });

  it("does nothing in a project without a map", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibloom-none-"));
    expect(cli(dir, ["hook", "pre-tool"], JSON.stringify({ cwd: dir, tool_name: "Edit" }))).toEqual(
      {
        code: 0,
        out: "",
        err: "",
      },
    );
  });
});
