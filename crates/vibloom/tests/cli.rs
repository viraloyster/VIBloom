//! The real binary against throwaway projects: a fake runner stands in for
//! Foundry, and git is real.

use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

// Fails invariant_sum while src/C.sol contains "bug", like `forge test --json`.
const RUNNER: &str = r#"#!/bin/sh
if grep -q bug src/C.sol; then s=Failure; r='"drift"'; else s=Success; r=null; fi
printf '{"test/C.t.sol:CT":{"test_results":{"invariant_sum()":{"status":"%s","reason":%s}}}}\n' "$s" "$r"
"#;

static N: AtomicU32 = AtomicU32::new(0);

fn project() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "vibloom-it-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).expect("dir");
    fs::create_dir_all(dir.join("test")).expect("dir");
    fs::write(dir.join("src/C.sol"), "contract C { /* bug */ }").expect("write");
    fs::write(
        dir.join("test/C.t.sol"),
        "contract CT { function invariant_sum() public {} }",
    )
    .expect("write");
    fs::write(dir.join("runner.sh"), RUNNER).expect("write");
    dir
}

// The role comes from the environment, and these tests may themselves run
// inside an agent: every child starts with none of the variables it reads.
const ROLE_VARS: [&str; 6] = [
    "VIBLOOM_ROLE",
    "CLAUDECODE",
    "CODEX_THREAD_ID",
    "CODEX_SANDBOX",
    "CURSOR_AGENT",
    "GEMINI_CLI",
];

fn clean(cmd: &mut Command) -> &mut Command {
    for v in ROLE_VARS {
        cmd.env_remove(v);
    }
    cmd
}

struct Out {
    code: i32,
    out: String,
    err: String,
}

// `person` runs it as someone at a terminal, with no role set; otherwise as
// an agent, the way Claude Code runs its commands.
fn vibloom(dir: &Path, args: &[&str], stdin: &str, person: bool) -> Out {
    vibloom_env(
        dir,
        args,
        stdin,
        if person { &[] } else { &[("CLAUDECODE", "1")] },
    )
}

fn vibloom_env(dir: &Path, args: &[&str], stdin: &str, env: &[(&str, &str)]) -> Out {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_vibloom"));
    clean(&mut cmd)
        .args(args)
        .current_dir(dir)
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin.as_bytes())
        .expect("write");
    let o = child.wait_with_output().expect("wait");
    Out {
        code: o.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        err: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    }
}

fn cli(dir: &Path, args: &[&str]) -> Out {
    vibloom(dir, args, "", false)
}

fn edit_map(dir: &Path, f: impl FnOnce(&mut Value)) {
    let p = dir.join(".vibloom/roots.json");
    let mut m: Value = serde_json::from_str(&fs::read_to_string(&p).expect("map")).expect("json");
    f(&mut m);
    fs::write(&p, m.to_string()).expect("write");
}

fn with_runner(dir: &Path) {
    assert_eq!(cli(dir, &["init"]).code, 0);
    edit_map(dir, |m| m["runner"] = json!(["sh", "runner.sh"]));
}

fn git(dir: &Path, args: &[&str]) {
    let ok = clean(&mut Command::new("git"))
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git")
        .status
        .success();
    assert!(ok, "git {args:?}");
}

#[test]
fn goes_from_a_broken_run_to_a_fix_through_the_hooks() {
    let dir = project();
    with_runner(&dir);
    edit_map(&dir, |m| {
        m["nodes"].as_array_mut().expect("nodes").push(json!({
            "id": "asm.exact", "kind": "assumption", "title": "exact",
            "depends_on": ["inv.sum"], "watch": ["src/C.sol"]
        }));
    });

    let first = cli(&dir, &["check"]);
    assert_eq!(first.code, 1);
    assert!(
        first.out.contains("inv.sum: untested -> BROKEN"),
        "{}",
        first.out
    );
    assert!(
        first
            .out
            .contains("asm.exact: pending review -> UNSUPPORTED")
    );

    let cwd = json!({ "cwd": dir }).to_string();
    let blocked: Value =
        serde_json::from_str(&vibloom(&dir, &["hook", "stop"], &cwd, false).out).expect("json");
    assert_eq!(blocked["decision"], "block");

    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    assert!(cli(&dir, &["status"]).out.contains("BROKEN"));

    let ran =
        json!({ "cwd": dir, "tool_name": "Bash", "tool_input": { "command": "forge test -vv" } });
    let after = vibloom(&dir, &["hook", "post-tool"], &ran.to_string(), false);
    assert!(after.out.contains("none need attention"), "{}", after.out);
    assert_eq!(vibloom(&dir, &["hook", "stop"], &cwd, false).out, "");
    assert_eq!(cli(&dir, &["verify"]).out, "2 runs, chain intact.");
}

#[test]
fn denies_a_builder_editing_a_protected_test_and_allows_the_verifier() {
    let dir = project();
    with_runner(&dir);
    let input = json!({ "cwd": dir, "tool_name": "Edit",
        "tool_input": { "file_path": dir.join("test/C.t.sol") } })
    .to_string();
    let denied: Value =
        serde_json::from_str(&vibloom(&dir, &["hook", "pre-tool"], &input, false).out)
            .expect("json");
    assert_eq!(denied["hookSpecificOutput"]["permissionDecision"], "deny");
    assert_eq!(vibloom(&dir, &["hook", "pre-tool"], &input, true).out, "");
}

#[test]
fn records_a_runner_failure_as_an_error_never_a_pass() {
    let dir = project();
    cli(&dir, &["init"]);
    edit_map(&dir, |m| {
        m["runner"] = json!(["sh", "-c", "echo 'Compiler run failed' >&2; exit 1"])
    });
    let r = cli(&dir, &["check"]);
    assert_eq!(r.code, 2);
    assert!(
        r.err
            .contains("recorded with an error: the runner printed no JSON report"),
        "{}",
        r.err
    );
    assert!(r.err.contains("Compiler run failed"));
    assert!(cli(&dir, &["status"]).out.contains("untested"));
}

// Writes a JUnit report like cargo-nextest: tests::sum fails while src/C.sol
// contains "bug". With "none" as argument it writes nothing, as a build failure.
const JUNIT_RUNNER: &str = r#"#!/bin/sh
[ "$1" = none ] && exit 101
if grep -q bug src/C.sol; then f='<failure>sum &lt; total</failure>'; else f=''; fi
mkdir -p out
printf '<testsuites><testsuite name="vault"><testcase classname="vault" name="tests::sum">%s</testcase></testsuite></testsuites>' "$f" > out/junit.xml
"#;

#[test]
fn reads_a_junit_report_and_never_a_stale_one() {
    let dir = project();
    fs::write(dir.join("junit.sh"), JUNIT_RUNNER).expect("write");
    cli(&dir, &["init"]);
    edit_map(&dir, |m| {
        m["runner"] = json!(["sh", "junit.sh"]);
        m["report"] = json!("out/junit.xml");
        m["nodes"] = json!([{ "id": "inv.sum", "kind": "invariant", "title": "sum",
            "test": { "file": "src/C.sol", "contract": "vault", "name": "tests::sum" },
            "watch": ["src/C.sol"] }]);
    });

    let broken = cli(&dir, &["check"]);
    assert_eq!(broken.code, 1);
    assert!(
        broken.out.contains("inv.sum: untested -> BROKEN"),
        "{}",
        broken.out
    );
    let log = fs::read_to_string(dir.join(".vibloom/local/log.jsonl")).expect("log");
    assert!(log.contains("sum < total"), "{log}");

    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    assert_eq!(cli(&dir, &["check"]).code, 0);

    // The report from the last run is still on disk; it must not count again.
    edit_map(&dir, |m| m["runner"] = json!(["sh", "junit.sh", "none"]));
    let none = cli(&dir, &["check"]);
    assert_eq!(none.code, 2);
    assert!(
        none.err
            .contains("the runner wrote no report at out/junit.xml"),
        "{}",
        none.err
    );
}

#[test]
fn the_commit_check_needs_no_agent() {
    let dir = project();
    with_runner(&dir);
    git(&dir, &["init", "-q"]);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    git(&dir, &["add", "src/C.sol"]);
    assert!(cli(&dir, &["precommit"]).err.contains("inv.sum [untested]"));
    cli(&dir, &["run"]);
    assert_eq!(cli(&dir, &["precommit"]).code, 0);
    fs::write(
        dir.join("test/C.t.sol"),
        "contract CT { function invariant_sum() public { } }",
    )
    .expect("write");
    git(&dir, &["add", "test/C.t.sol"]);
    let r = cli(&dir, &["precommit"]);
    assert_eq!(r.code, 1);
    assert!(r.err.contains("test/C.t.sol is guarded"));
}

const TWO_SUITES: &str = r#"#!/bin/sh
if grep -q bug src/C.sol; then s=Failure; r='"drift"'; else s=Success; r=null; fi
printf '{"test/C.t.sol:CT":{"test_results":{"invariant_sum()":{"status":"%s","reason":%s}}},"test/New.t.sol:NT":{"test_results":{"invariant_new()":{"status":"Success","reason":null}}}}\n' "$s" "$r"
"#;

// A project on main with its map committed, and a feature branch checked out.
fn on_a_branch() -> PathBuf {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    fs::write(dir.join("foundry.toml"), "[invariant]\nruns = 64\n").expect("write");
    edit_map(&dir, |m| m["protect"] = json!(["foundry.toml"]));
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "base"]);
    git(&dir, &["checkout", "-qb", "feature"]);
    dir
}

#[test]
fn check_against_the_base_refuses_a_gutted_invariant_and_a_leak() {
    let dir = on_a_branch();
    assert_eq!(cli(&dir, &["check", "--base", "main"]).code, 0);
    // The attack: the invariant asserts nothing, the code leaks, the commit
    // skips the hook, and the recorded state on this machine says "holds".
    fs::write(
        dir.join("test/C.t.sol"),
        "contract CT { function invariant_sum() public { assert(true); } }",
    )
    .expect("write");
    fs::write(dir.join("src/C.sol"), "contract C { /* leak 1 wei */ }").expect("write");
    fs::write(dir.join("foundry.toml"), "[invariant]\nruns = 1\n").expect("write");
    edit_map(&dir, |m| {
        m["nodes"][0]["protected"] = json!(false);
        m["timeout"] = json!(5);
    });
    git(&dir, &["commit", "-qam", "tidy", "--no-verify"]);
    assert_eq!(cli(&dir, &["run"]).code, 0);
    assert_eq!(cli(&dir, &["status"]).code, 0);

    let r = cli(&dir, &["check", "--base", "main"]);
    assert_eq!(r.code, 1, "{}\n{}", r.out, r.err);
    for want in [
        "Guard changes against main:",
        "- the timeout changed from 3600 s to 5 s",
        "- inv.sum: its test is no longer protected",
        "- foundry.toml: guarded file changed",
        "- test/C.t.sol: guarded file changed",
        "they need a person's review",
    ] {
        assert!(r.out.contains(want), "{want}: {}", r.out);
    }
    let j: Value =
        serde_json::from_str(&cli(&dir, &["check", "--base", "main", "--json"]).out).expect("json");
    assert_eq!(j["exit"], 1);
    assert_eq!(j["guard"]["changes"].as_array().map(Vec::len), Some(4));
    assert_eq!(j["guard"]["changes"][3]["kind"], "file_changed");
    assert_eq!(j["tool_error"], Value::Null);
    let gh = cli(&dir, &["check", "--base", "main", "--format", "github"]);
    assert!(
        gh.out.contains(
            "::error file=test/C.t.sol,title=VIBloom guard change::test/C.t.sol: guarded file changed"
        ),
        "{}",
        gh.out
    );
    // Approved by a reviewer, the guard part passes; the tests decide.
    let allowed = cli(&dir, &["check", "--base", "main", "--allow-guard-changes"]);
    assert_eq!(allowed.code, 0, "{}", allowed.out);
    assert!(
        allowed.out.contains("a reviewer approved"),
        "{}",
        allowed.out
    );
    assert_eq!(cli(&dir, &["check", "--allow-guard-changes"]).code, 2);
}

#[test]
fn check_against_the_base_passes_new_nodes_and_new_tests_and_runs_fresh() {
    let dir = on_a_branch();
    fs::write(
        dir.join("test/New.t.sol"),
        "contract NT { function invariant_new() public {} }",
    )
    .expect("write");
    fs::write(dir.join("runner.sh"), TWO_SUITES).expect("write");
    edit_map(&dir, |m| {
        let nodes = m["nodes"].as_array_mut().expect("nodes");
        nodes.push(
            json!({ "id": "inv.new", "kind": "invariant", "title": "new",
            "test": { "file": "test/New.t.sol", "contract": "NT", "name": "invariant_new" } }),
        );
        nodes.push(
            json!({ "id": "asm.only-add", "kind": "assumption", "title": "only add",
            "depends_on": ["inv.sum"], "evidence": ["src/C.sol:1"] }),
        );
    });
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "more", "--no-verify"]);
    let r = cli(&dir, &["check", "--base", "main"]);
    assert_eq!(r.code, 0, "{}\n{}", r.out, r.err);
    assert!(
        r.out.contains("The guard is as it is on main."),
        "{}",
        r.out
    );
    assert!(
        r.out
            .contains("3 nodes, 0 need attention, 1 not yet reviewed."),
        "{}",
        r.out
    );

    // A forged local log is never what check reads: it runs the tests.
    fs::write(dir.join("src/C.sol"), "contract C { /* bug */ }").expect("write");
    let log = log_of(&dir);
    let forged = fs::read_to_string(&log).expect("log");
    let broken = cli(&dir, &["check", "--base", "main"]);
    assert_eq!(broken.code, 1, "{}", broken.out);
    fs::write(&log, forged).expect("write");
    assert_eq!(cli(&dir, &["check"]).code, 1);
    // No map on the base: said, and the guard part passes.
    let empty = clean(&mut Command::new("git"))
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree"])
        .args(["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "empty"])
        .current_dir(&dir)
        .output()
        .expect("git");
    let sha = String::from_utf8_lossy(&empty.stdout).trim().to_string();
    git(&dir, &["branch", "empty", &sha]);
    let none = cli(&dir, &["check", "--base", "empty"]);
    assert!(
        none.out.contains("empty has no .vibloom/roots.json yet"),
        "{}",
        none.out
    );
    let gone = cli(&dir, &["check", "--base", "nope", "--json"]);
    assert_eq!(gone.code, 2);
    let j: Value = serde_json::from_str(&gone.out).expect("json");
    assert!(
        j["tool_error"]
            .as_str()
            .unwrap_or_default()
            .contains("nope is not a commit here"),
        "{j}"
    );
}

// Where the local log of a project in a git repository is.
fn log_of(dir: &Path) -> PathBuf {
    dir.join(".git/vibloom/log.jsonl")
}

#[test]
fn verifies_and_extends_a_log_written_by_the_typescript_guard() {
    let dir = project();
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-log");
    fs::create_dir_all(dir.join(".vibloom/local")).expect("dir");
    for (from, to) in [
        ("roots.json", ".vibloom/roots.json"),
        ("log.jsonl", ".vibloom/local/log.jsonl"),
        ("C.sol", "src/C.sol"),
        ("C.t.sol", "test/C.t.sol"),
    ] {
        fs::copy(fx.join(from), dir.join(to)).expect("copy");
    }
    assert_eq!(cli(&dir, &["verify"]).out, "2 runs, chain intact.");
    let status = cli(&dir, &["status"]);
    assert_eq!(status.code, 0, "{}", status.out);
    assert!(status.out.contains("holds") && status.out.contains("inv.sum"));

    edit_map(&dir, |m| m["runner"] = json!(["sh", "runner.sh"]));
    assert!(cli(&dir, &["run"]).out.starts_with("Run 3:"));
    assert_eq!(cli(&dir, &["verify"]).out, "3 runs, chain intact.");
}

#[test]
fn a_committed_log_is_moved_aside_once_and_never_read() {
    let dir = project();
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-log");
    fs::create_dir_all(dir.join(".vibloom")).expect("dir");
    for (from, to) in [
        ("roots.json", ".vibloom/roots.json"),
        ("log.jsonl", ".vibloom/log.jsonl"),
        ("C.sol", "src/C.sol"),
        ("C.t.sol", "test/C.t.sol"),
    ] {
        fs::copy(fx.join(from), dir.join(to)).expect("copy");
    }
    // Its passes verify, yet nothing holds: whoever committed it wrote it.
    let first = cli(&dir, &["status"]);
    assert_eq!(first.code, 1, "{}", first.out);
    assert!(first.out.contains("untested"), "{}", first.out);
    assert!(
        first.err.contains("git rm --cached .vibloom/log.jsonl"),
        "{}",
        first.err
    );
    assert!(!dir.join(".vibloom/log.jsonl").exists());
    assert!(dir.join(".vibloom/local/log.committed.jsonl").exists());
    assert_eq!(cli(&dir, &["status"]).err, "");
    assert_eq!(
        fs::read_to_string(dir.join(".vibloom/.gitignore")).expect("ignore"),
        "local/\n"
    );
}

#[test]
fn serves_mcp_and_keeps_proposals_out_of_the_map_until_accepted() {
    let dir = project();
    with_runner(&dir);
    let msgs = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "run", "arguments": { "filters": ["--fork-url", "x"] } } }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "run", "arguments": { "filters": ["--mt", "invariant_sum"] } } }),
        json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "propose", "arguments": {
            "kind": "assumption", "title": "Only add() changes total", "depends_on": ["inv.sum"],
            "evidence": ["src/C.sol:1"], "by": "test-agent" } } }),
        json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "context", "arguments": { "file": "src/C.sol" } } }),
    ];
    let input: String = msgs.iter().map(|m| format!("{m}\n")).collect();
    let out = vibloom(&dir, &["mcp"], &input, false).out;
    let replies: Vec<Value> = out
        .lines()
        .map(|l| serde_json::from_str(l).expect("json"))
        .collect();
    assert_eq!(replies.len(), 5, "{out}");
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "vibloom");
    assert_eq!(replies[1]["result"]["isError"], true);
    assert!(
        replies[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("BROKEN")
    );
    assert!(
        replies[3]["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("Proposed p1")
    );

    let map = fs::read_to_string(dir.join(".vibloom/roots.json")).expect("map");
    assert!(
        !map.contains("Only add()"),
        "a proposal must not reach the map on its own"
    );
    assert!(
        cli(&dir, &["proposals"])
            .out
            .contains("  assumption\n    p1  Only add() changes total")
    );
    // An agent cannot accept what it proposed: deciding needs the verifier.
    let refused = cli(&dir, &["proposals", "accept", "p1"]);
    assert_eq!(refused.code, 2);
    assert!(
        refused
            .err
            .contains("decides what enters the map, which is a decision for the person"),
        "{}",
        refused.err
    );
    let accepted = vibloom(&dir, &["proposals", "accept", "p1"], "", true);
    assert!(
        accepted.out.contains("as asm.only-add-changes-total"),
        "{}",
        accepted.out
    );
    assert!(
        cli(&dir, &["status"])
            .out
            .contains("UNSUPPORTED (unreviewed)  asm.only-add-changes-total")
    );
    assert_eq!(cli(&dir, &["proposals"]).out, "No pending proposals.");
}

#[test]
fn a_test_that_never_ran_was_skipped_or_went_missing_fails_the_check() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    assert_eq!(cli(&dir, &["check"]).code, 0);

    // A node whose test name matches nothing in the report proves nothing.
    edit_map(&dir, |m| {
        m["nodes"].as_array_mut().expect("nodes").push(json!({
            "id": "inv.typo", "kind": "invariant", "title": "typo",
            "test": { "file": "test/C.t.sol", "contract": "CT", "name": "invariant_summ" }
        }));
    });
    let typo = cli(&dir, &["check"]);
    assert_eq!(typo.code, 1, "{}", typo.out);
    assert!(
        typo.out
            .lines()
            .any(|l| l.starts_with("untested ") && l.contains(" inv.typo ")),
        "{}",
        typo.out
    );
    edit_map(&dir, |m| {
        m["nodes"].as_array_mut().expect("nodes").pop();
    });

    let report = |status: &str| {
        format!("printf '%s\\n' '{{\"test/C.t.sol:CT\":{{\"test_results\":{{{status}}}}}}}'\n")
    };
    fs::write(
        dir.join("runner.sh"),
        report("\"invariant_sum()\":{\"status\":\"Skipped\",\"reason\":null}"),
    )
    .expect("write");
    let skipped = cli(&dir, &["check"]);
    assert_eq!(skipped.code, 1, "{}", skipped.out);
    assert!(
        skipped.out.contains("skipped, unit  inv.sum"),
        "{}",
        skipped.out
    );

    // The whole suite runs and the invariant is no longer in it.
    fs::write(
        dir.join("runner.sh"),
        report("\"test_other()\":{\"status\":\"Success\",\"reason\":null}"),
    )
    .expect("write");
    let gone = cli(&dir, &["check"]);
    assert_eq!(gone.code, 1, "{}", gone.out);
    assert!(gone.out.contains("MISSING  inv.sum"), "{}", gone.out);
}

#[test]
fn concurrent_runs_keep_one_chain_and_a_broken_log_can_be_repaired() {
    let dir = project();
    with_runner(&dir);
    let runs: Vec<_> = (0..6)
        .map(|_| {
            clean(&mut Command::new(env!("CARGO_BIN_EXE_vibloom")))
                .arg("run")
                .current_dir(&dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn")
        })
        .collect();
    for mut r in runs {
        r.wait().expect("wait");
    }
    assert_eq!(cli(&dir, &["verify"]).out, "6 runs, chain intact.");

    // Someone edits run 4 by hand: runs 1 to 3 still verify, the rest do not.
    let path = dir.join(".vibloom/local/log.jsonl");
    let text = fs::read_to_string(&path).expect("log");
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    lines[3] = lines[3].replace("\"fail\"", "\"pass\"");
    fs::write(&path, lines.join("\n") + "\n").expect("write");
    assert_eq!(cli(&dir, &["verify"]).code, 1);
    let stuck = cli(&dir, &["run"]);
    assert!(stuck.err.contains("vibloom repair"), "{}", stuck.err);
    assert_eq!(cli(&dir, &["repair"]).code, 2);
    let repaired = vibloom(&dir, &["repair"], "", true);
    assert!(
        repaired
            .out
            .starts_with("Kept 3 verified runs; moved 3 unverified lines"),
        "{}",
        repaired.out
    );
    assert_eq!(cli(&dir, &["verify"]).out, "3 runs, chain intact.");
    assert!(cli(&dir, &["run"]).out.starts_with("Run 4:"));
}

#[test]
fn rejects_mistyped_map_keys_and_options() {
    let dir = project();
    with_runner(&dir);
    // The invariant is broken: `run` says so in its exit code.
    assert_eq!(cli(&dir, &["run"]).code, 1);
    let before = fs::read_to_string(dir.join(".vibloom/local/log.jsonl")).expect("log");

    // A mistyped option is not handed to the runner, and records nothing.
    let bad = cli(&dir, &["run", "--mt", "x"]);
    assert_eq!(bad.code, 2);
    assert!(bad.err.contains("go after `--`"), "{}", bad.err);
    assert!(cli(&dir, &["run", "--help"]).out.starts_with("vibloom:"));
    assert_eq!(
        fs::read_to_string(dir.join(".vibloom/local/log.jsonl")).expect("log"),
        before
    );
    assert!(
        cli(&dir, &["run", "--", "--mt", "x"])
            .out
            .starts_with("Run 2:")
    );

    let j: Value = serde_json::from_str(&cli(&dir, &["status", "--json"]).out).expect("json");
    assert_eq!(j["nodes"][0]["id"], "inv.sum");
    assert_eq!(j["nodes"][0]["state"], "BROKEN");
    assert_eq!(j["nodes"][0]["needs_attention"], true);

    edit_map(&dir, |m| m["nodes"][0]["wach"] = json!(["src/"]));
    let typo = cli(&dir, &["status"]);
    assert_eq!(typo.code, 2);
    assert!(
        typo.err.contains("inv.sum: unknown key \"wach\""),
        "{}",
        typo.err
    );
}

#[test]
fn ignored_files_in_a_watched_folder_do_not_count_as_changes() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    git(&dir, &["init", "-q"]);
    fs::write(dir.join(".gitignore"), "src/cache/\n*.pyc\n").expect("write");
    edit_map(&dir, |m| m["nodes"][0]["watch"] = json!(["src/"]));
    assert_eq!(cli(&dir, &["check"]).code, 0);

    // Build output the project ignores appears after the run.
    fs::create_dir_all(dir.join("src/cache")).expect("dir");
    fs::write(dir.join("src/cache/a.json"), "{}").expect("write");
    fs::write(dir.join("src/C.pyc"), "x").expect("write");
    assert_eq!(cli(&dir, &["status"]).code, 0);

    // A new source file is a change, tracked or not.
    fs::write(dir.join("src/New.sol"), "contract N { }").expect("write");
    let s = cli(&dir, &["status"]);
    assert_eq!(s.code, 1);
    assert!(s.out.contains("pending review"), "{}", s.out);
}

fn read_map(dir: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(dir.join(".vibloom/roots.json")).expect("map"))
        .expect("json")
}

#[test]
fn init_guards_what_an_invariant_test_leans_on() {
    let dir = project();
    fs::create_dir_all(dir.join("test/handlers")).expect("dir");
    fs::write(dir.join("foundry.toml"), "[profile.default]\n").expect("write");
    fs::write(
        dir.join("test/C.t.sol"),
        "import {H} from \"./handlers/H.sol\";\ncontract CT { function invariant_sum() public {} }",
    )
    .expect("write");
    fs::write(dir.join("test/handlers/H.sol"), "contract H {}").expect("write");
    // No forge at all: the imports are read from the text, and it says so.
    let o = clean(&mut Command::new(env!("CARGO_BIN_EXE_vibloom")))
        .arg("init")
        .current_dir(&dir)
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &dir)
        .stdin(Stdio::null())
        .output()
        .expect("run");
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    assert!(out.contains("1 invariant tests found"), "{out}");
    assert!(out.contains("Imports read from the source text"), "{out}");
    let m = read_map(&dir);
    assert_eq!(m["protect"], json!(["foundry.toml", "test/handlers/H.sol"]));
    assert_eq!(m["nodes"][0]["watch"], json!(["src/", "test/"]));

    // The handler is guarded like the test itself.
    let input = json!({ "cwd": dir, "tool_name": "Edit",
        "tool_input": { "file_path": dir.join("test/handlers/H.sol") } })
    .to_string();
    assert!(
        vibloom(&dir, &["hook", "pre-tool"], &input, false)
            .out
            .contains("deny")
    );
}

#[test]
fn sets_up_another_stack_and_adds_nodes_by_hand() {
    let dir = project();
    fs::write(dir.join("pyproject.toml"), "[project]\nname = \"x\"\n").expect("write");
    let out = cli(&dir, &["init"]).out;
    assert!(out.contains("runner `pytest -q --junitxml="), "{out}");
    let m = read_map(&dir);
    assert_eq!(m["report"], ".pytest_cache/vibloom-junit.xml");
    assert_eq!(m["tests"], "tests/");
    assert_eq!(cli(&dir, &["init", "--stack", "cobol"]).code, 2);

    let add = ["add", "invariant", "a balance never goes negative"];
    let test = [
        "--file",
        "tests/test_vault.py",
        "--test",
        "test_never_negative",
    ];
    let refused = cli(&dir, &[&add[..], &test[..]].concat());
    assert_eq!(refused.code, 2);
    assert!(
        refused.err.contains("a decision for the person"),
        "{}",
        refused.err
    );
    assert!(
        refused
            .err
            .contains("CLAUDECODE is set: Claude Code is running this command"),
        "{}",
        refused.err
    );
    assert!(
        refused.err.ends_with(
            "in their own terminal: vibloom add invariant 'a balance never goes negative' --file tests/test_vault.py --test test_never_negative"
        ),
        "{}",
        refused.err
    );
    let no_test = vibloom(&dir, &add, "", true);
    assert!(
        no_test.err.contains("an invariant needs a test"),
        "{}",
        no_test.err
    );
    let added = vibloom(&dir, &[&add[..], &test[..]].concat(), "", true);
    assert_eq!(
        added.out,
        "Added inv.a-balance-never-goes-negative (adopted)."
    );
    let on = ["--on", "inv.a-balance-never-goes-negative"];
    let intent = ["add", "intention", "withdraw caps at the balance"];
    assert_eq!(
        vibloom(&dir, &[&intent[..], &on[..]].concat(), "", true).out,
        "Added int.withdraw-caps-at-the-balance (adopted).\nint.withdraw-caps-at-the-balance rests on inv.a-balance-never-goes-negative: if inv.a-balance-never-goes-negative fails, int.withdraw-caps-at-the-balance is at risk."
    );
    // One rule: an assumption is hypothetical until someone adopts it.
    let asm = ["add", "assumption", "the oracle is fresh"];
    assert_eq!(
        vibloom(&dir, &asm, "", true).out,
        "Added asm.the-oracle-is-fresh (hypothetical: not yet reviewed; `vibloom edit asm.the-oracle-is-fresh --stance adopted` adopts it)."
    );
    assert_eq!(
        vibloom(
            &dir,
            &[&asm[..], &["--id", "asm.adopted", "--adopted"][..]].concat(),
            "",
            true
        )
        .out,
        "Added asm.adopted (adopted)."
    );
    assert_eq!(
        vibloom(
            &dir,
            &[&intent[..], &["--id", "int.maybe", "--hypothetical"][..]].concat(),
            "",
            true
        )
        .out,
        "Added int.maybe (hypothetical: not yet reviewed; `vibloom edit int.maybe --stance adopted` adopts it)."
    );
    let both = vibloom(
        &dir,
        &[&asm[..], &["--adopted", "--hypothetical"][..]].concat(),
        "",
        true,
    );
    assert_eq!(both.code, 2);
    assert!(both.err.contains("not both"), "{}", both.err);
    let unknown = vibloom(
        &dir,
        &["add", "assumption", "x", "--on", "inv.nope"],
        "",
        true,
    );
    assert!(
        unknown.err.starts_with("No node inv.nope."),
        "{}",
        unknown.err
    );
    // A typo anywhere an id is taken gets the nearest ones.
    for args in [
        &["add", "x", "--on", "inv.a-balance-never-goes-negativ"][..],
        &["edit", "inv.a-balance-never-goes-negativ", "--title", "t"],
        &[
            "edit",
            "asm.the-oracle-is-fresh",
            "--on",
            "inv.a-balance-never-goes-negativ",
        ],
        &["remove", "inv.a-balance-never-goes-negativ"],
    ] {
        let typo = vibloom(&dir, args, "", true);
        assert_eq!(typo.code, 2, "{args:?}");
        assert!(
            typo.err.contains(
                "No node inv.a-balance-never-goes-negativ. Did you mean inv.a-balance-never-goes-negative?"
            ),
            "{}",
            typo.err
        );
    }
    // A title alone is an assumption, and the edge is said in one phrase.
    let plain = vibloom(
        &dir,
        &[
            "add",
            "deposits never round up",
            "--on",
            "inv.a-balance-never-goes-negative",
        ],
        "",
        true,
    );
    assert_eq!(
        plain.out,
        "Added asm.deposits-never-round-up (hypothetical: not yet reviewed; `vibloom edit asm.deposits-never-round-up --stance adopted` adopts it).\nasm.deposits-never-round-up rests on inv.a-balance-never-goes-negative: if inv.a-balance-never-goes-negative fails, asm.deposits-never-round-up is at risk."
    );
    assert_eq!(
        vibloom(&dir, &["remove", "asm.deposits-never-round-up"], "", true).code,
        0
    );

    let m = read_map(&dir);
    assert_eq!(m["nodes"][0]["watch"], json!(["src/", "tests/"]));
    assert_eq!(m["nodes"][0]["protected"], true);
    assert_eq!(m["nodes"][1]["depends_on"], json!(on[1..]));
    // Nothing ran yet, so nothing holds.
    let status = cli(&dir, &["status"]);
    assert_eq!(status.code, 1);
    assert!(status.out.contains("untested"), "{}", status.out);
}

#[test]
fn installs_the_commit_check_once() {
    let dir = project();
    with_runner(&dir);
    assert_eq!(cli(&dir, &["install-hook"]).code, 2);
    git(&dir, &["init", "-q"]);
    assert!(
        cli(&dir, &["install-hook"])
            .out
            .starts_with("Installed the commit check")
    );
    let hook = fs::read_to_string(dir.join(".git/hooks/pre-commit")).expect("hook");
    assert!(hook.starts_with("#!/bin/sh") && hook.contains("exec vibloom precommit"));
    assert_eq!(
        cli(&dir, &["install-hook"]).out,
        "The commit check is already installed."
    );
    fs::write(dir.join(".git/hooks/pre-commit"), "#!/bin/sh\nnpm test\n").expect("write");
    let other = cli(&dir, &["install-hook"]);
    assert_eq!(other.code, 2);
    assert!(other.err.contains("Add this line to it"), "{}", other.err);
}

#[test]
fn unreviewed_assumptions_are_shown_and_count_only_when_strict() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    edit_map(&dir, |m| {
        let nodes = m["nodes"].as_array_mut().expect("nodes");
        nodes.push(
            json!({ "id": "asm.a", "kind": "assumption", "title": "a", "depends_on": ["inv.sum"] }),
        );
        nodes.push(json!({ "id": "asm.b", "kind": "assumption", "title": "b" }));
        nodes.push(json!({ "id": "int.x", "kind": "intention", "title": "x", "depends_on": ["asm.a", "asm.b"] }));
    });
    let r = cli(&dir, &["check"]);
    assert_eq!(r.code, 0, "{}", r.out);
    for want in [
        "4 nodes, 0 need attention, 2 not yet reviewed.",
        "adopted (rests on 2 unreviewed)  int.x",
        "Not yet reviewed (yours to decide: adopt it or switch it off):",
        "- asm.a: vibloom edit asm.a --stance adopted   (or --stance off)",
    ] {
        assert!(r.out.contains(want), "{want}: {}", r.out);
    }
    let strict = cli(&dir, &["check", "--strict"]);
    assert_eq!(strict.code, 1);
    assert!(
        strict
            .out
            .contains("4 nodes, 3 need attention, 2 not yet reviewed."),
        "{}",
        strict.out
    );
    assert_eq!(cli(&dir, &["status", "--strict"]).code, 1);
    edit_map(&dir, |m| m["strict"] = json!(true));
    let j: Value = serde_json::from_str(&cli(&dir, &["status", "--json"]).out).expect("json");
    assert_eq!(j["exit"], 1);
    assert_eq!(
        j["summary"],
        json!({ "nodes": 4, "need_attention": 3, "not_yet_reviewed": 2, "accepted_risks": 0, "strict": true })
    );
    let x = &j["nodes"][3];
    assert_eq!(x["id"], "int.x");
    assert_eq!(x["state"], "adopted");
    assert_eq!(x["shown"], "adopted (rests on 2 unreviewed)");
    assert_eq!(x["troubled"], false);
    assert_eq!(x["needs_attention"], true);
    assert_eq!(x["rests_on_unreviewed"], json!(["asm.a", "asm.b"]));
    assert_eq!(
        j["nodes"][0]["files"],
        json!(["test/C.t.sol", "src/", "test/"])
    );
    assert_eq!(
        j["not_yet_reviewed"][0]["adopt"],
        "vibloom edit asm.a --stance adopted"
    );
    assert_eq!(j["guard"], Value::Null);
    assert_eq!(j["tool_error"], Value::Null);
    fs::write(dir.join("src/C.sol"), "contract C { /* bug */ }").expect("write");
    let gh = cli(&dir, &["check", "--format", "github"]);
    assert!(
        gh.out.contains(
            "::error file=test/C.t.sol,line=1,title=VIBloom inv.sum [BROKEN]::invariant_sum: failure: drift"
        ),
        "{}",
        gh.out
    );
    assert!(
        gh.out
            .contains("::error title=VIBloom asm.b [hypothetical]::b: not yet reviewed (strict)"),
        "{}",
        gh.out
    );
    // Tool failures are 2, with the reason in the JSON.
    fs::remove_file(dir.join(".vibloom/roots.json")).expect("rm");
    let none = cli(&dir, &["check", "--json"]);
    assert_eq!(none.code, 2);
    let j: Value = serde_json::from_str(&none.out).expect("json");
    assert!(
        j["tool_error"]
            .as_str()
            .unwrap_or_default()
            .contains("No .vibloom/roots.json")
    );
}

#[test]
fn sync_is_gone_and_says_why() {
    let dir = project();
    with_runner(&dir);
    let r = cli(&dir, &["sync", "--base", "main"]);
    assert_eq!(r.code, 2);
    assert!(r.err.contains("the run log is local"), "{}", r.err);
}

#[test]
fn a_project_in_a_folder_of_a_larger_repository_keeps_to_itself() {
    let repo = project();
    git(&repo, &["init", "-q"]);
    let dir = repo.join("contracts");
    fs::create_dir_all(dir.join("src")).expect("dir");
    fs::create_dir_all(dir.join("test")).expect("dir");
    fs::write(dir.join("src/C.sol"), "contract C { /* bug */ }").expect("write");
    fs::write(
        dir.join("test/C.t.sol"),
        "contract CT { function invariant_sum() public {} }",
    )
    .expect("write");
    fs::write(dir.join("runner.sh"), RUNNER).expect("write");

    // init does not take over the hooks of the repository it sits in.
    let out = cli(&dir, &["init"]).out;
    assert!(out.contains("inside a larger repository"), "{out}");
    assert!(!repo.join(".git/hooks/pre-commit").exists());
    edit_map(&dir, |m| m["runner"] = json!(["sh", "runner.sh"]));

    // Asked for, the check goes to the project's folder before it runs.
    assert_eq!(cli(&dir, &["install-hook"]).code, 0);
    let hook = fs::read_to_string(repo.join(".git/hooks/pre-commit")).expect("hook");
    assert!(hook.contains("cd \"contracts\" || exit 1"), "{hook}");

    // The invariant is broken, but this commit touches nothing of the project.
    assert_eq!(cli(&dir, &["check"]).code, 1);
    fs::write(repo.join("NOTES.md"), "unrelated").expect("write");
    git(&repo, &["add", "NOTES.md"]);
    assert_eq!(cli(&dir, &["precommit"]).code, 0);
    // One that does is judged.
    git(&repo, &["add", "contracts/src/C.sol"]);
    let refused = cli(&dir, &["precommit"]);
    assert_eq!(refused.code, 1);
    assert!(refused.err.contains("inv.sum [BROKEN]"), "{}", refused.err);
}

#[test]
fn stops_a_runner_that_hangs() {
    let dir = project();
    with_runner(&dir);
    edit_map(&dir, |m| {
        m["runner"] = json!(["sleep", "30"]);
        m["timeout"] = json!(1);
    });
    let started = std::time::Instant::now();
    let r = cli(&dir, &["check"]);
    assert!(started.elapsed().as_secs() < 10);
    assert_eq!(r.code, 2);
    assert!(r.err.contains("did not finish in 1 s"), "{}", r.err);
}

#[test]
fn connects_claude_code_and_codex_and_guards_their_settings() {
    let dir = project();
    git(&dir, &["init", "-q"]);
    // Settings the person already had are kept.
    fs::create_dir_all(dir.join(".claude")).expect("dir");
    fs::write(
        dir.join(".claude/settings.json"),
        r#"{"permissions":{"allow":["Bash(forge build)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo bye"}]}]}}"#,
    )
    .expect("write");
    let out = cli(&dir, &["init", "--agent", "claude", "--agent", "codex"]).out;
    assert!(
        out.contains("hooks added to .claude/settings.json"),
        "{out}"
    );
    assert!(out.contains("Installed the commit check"), "{out}");
    assert!(
        out.contains("codex mcp add vibloom -- vibloom mcp"),
        "{out}"
    );

    let read = |f: &str| -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(f)).expect("file")).expect("json")
    };
    let settings = read(".claude/settings.json");
    assert_eq!(settings["permissions"]["allow"][0], "Bash(forge build)");
    assert_eq!(settings["hooks"]["Stop"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
        "vibloom hook pre-tool"
    );
    assert_eq!(
        read(".mcp.json")["mcpServers"]["vibloom"]["args"],
        json!(["mcp"])
    );
    let agents = fs::read_to_string(dir.join("AGENTS.md")).expect("agents");
    assert!(agents.contains("`vibloom context <file>`"));

    // The builder cannot switch the guard off by editing the agent's settings.
    assert!(
        read(".vibloom/roots.json")["protect"]
            .as_array()
            .is_some_and(|p| p.contains(&json!("AGENTS.md"))),
        "AGENTS.md is guarded"
    );
    for f in [
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".mcp.json",
        "AGENTS.md",
    ] {
        let input = json!({ "cwd": dir, "tool_name": "Edit",
            "tool_input": { "file_path": dir.join(f) } })
        .to_string();
        assert!(
            vibloom(&dir, &["hook", "pre-tool"], &input, false)
                .out
                .contains("deny"),
            "{f}"
        );
    }

    // Running it again changes nothing.
    assert_eq!(cli(&dir, &["setup", "claude"]).code, 2);
    let again = vibloom(&dir, &["setup", "claude"], "", true).out;
    assert!(
        again.contains("already in .claude/settings.json"),
        "{again}"
    );
    vibloom(&dir, &["setup", "codex"], "", true);
    assert_eq!(read(".claude/settings.json"), settings);
    assert_eq!(
        fs::read_to_string(dir.join("AGENTS.md")).expect("agents"),
        agents
    );
    assert_eq!(vibloom(&dir, &["setup", "cursor"], "", true).code, 2);
}

#[test]
fn tells_the_agent_once_that_an_edit_put_a_node_up_for_review() {
    let dir = project();
    with_runner(&dir);
    edit_map(&dir, |m| m["nodes"][0]["watch"] = json!(["src/"]));
    cli(&dir, &["run"]);
    let edit = json!({ "cwd": dir, "tool_name": "Edit",
        "tool_input": { "file_path": dir.join("src/C.sol") } })
    .to_string();
    let first = vibloom(&dir, &["hook", "post-tool"], &edit, false).out;
    assert!(first.contains("src/C.sol is watched by inv.sum"), "{first}");
    assert_eq!(vibloom(&dir, &["hook", "post-tool"], &edit, false).out, "");
    // A new run starts over.
    cli(&dir, &["run"]);
    assert!(
        vibloom(&dir, &["hook", "post-tool"], &edit, false)
            .out
            .contains("watched by")
    );
}

#[test]
fn an_invariant_whose_every_call_reverted_fails_the_check() {
    let dir = project();
    with_runner(&dir);
    let report = |reverts: u32| {
        format!(
            "printf '%s\\n' '{{\"test/C.t.sol:CT\":{{\"test_results\":{{\"invariant_sum()\":{{\"status\":\"Success\",\"reason\":null,\"kind\":{{\"Invariant\":{{\"runs\":64,\"calls\":2048,\"reverts\":{reverts}}}}}}}}}}}}}'\n"
        )
    };
    fs::write(dir.join("runner.sh"), report(12)).expect("write");
    assert_eq!(cli(&dir, &["check"]).code, 0);
    let j: Value = serde_json::from_str(&cli(&dir, &["status", "--json"]).out).expect("json");
    assert_eq!(
        j["nodes"][0]["fuzz"],
        json!({ "runs": 64, "calls": 2048, "reverts": 12 })
    );

    fs::write(dir.join("runner.sh"), report(2048)).expect("write");
    let vacuous = cli(&dir, &["check"]);
    assert_eq!(vacuous.code, 1, "{}", vacuous.out);
    assert!(
        vacuous.out.contains("VACUOUS, fuzzed 64x32  inv.sum"),
        "{}",
        vacuous.out
    );
    assert!(
        cli(&dir, &["context"])
            .out
            .contains("all 2048 calls reverted"),
        "the agent is told why"
    );
}

#[cfg(unix)]
#[test]
fn a_reader_that_stops_early_is_not_a_crash() {
    let dir = project();
    with_runner(&dir);
    // Enough pending proposals that the list is still being written when
    // `head` has taken its line and closed the pipe.
    let many: String = (1..=400)
        .map(|i| {
            format!(
                "{}\n",
                json!({ "id": format!("p{i}"), "at": "2026-11-15T00:00:00.000Z", "kind": "assumption",
                        "title": format!("assumption number {i}"), "detail": "x".repeat(200),
                        "evidence": ["src/C.sol:1"] })
            )
        })
        .collect();
    fs::write(dir.join(".vibloom/proposals.jsonl"), many).expect("write");
    let out = Command::new("sh")
        .args(["-c", "\"$VIBLOOM\" proposals --full | head -1"])
        .env("VIBLOOM", env!("CARGO_BIN_EXE_vibloom"))
        .current_dir(&dir)
        .output()
        .expect("sh");
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("400 pending proposals."));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
}

#[test]
fn does_nothing_in_a_project_without_a_map() {
    let dir = project();
    let r = vibloom(
        &dir,
        &["hook", "pre-tool"],
        &json!({ "cwd": dir, "tool_name": "Edit" }).to_string(),
        false,
    );
    assert_eq!((r.code, r.out.as_str(), r.err.as_str()), (0, "", ""));
}

// Stands in for forge in a dapptools layout: tests in src/test/, the build
// already in out/. A shell script, so these tests run where one can.
#[cfg(unix)]
const FORGE: &str = r#"#!/bin/sh
case "$1 $2" in
  "test --list") echo '{"src/test/vat.t.sol":{"VatTest":["invariant_debt","test_frob"]}}' ;;
  "config --json") echo '{"src":"src","test":"test","script":"script","out":"out"}' ;;
esac
"#;

#[cfg(unix)]
fn dapptools() -> PathBuf {
    let dir = project();
    fs::remove_dir_all(dir.join("test")).expect("rm");
    fs::remove_file(dir.join("src/C.sol")).expect("rm");
    fs::create_dir_all(dir.join("src/test")).expect("dir");
    fs::create_dir_all(dir.join("bin")).expect("dir");
    fs::write(dir.join("bin/forge"), FORGE).expect("write");
    Command::new("chmod")
        .args(["+x", "bin/forge"])
        .current_dir(&dir)
        .status()
        .expect("chmod");
    let vat = "contract Vat {\n  function file() external {}\n  function file(uint x) external {}\n  function frob() external {}\n}\n";
    let test = "contract VatTest {\n  Vat vat;\n  function test_frob() public { vat.frob(); }\n  function invariant_debt() public {}\n}\n";
    fs::write(dir.join("src/vat.sol"), vat).expect("write");
    fs::write(dir.join("src/test/vat.t.sol"), test).expect("write");
    let func = |name: &str, at: usize| {
        json!({ "nodeType": "FunctionDefinition", "kind": "function", "name": name, "visibility": "external",
                "stateMutability": "nonpayable", "modifiers": [], "src": format!("{at}:1:0"), "body": {} })
    };
    let artifact = |path: &str, contract: &str, funcs: Vec<Value>| {
        json!({ "bytecode": { "object": "0x60" }, "abi": [],
                "ast": { "absolutePath": path, "nodes": [
                    { "nodeType": "ContractDefinition", "name": contract, "contractKind": "contract", "nodes": funcs }
                ] } })
    };
    for (folder, name, a) in [
        (
            "vat.sol",
            "Vat",
            artifact(
                "src/vat.sol",
                "Vat",
                vec![func("file", 17), func("file", 50), func("frob", 90)],
            ),
        ),
        (
            "vat.t.sol",
            "VatTest",
            artifact("src/test/vat.t.sol", "VatTest", vec![func("test_frob", 40)]),
        ),
    ] {
        fs::create_dir_all(dir.join("out").join(folder)).expect("dir");
        fs::write(
            dir.join("out").join(folder).join(format!("{name}.json")),
            a.to_string(),
        )
        .expect("write");
    }
    dir
}

#[cfg(unix)]
fn with_forge(dir: &Path, args: &[&str]) -> Out {
    let path = format!(
        "{}:{}",
        dir.join("bin").display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let o = clean(&mut Command::new(env!("CARGO_BIN_EXE_vibloom")))
        .args(args)
        .current_dir(dir)
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .expect("run");
    Out {
        code: o.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        err: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    }
}

#[cfg(unix)]
#[test]
fn finds_forge_where_foundryup_installs_it_when_the_path_lacks_it() {
    let dir = dapptools();
    let home = dir.join("home");
    fs::create_dir_all(home.join(".foundry/bin")).expect("dir");
    fs::rename(dir.join("bin/forge"), home.join(".foundry/bin/forge")).expect("move");
    let run = |home: &Path| {
        clean(&mut Command::new(env!("CARGO_BIN_EXE_vibloom")))
            .arg("init")
            .current_dir(&dir)
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", home)
            .stdin(Stdio::null())
            .output()
            .expect("run")
    };
    let out = String::from_utf8_lossy(&run(&home).stdout).into_owned();
    assert!(out.contains("1 invariant tests found"), "{out}");
}

// Forge's trees say what the test imports, remapped paths included: the
// handler is guarded and the invariant watches only what it reaches.
#[cfg(unix)]
#[test]
fn init_and_scan_read_imports_from_forge_s_syntax_trees() {
    let dir = dapptools();
    fs::write(dir.join("foundry.toml"), "[profile.default]\n").expect("write");
    fs::write(dir.join("src/other.sol"), "contract Other {}\n").expect("write");
    fs::write(dir.join("src/test/H.sol"), "contract H {}\n").expect("write");
    let artifact = |path: &str, imports: &[&str]| {
        let nodes: Vec<Value> = imports
            .iter()
            .map(|i| json!({ "nodeType": "ImportDirective", "absolutePath": i }))
            .collect();
        json!({ "abi": [], "ast": { "absolutePath": path, "nodes": nodes } })
    };
    for (folder, name, a) in [
        // "handlers/H.sol" through a remapping; no relative import names it.
        (
            "vat.t.sol",
            "VatTest",
            artifact(
                "src/test/vat.t.sol",
                &["lib/ds-test/src/test.sol", "src/test/H.sol", "src/vat.sol"],
            ),
        ),
        ("H.sol", "H", artifact("src/test/H.sol", &["src/vat.sol"])),
    ] {
        fs::create_dir_all(dir.join("out").join(folder)).expect("dir");
        fs::write(
            dir.join("out").join(folder).join(format!("{name}.json")),
            a.to_string(),
        )
        .expect("write");
    }
    let out = with_forge(&dir, &["init"]);
    assert!(out.out.contains("from forge's syntax trees"), "{}", out.out);
    let m = read_map(&dir);
    assert_eq!(
        m["nodes"][0]["watch"],
        json!(["src/test/H.sol", "src/vat.sol"])
    );
    assert_eq!(m["protect"], json!(["foundry.toml", "src/test/H.sol"]));
    // A change to a source the invariant never imports leaves it alone.
    edit_map(&dir, |m| {
        m["runner"] = json!([
            "sh",
            "-c",
            "echo '{\"src/test/vat.t.sol:VatTest\":{\"test_results\":{\"invariant_debt()\":{\"status\":\"Success\",\"reason\":null}}}}'"
        ])
    });
    assert_eq!(cli(&dir, &["run"]).code, 0);
    fs::write(dir.join("src/other.sol"), "contract Other { uint x; }\n").expect("write");
    assert_eq!(cli(&dir, &["status"]).code, 0);

    // An older map that watches whole folders is only narrowed when asked.
    edit_map(&dir, |m| {
        m["runner"] = json!(["forge", "test", "--json"]);
        m["nodes"][0]["watch"] = json!(["src/", "src/test/"]);
    });
    let plan = with_forge(&dir, &["scan"]);
    assert!(
        plan.out
            .contains("Would tighten what these watch, to the files their tests import:\n- inv.debt: src/, src/test/ -> src/test/H.sol, src/vat.sol"),
        "{}",
        plan.out
    );
    assert_eq!(
        read_map(&dir)["nodes"][0]["watch"],
        json!(["src/", "src/test/"])
    );
    let done = with_forge(&dir, &["scan", "--tighten"]);
    assert!(
        done.out.contains("Tightened what these watch"),
        "{}",
        done.out
    );
    assert_eq!(
        read_map(&dir)["nodes"][0]["watch"],
        json!(["src/test/H.sol", "src/vat.sol"])
    );
}

#[cfg(unix)]
#[test]
fn init_finds_tests_kept_next_to_the_sources() {
    let dir = dapptools();
    let out = with_forge(&dir, &["init"]);
    assert!(out.out.contains("1 invariant tests found"), "{}", out.out);
    let m = read_map(&dir);
    assert_eq!(m["tests"], "src/test/");
    assert_eq!(m["nodes"][0]["test"]["file"], "src/test/vat.t.sol");
    assert_eq!(m["nodes"][0]["watch"], json!(["src/", "src/test/"]));
}

#[cfg(unix)]
#[test]
fn survey_and_gaps_leave_test_code_out_and_read_it_as_tests() {
    let dir = dapptools();
    assert_eq!(with_forge(&dir, &["init"]).code, 0);
    // Even with the tests folder set elsewhere, src/test/ is test code.
    edit_map(&dir, |m| m["tests"] = json!("test/"));
    let survey = with_forge(&dir, &["survey"]);
    assert_eq!(survey.code, 0, "{}", survey.err);
    assert!(survey.out.contains("Vat (src/vat.sol)"), "{}", survey.out);
    assert!(!survey.out.contains("VatTest"), "{}", survey.out);
    let gaps = with_forge(&dir, &["gaps"]);
    assert_eq!(gaps.code, 0, "{}", gaps.err);
    assert!(
        gaps.out.contains("- Vat (src/vat.sol): file\n"),
        "{}",
        gaps.out
    );
    assert!(!gaps.out.contains("VatTest"), "{}", gaps.out);
}

#[test]
fn init_in_a_folder_without_sources_or_tests_says_so_and_still_succeeds() {
    let dir = project();
    fs::remove_dir_all(dir.join("src")).expect("rm");
    fs::remove_dir_all(dir.join("test")).expect("rm");
    let out = cli(&dir, &["init"]);
    assert_eq!(out.code, 0, "{}", out.err);
    assert!(
        out.out
            .contains("Found no source folder (src/) and no tests (test/) here"),
        "{}",
        out.out
    );
    assert!(
        out.out.contains("at the root of the project"),
        "{}",
        out.out
    );
    assert!(dir.join(".vibloom/roots.json").is_file());
    // A project with its folders gets no such warning.
    let full = project();
    assert!(!cli(&full, &["init"]).out.contains("Found no source folder"));
}

fn hook(dir: &Path, event: &str, input: Value) -> Value {
    let out = vibloom(dir, &["hook", event], &input.to_string(), false).out;
    if out.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&out).expect("json")
    }
}

#[test]
fn a_map_that_cannot_be_read_keeps_the_guard_closed() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join(".vibloom/roots.json"), "{ broken").expect("write");
    let edit = json!({ "cwd": dir, "tool_name": "Edit",
        "tool_input": { "file_path": dir.join("test/C.t.sol") } });
    let out = hook(&dir, "pre-tool", edit);
    assert_eq!(
        out["hookSpecificOutput"]["permissionDecision"], "deny",
        "{out}"
    );
    let read =
        json!({ "cwd": dir, "tool_name": "Bash", "tool_input": { "command": "cat src/C.sol" } });
    assert_eq!(hook(&dir, "pre-tool", read), json!({}));
    let stop = hook(&dir, "stop", json!({ "cwd": dir }));
    assert_eq!(stop["decision"], "block", "{stop}");
    let again = hook(
        &dir,
        "stop",
        json!({ "cwd": dir, "stop_hook_active": true }),
    );
    assert!(again.get("decision").is_none(), "{again}");
}

#[test]
fn the_persons_notes_are_kept_from_the_builder_and_committed_by_the_verifier() {
    let dir = project();
    with_runner(&dir);
    git(&dir, &["init", "-q"]);
    let write = json!({ "cwd": dir, "tool_name": "Write",
        "tool_input": { "file_path": dir.join(".vibloom/notes.md"), "content": "x" } });
    assert_eq!(
        hook(&dir, "pre-tool", write)["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    assert_eq!(cli(&dir, &["run"]).code, 0);
    fs::write(
        dir.join(".vibloom/notes.md"),
        "Nobody takes out more than they put in.",
    )
    .expect("write");
    git(&dir, &["add", ".vibloom/notes.md"]);
    let builder = cli(&dir, &["precommit"]);
    assert_eq!(builder.code, 1);
    assert!(
        builder.err.contains(".vibloom/notes.md is guarded"),
        "{}",
        builder.err
    );
    assert_eq!(vibloom(&dir, &["precommit"], "", true).code, 0);
}

#[cfg(unix)]
#[test]
fn survey_rebuilds_syntax_trees_that_a_test_run_left_out() {
    let dir = dapptools();
    assert_eq!(with_forge(&dir, &["init"]).code, 0);
    // As after `forge test` recompiled vat.sol: the artifact has no tree, and
    // a plain `forge build --ast` finds nothing to do.
    let art = dir.join("out/vat.sol/Vat.json");
    let full = fs::read_to_string(&art).expect("artifact");
    fs::write(dir.join("Vat.full.json"), &full).expect("write");
    let mut bare: Value = serde_json::from_str(&full).expect("json");
    bare.as_object_mut().expect("object").remove("ast");
    fs::write(&art, bare.to_string()).expect("write");
    let forge = FORGE.replace(
        "esac",
        "  \"build --ast\") [ \"$3\" = --force ] && cp Vat.full.json out/vat.sol/Vat.json ;;\nesac",
    );
    fs::write(dir.join("bin/forge"), forge).expect("write");
    let survey = with_forge(&dir, &["survey"]);
    assert_eq!(survey.code, 0, "{}", survey.err);
    assert!(survey.out.contains("Vat (src/vat.sol)"), "{}", survey.out);
}

#[test]
fn watched_folders_are_written_the_way_the_map_compares_them() {
    let dir = project();
    with_runner(&dir);
    let add = vibloom(
        &dir,
        &[
            "add",
            "assumption",
            "only add moves total",
            "--on",
            "inv.sum",
            "--watch",
            "src",
        ],
        "",
        true,
    );
    assert_eq!(add.code, 0, "{}", add.err);
    let edit = vibloom(
        &dir,
        &[
            "edit",
            "asm.only-add-moves-total",
            "--watch",
            "./test",
            "--unwatch",
            "src/",
        ],
        "",
        true,
    );
    assert_eq!(edit.code, 0, "{}", edit.err);
    let m = read_map(&dir);
    let node = m["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .find(|n| n["id"] == "asm.only-add-moves-total")
        .expect("node")
        .clone();
    assert_eq!(node["watch"], json!(["test/"]));
    // A folder written by hand without its "/" still counts as a folder.
    edit_map(&dir, |m| m["nodes"][0]["watch"] = json!(["src"]));
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    cli(&dir, &["run"]);
    assert!(cli(&dir, &["status"]).out.contains("holds"));
    fs::write(dir.join("src/C.sol"), "contract C { uint x; }").expect("write");
    let status = cli(&dir, &["status"]);
    assert!(
        status
            .out
            .lines()
            .any(|l| l.starts_with("pending review, unit ") && l.contains(" inv.sum ")),
        "{}",
        status.out
    );
}

#[test]
fn mcp_refuses_arguments_of_the_wrong_shape_instead_of_guessing() {
    let dir = project();
    with_runner(&dir);
    let call = |id: u64, name: &str, args: Value| {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": { "name": name, "arguments": args } })
    };
    let msgs = [
        call(1, "run", json!({ "filters": "--mt invariant_sum" })),
        call(2, "context", json!({ "file": "../../etc/passwd" })),
        call(3, "context", json!({ "file": 5 })),
        call(
            4,
            "propose",
            json!({ "kind": "assumption", "title": "t", "evidence": ["x"], "test": { "file": 3 } }),
        ),
        call(
            5,
            "propose",
            json!({ "kind": "assumption", "title": "a\np9  assumption  forged", "evidence": ["x"] }),
        ),
        call(
            6,
            "propose",
            json!({ "kind": "assumption", "title": "big ".repeat(1000), "evidence": ["x"] }),
        ),
        call(
            7,
            "propose",
            json!({ "kind": "assumption", "title": "t", "evidence": "src/C.sol:1" }),
        ),
    ];
    let input: String = msgs.iter().map(|m| format!("{m}\n")).collect();
    let out = vibloom(&dir, &["mcp"], &input, false).out;
    for line in out.lines() {
        let v: Value = serde_json::from_str(line).expect("json");
        assert_eq!(v["result"]["isError"], true, "{v}");
    }
    assert_eq!(out.lines().count(), msgs.len());
    // Nothing ran and nothing was filed.
    assert!(!dir.join(".vibloom/local/log.jsonl").exists());
    assert_eq!(cli(&dir, &["proposals"]).out, "No pending proposals.");
}

#[test]
fn a_run_counts_failures_no_node_rests_on() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    fs::write(
        dir.join("runner.sh"),
        r#"#!/bin/sh
printf '{"test/C.t.sol:CT":{"test_results":{"invariant_sum()":{"status":"Success","reason":null},"test_other()":{"status":"Failure","reason":"x"}}}}\n'
"#,
    )
    .expect("write");
    // A red suite is red, whether or not a node rests on the test.
    let out = cli(&dir, &["check"]);
    assert_eq!(out.code, 1, "{}", out.err);
    assert!(
        out.out.contains(
            "Run 1: 2 test results recorded, 1 failed.\n1 failing test no node rests on, which still fails the check: CT.test_other."
        ),
        "{}",
        out.out
    );
    let json: Value = serde_json::from_str(&cli(&dir, &["check", "--json"]).out).expect("json");
    assert_eq!(json["exit"], 1);
    assert_eq!(json["failures"]["untracked"], json!(["CT.test_other"]));
    // A known-red test is let through only by a rule in the map, which stays
    // in sight.
    edit_map(&dir, |m| m["ignore_failures"] = json!(["CT.test_o*"]));
    let ignored = cli(&dir, &["check"]);
    assert_eq!(ignored.code, 0, "{}", ignored.out);
    assert!(
        ignored
            .out
            .contains("Ignoring 1 failing test by rule (ignore_failures in the map)."),
        "{}",
        ignored.out
    );
    let status = cli(&dir, &["status"]);
    assert!(
        status.out.ends_with(
            "Ignoring 1 failing test by rule (in the latest run; ignore_failures: CT.test_o*)."
        ),
        "{}",
        status.out
    );
    let json: Value = serde_json::from_str(&cli(&dir, &["status", "--json"]).out).expect("json");
    assert_eq!(json["failures"]["ignored"], json!(["CT.test_other"]));
    assert_eq!(json["ignore_failures"], json!(["CT.test_o*"]));
}

#[test]
fn says_what_to_do_outside_the_project_or_a_repository() {
    let dir = project();
    with_runner(&dir);
    let precommit = cli(&dir, &["precommit"]);
    assert_eq!(precommit.code, 2);
    assert!(
        precommit.err.starts_with("Not a git repository"),
        "{}",
        precommit.err
    );
    assert!(precommit.err.lines().count() == 1, "{}", precommit.err);
    let outside = cli(&dir, &["context", "/etc/passwd"]);
    assert_eq!(outside.code, 2);
    assert!(
        outside.err.contains("outside the project"),
        "{}",
        outside.err
    );
    let again = cli(&dir, &["init"]);
    assert!(again.err.contains("vibloom setup claude"), "{}", again.err);
}

#[test]
fn decides_a_proposal_once_and_says_when_its_id_was_taken() {
    let dir = project();
    with_runner(&dir);
    let propose = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "propose",
        "arguments": { "kind": "assumption", "title": "total only grows", "evidence": ["src/C.sol:1"], "id": "asm.grows" } } });
    vibloom(&dir, &["mcp"], &format!("{propose}\n"), false);
    let added = vibloom(
        &dir,
        &["add", "assumption", "taken", "--id", "asm.grows"],
        "",
        true,
    );
    assert_eq!(added.code, 0, "{}", added.err);
    let accepted = vibloom(&dir, &["proposals", "accept", "p1", "p1"], "", true);
    assert_eq!(accepted.code, 0, "{}", accepted.err);
    assert_eq!(
        accepted.out,
        "Accepted p1 as asm.total-only-grows (hypothetical; asm.grows is already in use).\nCreated 1 node in the map; 1 starts hypothetical (not yet reviewed) until you adopt it with `vibloom edit <id> --stance adopted` or switch it off."
    );
}

#[cfg(unix)]
#[test]
fn survey_does_not_file_again_what_the_verifier_rejected() {
    let dir = dapptools();
    assert_eq!(with_forge(&dir, &["init"]).code, 0);
    let art = dir.join("out/vat.sol/Vat.json");
    let mut a: Value =
        serde_json::from_str(&fs::read_to_string(&art).expect("artifact")).expect("json");
    a["ast"]["nodes"][0]["nodes"][2]["modifiers"] =
        json!([{ "modifierName": { "name": "auth" }, "arguments": [] }]);
    fs::write(&art, a.to_string()).expect("write");
    let first = with_forge(&dir, &["survey", "--propose"]);
    assert!(
        first
            .out
            .starts_with("Filed 1 proposal, all assumptions: Vat 1."),
        "{}",
        first.out
    );
    assert_eq!(with_forge(&dir, &["proposals", "reject", "p1"]).code, 0);
    let again = with_forge(&dir, &["survey", "--propose"]);
    assert!(
        again.out.contains("Filed no new proposals"),
        "{}",
        again.out
    );
    assert_eq!(cli(&dir, &["proposals"]).out, "No pending proposals.");
}

fn mcp_call(dir: &Path, bin: bool, name: &str, args: Value) -> (String, bool) {
    let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": name, "arguments": args } });
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_vibloom"));
    // The server acts for an agent whatever its environment says.
    clean(&mut cmd)
        .env("VIBLOOM_ROLE", "verifier")
        .arg("mcp")
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if bin {
        let path = format!(
            "{}:{}",
            dir.join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().expect("spawn");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(format!("{msg}\n").as_bytes())
        .expect("write");
    let o = child.wait_with_output().expect("wait");
    let reply: Value =
        serde_json::from_str(String::from_utf8_lossy(&o.stdout).trim()).expect("json");
    (
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        reply["result"]["isError"] == json!(true),
    )
}

#[test]
fn a_risk_accepted_by_the_verifier_stays_visible_and_lets_the_check_pass() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    edit_map(&dir, |m| {
        let nodes = m["nodes"].as_array_mut().expect("nodes");
        nodes.push(json!({ "id": "asm.token-is-standard", "kind": "assumption",
            "title": "the token takes no fee on transfer", "stance": "off" }));
        nodes.push(
            json!({ "id": "int.exact", "kind": "intention", "title": "accounting is exact",
            "depends_on": ["inv.sum", "asm.token-is-standard"], "evidence": ["src/C.sol:1"] }),
        );
    });
    // `run` reports like `status`: something needs attention.
    assert_eq!(cli(&dir, &["run"]).code, 1);
    assert_eq!(cli(&dir, &["status"]).code, 1);

    let accept = [
        "edit",
        "int.exact",
        "--accept",
        "asm.token-is-standard",
        "--reason",
        "only USDC is listed, and it takes no fee",
    ];
    assert!(cli(&dir, &accept).err.contains("a decision for the person"));
    let no_reason = vibloom(&dir, &accept[..4], "", true);
    assert!(
        no_reason.err.contains("--accept needs --reason"),
        "{}",
        no_reason.err
    );
    let on = vibloom(
        &dir,
        &["edit", "int.exact", "--accept", "inv.sum", "--reason", "x"],
        "",
        true,
    );
    assert!(on.err.contains("inv.sum is not off"), "{}", on.err);
    assert_eq!(vibloom(&dir, &accept, "", true).code, 0);

    let status = cli(&dir, &["status"]);
    assert_eq!(status.code, 0, "{}", status.out);
    assert!(
        status.out.contains("adopted (accepts 1 risk)  int.exact"),
        "{}",
        status.out
    );
    assert!(
        status.out.ends_with(
            "Accepted risks:\n- int.exact accepts asm.token-is-standard being off: only USDC is listed, and it takes no fee"
        ),
        "{}",
        status.out
    );
    let json: Value = serde_json::from_str(&cli(&dir, &["status", "--json"]).out).expect("json");
    assert_eq!(
        json["accepted_risks"],
        json!([{ "node": "int.exact", "dependency": "asm.token-is-standard",
                 "reason": "only USDC is listed, and it takes no fee", "in_effect": true }])
    );
    let ctx = cli(&dir, &["context", "src/C.sol"]).out;
    assert!(
        ctx.contains("accepts asm.token-is-standard being off: only USDC is listed"),
        "{ctx}"
    );
    let (mcp, _) = mcp_call(&dir, false, "status", json!({}));
    assert!(mcp.contains("Accepted risks:"), "{mcp}");
    let (refused, is_error) = mcp_call(
        &dir,
        false,
        "propose",
        json!({ "kind": "intention", "title": "y", "evidence": ["a"], "depends_on": ["asm.token-is-standard"],
                "accepts": [{ "id": "asm.token-is-standard", "reason": "r" }] }),
    );
    assert!(
        is_error && refused.contains("accepts cannot be proposed"),
        "{refused}"
    );

    // Acceptance covers only a dependency that is off.
    edit_map(&dir, |m| m["nodes"][1]["stance"] = json!("adopted"));
    let inert = cli(&dir, &["status"]);
    assert_eq!(inert.code, 0, "{}", inert.out);
    assert!(
        inert
            .out
            .contains("it is on again: remove it with `vibloom edit int.exact --unaccept asm.token-is-standard`"),
        "{}",
        inert.out
    );
    assert_eq!(
        vibloom(
            &dir,
            &["edit", "int.exact", "--unaccept", "asm.token-is-standard"],
            "",
            true
        )
        .code,
        0
    );
    assert!(
        !read_map(&dir)["nodes"][2]
            .as_object()
            .expect("node")
            .contains_key("accepts")
    );
}

#[test]
fn a_protected_test_changed_since_the_last_commit_does_not_hold() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    fs::create_dir_all(dir.join("test/handlers")).expect("dir");
    fs::write(dir.join("test/handlers/H.sol"), "contract H {}").expect("write");
    fs::write(dir.join("test/Other.sol"), "contract O {}").expect("write");
    fs::write(
        dir.join("test/C.t.sol"),
        "import \"./handlers/H.sol\";\ncontract CT { function invariant_sum() public {} }",
    )
    .expect("write");
    fs::write(dir.join("foundry.toml"), "[profile.default]\n").expect("write");
    fs::write(dir.join("AGENTS.md"), "# agents\n").expect("write");
    edit_map(&dir, |m| {
        m["protect"] = json!([
            "foundry.toml",
            "test/handlers/H.sol",
            "test/Other.sol",
            "AGENTS.md"
        ]);
    });
    // No repository yet: nothing to compare with, so nothing is flagged.
    assert_eq!(cli(&dir, &["check"]).code, 0);
    git(&dir, &["init", "-q"]);
    // Nor before the first commit.
    git(&dir, &["add", "-A"]);
    assert_eq!(cli(&dir, &["status"]).code, 0);
    git(&dir, &["commit", "-qm", "start"]);
    assert_eq!(cli(&dir, &["check"]).code, 0);

    // Files no test leans on, or the agent's instructions, do not count.
    fs::write(dir.join("test/Other.sol"), "contract O { }").expect("write");
    fs::write(dir.join("AGENTS.md"), "# changed\n").expect("write");
    assert_eq!(
        cli(&dir, &["check"]).code,
        0,
        "{}",
        cli(&dir, &["status"]).out
    );

    // Weakened behind the guard's back, then run again.
    fs::write(dir.join("test/handlers/H.sol"), "contract H { }").expect("write");
    let check = cli(&dir, &["check"]);
    assert_eq!(check.code, 1);
    assert!(
        check.out.contains("TEST CHANGED, unit  inv.sum"),
        "{}",
        check.out
    );
    let stop = hook(&dir, "stop", json!({ "cwd": dir }));
    let reason = stop["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("inv.sum [TEST CHANGED] invariant_sum; not committed: test/handlers/H.sol"),
        "{stop}"
    );
    let (mcp, _) = mcp_call(&dir, false, "run", json!({}));
    assert!(mcp.contains("[TEST CHANGED]"), "{mcp}");
    fs::write(dir.join("src/C.sol"), "contract C { } ").expect("write");
    git(&dir, &["add", "src/C.sol"]);
    let builder = cli(&dir, &["precommit"]);
    assert_eq!(builder.code, 1);
    assert!(builder.err.contains("[TEST CHANGED]"), "{}", builder.err);

    // A deletion, or taking the file out of git, counts too.
    git(&dir, &["checkout", "--", "test/handlers/H.sol"]);
    git(&dir, &["rm", "-q", "--cached", "foundry.toml"]);
    assert!(cli(&dir, &["status"]).out.contains("TEST CHANGED"));
    git(&dir, &["add", "foundry.toml"]);
    assert_eq!(cli(&dir, &["run"]).code, 0);
    assert_eq!(cli(&dir, &["status"]).code, 0);

    // The verifier's change clears once it is committed: staged is enough for
    // the commit check that runs just before.
    fs::write(
        dir.join("test/C.t.sol"),
        "import \"./handlers/H.sol\";\ncontract CT { function invariant_sum() public { } }",
    )
    .expect("write");
    cli(&dir, &["run"]);
    assert_eq!(cli(&dir, &["status"]).code, 1);
    git(&dir, &["add", "-A"]);
    assert_eq!(cli(&dir, &["precommit"]).code, 1);
    let verifier = vibloom(&dir, &["precommit"], "", true);
    assert_eq!(verifier.code, 0, "{}", verifier.err);
    git(&dir, &["commit", "-qm", "tighten"]);
    assert_eq!(cli(&dir, &["status"]).code, 0);

    // A protected test the verifier added and has not committed is not changed.
    fs::write(
        dir.join("test/New.t.sol"),
        "contract NT { function invariant_new() public {} }",
    )
    .expect("write");
    edit_map(&dir, |m| {
        m["nodes"].as_array_mut().expect("nodes").push(json!({
            "id": "inv.new", "kind": "invariant", "title": "new",
            "test": { "file": "test/New.t.sol", "name": "invariant_new" } }));
    });
    let status = cli(&dir, &["status"]).out;
    assert!(!status.contains("TEST CHANGED"), "{status}");
}

#[cfg(unix)]
#[test]
fn survey_names_contracts_and_research_stays_short() {
    let dir = dapptools();
    assert_eq!(with_forge(&dir, &["init"]).code, 0);
    let one = with_forge(&dir, &["survey", "Vat"]);
    assert_eq!(one.code, 0, "{}", one.err);
    assert!(one.out.contains("Vat (src/vat.sol)"), "{}", one.out);
    let none = with_forge(&dir, &["survey", "Vat", "Nope"]);
    assert_eq!(none.code, 2);
    assert_eq!(
        none.err,
        "No contract Nope in the survey. The contracts are: Vat."
    );
    let brief = with_forge(&dir, &["research"]);
    assert_eq!(brief.code, 0, "{}", brief.err);
    assert!(
        brief.out.contains("- Vat (src/vat.sol): 2 entry points (2 open), 0 state variables, no upgrade gate, calls 0 contracts"),
        "{}",
        brief.out
    );
    assert!(!brief.out.contains("src/vat.sol:"), "{}", brief.out);
    assert!(brief.out.contains("the `survey` tool"), "{}", brief.out);
    let (detail, is_error) = mcp_call(&dir, true, "survey", json!({ "contracts": ["Vat"] }));
    assert!(!is_error, "{detail}");
    assert_eq!(detail, one.out);
    let (empty, is_error) = mcp_call(&dir, true, "survey", json!({ "contracts": [] }));
    assert!(
        is_error && empty.contains("at least one contract"),
        "{empty}"
    );
    let (missing, is_error) = mcp_call(&dir, true, "survey", json!({}));
    assert!(is_error, "{missing}");
}

#[test]
fn a_person_at_a_terminal_decides_and_an_agent_does_not() {
    let dir = project();
    with_runner(&dir);
    let add = ["add", "the oracle is fresh"];
    // No configuration: a person at a terminal is the verifier.
    assert_eq!(vibloom_env(&dir, &add, "", &[]).code, 0);
    let mut n = 0;
    for env in [
        &[("CLAUDECODE", "1")][..],
        &[("CODEX_THREAD_ID", "019a")],
        &[("CODEX_SANDBOX", "seatbelt")],
        &[("CURSOR_AGENT", "1")],
        &[("GEMINI_CLI", "1")],
        &[("VIBLOOM_ROLE", "builder")],
    ] {
        n += 1;
        let title = format!("agent claim {n}");
        let r = vibloom_env(&dir, &["add", &title], "", env);
        assert_eq!(r.code, 2, "{env:?}");
        assert!(
            r.err.contains("a decision for the person")
                && r.err.contains(&format!("{} is", env[0].0))
                && r.err
                    .ends_with(&format!("own terminal: vibloom add 'agent claim {n}'")),
            "{}",
            r.err
        );
    }
    // Said outright, the variable wins over detection.
    let told = vibloom_env(
        &dir,
        &["add", "told"],
        "",
        &[("CLAUDECODE", "1"), ("VIBLOOM_ROLE", "verifier")],
    );
    assert_eq!(told.code, 0, "{}", told.err);
}

#[test]
fn connecting_claude_writes_the_agents_role_down() {
    let dir = project();
    fs::create_dir_all(dir.join(".claude")).expect("dir");
    fs::write(
        dir.join(".claude/settings.json"),
        r#"{"env": {"FOO": "bar"}, "model": "x"}"#,
    )
    .expect("write");
    fs::write(
        dir.join(".mcp.json"),
        r#"{"mcpServers": {"other": {"command": "o"}}}"#,
    )
    .expect("write");
    assert_eq!(cli(&dir, &["init", "--agent", "claude"]).code, 0);
    let settings: Value = serde_json::from_str(
        &fs::read_to_string(dir.join(".claude/settings.json")).expect("settings"),
    )
    .expect("json");
    assert_eq!(
        settings["env"],
        json!({ "FOO": "bar", "VIBLOOM_ROLE": "builder" })
    );
    assert_eq!(settings["model"], "x");
    let mcp: Value = serde_json::from_str(&fs::read_to_string(dir.join(".mcp.json")).expect("mcp"))
        .expect("json");
    assert_eq!(mcp["mcpServers"]["other"], json!({ "command": "o" }));
    assert_eq!(
        mcp["mcpServers"]["vibloom"],
        json!({ "command": "vibloom", "args": ["mcp"], "env": { "VIBLOOM_ROLE": "builder" } })
    );
}

#[test]
fn says_where_things_stand_and_the_one_next_step() {
    let empty = std::env::temp_dir().join(format!("vibloom-it-empty-{}", std::process::id()));
    let _ = fs::remove_dir_all(&empty);
    fs::create_dir_all(&empty).expect("dir");
    let start = vibloom(&empty, &[], "", true);
    assert_eq!(start.code, 0);
    assert_eq!(start.out.lines().count(), 6, "{}", start.out);
    assert!(start.out.contains("vibloom init"), "{}", start.out);

    let dir = project();
    fs::write(dir.join("foundry.toml"), "").expect("write");
    let no_map = vibloom(&dir, &[], "", true);
    assert!(no_map.out.ends_with("Next: `vibloom init` finds the invariant tests and writes the map. `vibloom help` lists every command."), "{}", no_map.out);

    // A map whose tests find no invariant: say so and where to start.
    fs::write(dir.join("test/C.t.sol"), "contract CT { }").expect("write");
    let init = cli(&dir, &["init"]);
    assert!(
        init.out.contains(
            "No tests in the map yet, so nothing here can be proven.\nNext: `vibloom survey`"
        ),
        "{}",
        init.out
    );

    let dir = project();
    let init = cli(&dir, &["init"]);
    assert!(
        init.out
            .ends_with("Next: `vibloom check` runs the tests and records what holds."),
        "{}",
        init.out
    );
    edit_map(&dir, |m| m["runner"] = json!(["sh", "runner.sh"]));
    vibloom(
        &dir,
        &["add", "only add moves total", "--on", "inv.sum"],
        "",
        true,
    );
    cli(&dir, &["check"]);
    let broken = vibloom(&dir, &[], "", true);
    assert_eq!(
        broken.out,
        "2 nodes in .vibloom/roots.json; 1 test run recorded here.\n\
         Proven: nothing yet (no invariant holds in a recorded run).\n\
         Only claimed: 1 not yet reviewed (hypothetical: nobody has adopted it).\n\
         Needs attention: 2.\n  \
         - inv.sum BROKEN: failure: drift\n  \
         - asm.only-add-moves-total UNSUPPORTED: because of inv.sum\n\
         Next: `vibloom status` shows every node and why."
    );
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    assert!(vibloom(&dir, &[], "", true).out.ends_with(
        "Next: `vibloom check` runs the tests again; files changed since the last run."
    ));
    cli(&dir, &["check"]);
    let open = vibloom(&dir, &[], "", true);
    assert!(
        open.out
            .contains("Proven: 1 invariant holds in the latest run.\n  - invariant_sum"),
        "{}",
        open.out
    );
    assert!(open.out.ends_with("Next: decide asm.only-add-moves-total: `vibloom edit asm.only-add-moves-total --stance adopted` if it is true, `--stance off` if not."), "{}", open.out);
    vibloom(
        &dir,
        &["edit", "asm.only-add-moves-total", "--stance", "adopted"],
        "",
        true,
    );
    assert!(
        vibloom(&dir, &[], "", true)
            .out
            .ends_with("Next: nothing to do; `vibloom check` runs the tests.")
    );
    let propose = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "propose",
        "arguments": { "kind": "assumption", "title": "x", "evidence": ["src/C.sol:1"] } } });
    vibloom(&dir, &["mcp"], &format!("{propose}\n"), false);
    assert!(
        vibloom(&dir, &[], "", true).out.ends_with(
            "Next: `vibloom proposals` - 1 proposal waiting for you to accept or reject."
        )
    );

    // Sound, but nothing written down beyond the tests: say how to start.
    let bare = project();
    with_runner(&bare);
    fs::write(bare.join("src/C.sol"), "contract C { }").expect("write");
    cli(&bare, &["check"]);
    assert!(
        vibloom(&bare, &[], "", true).out.ends_with(
            "Next: nothing to do; `vibloom check` runs the tests. Write down what the code takes as given with `vibloom add \"<title>\"`."
        )
    );

    let help = cli(&dir, &["help"]);
    assert_eq!(help.code, 0);
    let everyday = help.out.find("Everyday:").expect("everyday");
    let more = help.out.find("More:").expect("more");
    assert!(everyday < more);
    let typo = cli(&dir, &["stauts"]);
    assert_eq!(typo.code, 2);
    assert!(
        typo.err
            .starts_with("No command stauts. Did you mean status?"),
        "{}",
        typo.err
    );
}

#[test]
fn proposals_are_listed_by_contract_and_decided_in_bulk() {
    let dir = project();
    with_runner(&dir);
    let lines: String = [
        (
            "Vat: whoever passes auth is trusted with file",
            "src/vat.sol:3",
        ),
        ("Vat: Vat trusts calls into Gem", "src/vat.sol:9"),
        (
            "Dog: whoever passes auth is trusted with bark",
            "src/dog.sol:2",
        ),
        ("the oracle is fresh", "docs/oracle.md#freshness"),
    ]
    .iter()
    .enumerate()
    .map(|(i, (t, e))| {
        format!(
            "{}\n",
            json!({ "id": format!("p{}", i + 1), "at": "t", "kind": "assumption", "title": t,
                    "evidence": [e], "by": "vibloom survey" })
        )
    })
    .collect();
    fs::write(dir.join(".vibloom/proposals.jsonl"), lines).expect("write");
    let listed = cli(&dir, &["proposals"]);
    assert!(
        listed.out.starts_with(
            "4 pending proposals (4 filed by `vibloom survey`). Nothing in them counts until you accept it.\n\n\
             Dog (1)\n  assumption\n    p3  whoever passes auth is trusted with bark\n\n\
             Vat (2)\n  assumption\n    p1  whoever passes auth is trusted with file\n    p2  Vat trusts calls into Gem\n\n\
             Not about one contract (1)\n  assumption\n    p4  the oracle is fresh\n"
        ),
        "{}",
        listed.out
    );
    assert!(!listed.out.contains("from:"), "{}", listed.out);
    assert!(
        cli(&dir, &["proposals", "--full"])
            .out
            .contains("from: src/vat.sol:3")
    );
    let one = cli(&dir, &["proposals", "p4"]);
    assert!(
        one.out.contains("from: docs/oracle.md#freshness"),
        "{}",
        one.out
    );
    assert!(
        cli(&dir, &["proposals", "p9"])
            .err
            .starts_with("No pending proposal p9. Did you mean p1")
    );
    let wrong = vibloom(
        &dir,
        &["proposals", "accept", "--all", "--contract", "Vta"],
        "",
        true,
    );
    assert!(wrong.err.contains("Did you mean Vat?"), "{}", wrong.err);
    // An agent cannot take them all at once either.
    assert_eq!(cli(&dir, &["proposals", "accept", "--all"]).code, 2);

    let vat = vibloom(
        &dir,
        &[
            "proposals",
            "accept",
            "--all",
            "--contract",
            "Vat",
            "--on",
            "inv.sum",
        ],
        "",
        true,
    );
    assert_eq!(vat.code, 0, "{}", vat.err);
    assert!(
        vat.out.ends_with(
            "Created 2 nodes in the map; 2 start hypothetical (not yet reviewed) until you adopt each with `vibloom edit <id> --stance adopted` or switch them off.\n\
             Each rests on inv.sum: if inv.sum fails, each is at risk."
        ),
        "{}",
        vat.out
    );
    let rest = vibloom(&dir, &["proposals", "reject", "--all"], "", true);
    assert_eq!(rest.out, "Rejected p3.\nRejected p4.");
    assert_eq!(cli(&dir, &["proposals"]).out, "No pending proposals.");
}

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

// Stands in for `halmos --json-output out/halmos.json`: copies the real
// Halmos report named in src/C.sol ("pass", "counterexample", ...).
const FAKE_HALMOS: &str = r#"#!/bin/sh
[ "$1" = none ] && exit 1
mkdir -p out
case "$(cat src/C.sol)" in
  *counterexample*) f=counterexample ;;
  *revert*) f=revert-all ;;
  *timeout*) f=invariants-timeout ;;
  *) f=pass ;;
esac
cp "$FIX/halmos/$f.json" out/halmos.json
[ "$f" = pass ] || exit 1
"#;

fn with_halmos(dir: &Path) {
    with_runner(dir);
    fs::write(dir.join("halmos.sh"), FAKE_HALMOS.replace("$FIX", FIXTURES)).expect("write");
    fs::write(dir.join("test/VaultSym.t.sol"), "contract VaultSymTest {}").expect("write");
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    edit_map(dir, |m| {
        m["checks"] = json!([{ "tool": "halmos", "report": "out/halmos.json",
                               "command": ["sh", "halmos.sh", "--loop", "3"] }]);
        m["nodes"].as_array_mut().expect("nodes").push(json!({
            "id": "inv.sym", "kind": "invariant", "title": "withdraw takes its assets out",
            "test": { "tool": "halmos", "file": "test/VaultSym.t.sol", "contract": "VaultSymTest",
                      "name": "check_withdrawTakesAssetsOut(uint256,uint256)" },
            "watch": ["src/C.sol"] }));
    });
}

fn line_of<'a>(out: &'a str, id: &str) -> &'a str {
    out.lines()
        .find(|l| l.contains(&format!(" {id} ")))
        .unwrap_or_default()
}

#[test]
fn a_halmos_check_keeps_its_guarantee_and_never_reads_a_timeout_as_a_verdict() {
    let dir = project();
    with_halmos(&dir);
    let ok = cli(&dir, &["check"]);
    assert_eq!(ok.code, 0, "{}\n{}", ok.out, ok.err);
    assert!(
        line_of(&ok.out, "inv.sym").starts_with("holds, symbolic (bounded, loop 3)  inv.sym"),
        "{}",
        ok.out
    );
    assert!(
        line_of(&ok.out, "inv.sum").starts_with("holds, unit "),
        "{}",
        ok.out
    );
    let json: Value = serde_json::from_str(&cli(&dir, &["status", "--json"]).out).expect("json");
    let sym = json["nodes"]
        .as_array()
        .and_then(|n| n.iter().find(|n| n["id"] == "inv.sym"))
        .expect("node");
    assert_eq!(
        sym["how"],
        json!({ "kind": "symbolic", "runs": null, "depth": null, "loop": 3,
                "shown": "symbolic (bounded, loop 3)" })
    );

    fs::write(dir.join("src/C.sol"), "contract C { /* counterexample */ }").expect("write");
    let broken = cli(&dir, &["check"]);
    assert_eq!(broken.code, 1);
    assert!(
        broken.out.contains("inv.sym: pending review -> BROKEN"),
        "{}",
        broken.out
    );
    let status = cli(&dir, &["status", "--json"]).out;
    assert!(
        status.contains("failure: counterexample: a=57896044618658097711785492504343953926634992332820282019728792003956564819968, s=1"),
        "{status}"
    );

    edit_map(&dir, |m| {
        m["nodes"][1]["test"]["contract"] = json!("VaultRevertTest");
        m["nodes"][1]["test"]["name"] = json!("check_withdrawFromEmpty");
    });
    fs::write(dir.join("src/C.sol"), "contract C { /* revert */ }").expect("write");
    let vacuous = cli(&dir, &["check"]);
    assert!(
        line_of(&vacuous.out, "inv.sym").starts_with("VACUOUS, symbolic (bounded, loop 3)"),
        "{}",
        vacuous.out
    );

    // The real report holds a TIMEOUT for invariant_sharesAreBacked.
    edit_map(&dir, |m| {
        m["nodes"][1]["test"] = json!({ "tool": "halmos", "file": "test/Vault.t.sol",
            "contract": "VaultTest", "name": "invariant_sharesAreBacked" });
    });
    fs::write(dir.join("test/Vault.t.sol"), "contract VaultTest {}").expect("write");
    fs::write(dir.join("src/C.sol"), "contract C { /* timeout */ }").expect("write");
    let timeout = cli(&dir, &["check"]);
    assert_eq!(timeout.code, 1);
    assert!(
        line_of(&timeout.out, "inv.sym").starts_with("pending review, symbolic"),
        "{}",
        timeout.out
    );
    let json: Value = serde_json::from_str(&cli(&dir, &["status", "--json"]).out).expect("json");
    let sym = json["nodes"]
        .as_array()
        .and_then(|n| n.iter().find(|n| n["id"] == "inv.sym"))
        .expect("node");
    assert_eq!(
        sym["reason"],
        "halmos did not finish (TIMEOUT), so the property is neither shown nor refuted"
    );

    // A command that writes no report is the guard failing, and the report
    // of the run before is deleted, never read again.
    edit_map(&dir, |m| {
        m["checks"][0]["command"] = json!(["sh", "halmos.sh", "none"])
    });
    let none = cli(&dir, &["check"]);
    assert_eq!(none.code, 2);
    assert!(
        none.err
            .contains("halmos: the command wrote no report at out/halmos.json"),
        "{}",
        none.err
    );
    assert!(!dir.join("out/halmos.json").exists());

    // A filtered run leaves the checks alone.
    edit_map(&dir, |m| {
        m["checks"][0]["command"] = json!(["sh", "halmos.sh"])
    });
    assert_eq!(cli(&dir, &["run", "--", "--mt", "invariant_sum"]).code, 1);
    assert!(!dir.join("out/halmos.json").exists());
}

#[test]
fn an_echidna_report_without_a_command_counts_only_while_it_is_fresh() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    fs::write(
        dir.join("test/VaultEchidna.sol"),
        "contract VaultEchidna {}",
    )
    .expect("write");
    edit_map(&dir, |m| {
        m["checks"] = json!([{ "tool": "echidna", "report": "out/echidna.json" }]);
        m["nodes"].as_array_mut().expect("nodes").push(json!({
            "id": "inv.flows", "kind": "invariant", "title": "assets match flows",
            "test": { "tool": "echidna", "file": "test/VaultEchidna.sol",
                      "contract": "VaultEchidna", "name": "echidna_assets_match_flows" },
            "watch": ["src/C.sol"] }));
    });
    let missing = cli(&dir, &["check"]);
    assert_eq!(missing.code, 1);
    assert!(
        missing.out.contains("pending review, fuzzed  inv.flows"),
        "{}",
        missing.out
    );
    let why = cli(&dir, &["status", "--json"]).out;
    assert!(
        why.contains(
            "no echidna report at out/echidna.json: run echidna, or give the check a command"
        ),
        "{why}"
    );

    fs::create_dir_all(dir.join("out")).expect("dir");
    // Written, not copied: a copy keeps the fixture's old mtime on macOS
    // and Windows, which would make the report look stale.
    fs::write(
        dir.join("out/echidna.json"),
        fs::read(format!("{FIXTURES}/echidna/passed.json")).expect("fixture"),
    )
    .expect("write");
    let fresh = cli(&dir, &["check"]);
    assert_eq!(fresh.code, 0, "{}", fresh.out);
    assert!(
        fresh.out.contains("holds, fuzzed  inv.flows"),
        "{}",
        fresh.out
    );

    // The code changed after the report was written: it says nothing now.
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(dir.join("src/C.sol"), "contract C { uint x; }").expect("write");
    let stale = cli(&dir, &["check"]);
    assert_eq!(stale.code, 1);
    let why = cli(&dir, &["status", "--json"]).out;
    assert!(
        why.contains(
            "the echidna report out/echidna.json is older than src/C.sol: run echidna again"
        ),
        "{why}"
    );

    // Written, not copied: a copy keeps the fixture's old mtime on macOS
    // and Windows, which would make the report look stale.
    fs::write(
        dir.join("out/echidna.json"),
        fs::read(format!("{FIXTURES}/echidna/solved.json")).expect("fixture"),
    )
    .expect("write");
    let solved = cli(&dir, &["check"]);
    assert_eq!(solved.code, 1);
    assert!(
        solved.out.contains("inv.flows: pending review -> BROKEN"),
        "{}",
        solved.out
    );
}

#[test]
fn checks_and_their_configs_are_guarded() {
    let dir = project();
    with_halmos(&dir);
    fs::write(dir.join("echidna.yaml"), "testLimit: 50000\n").expect("write");
    edit_map(&dir, |m| {
        m["checks"].as_array_mut().expect("checks").push(json!({
            "tool": "echidna", "report": "out/echidna.json",
            "command": ["sh", "-c", "echidna . --config echidna.yaml --format json > out/echidna.json"] }));
    });
    let scan = vibloom(&dir, &["scan"], "", true);
    assert!(
        scan.out.contains("Now guarded: echidna.yaml."),
        "{}",
        scan.out
    );
    git(&dir, &["init", "-q"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "start"]);
    edit_map(&dir, |m| {
        m["checks"] = json!([{ "tool": "halmos", "report": "out/halmos.json",
                               "command": ["sh", "halmos.sh", "--loop", "1"] }]);
    });
    fs::write(dir.join("echidna.yaml"), "testLimit: 1\n").expect("write");
    let base = cli(&dir, &["check", "--base", "HEAD"]);
    assert_eq!(base.code, 1);
    for want in [
        "- the halmos command changed from `sh halmos.sh --loop 3` to `sh halmos.sh --loop 1`",
        "- the echidna check (out/echidna.json) was removed",
        "- echidna.yaml: guarded file changed",
    ] {
        assert!(base.out.contains(want), "{want}\n{}", base.out);
    }
}

#[test]
fn init_names_the_schema_first() {
    let dir = project();
    assert_eq!(vibloom(&dir, &["init"], "", true).code, 0);
    let text = fs::read_to_string(dir.join(".vibloom/roots.json")).expect("map");
    assert!(
        text.starts_with("{\n  \"$schema\": \"https://raw.githubusercontent.com/viraloyster/VIBloom/main/schema/roots.v1.schema.json\","),
        "{text}"
    );
}

#[test]
fn diff_shows_what_changed_since_the_audited_commit() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    fs::write(dir.join("src/D.sol"), "contract D { }").expect("write");
    edit_map(&dir, |m| {
        let nodes = m["nodes"].as_array_mut().expect("nodes");
        nodes[0]["watch"] = json!(["src/C.sol"]);
        nodes.push(
            json!({ "id": "asm.d", "kind": "assumption", "title": "D is trusted",
            "stance": "adopted", "watch": ["src/D.sol"] }),
        );
        nodes.push(json!({ "id": "asm.gone", "kind": "assumption", "title": "soon gone" }));
        nodes.push(
            json!({ "id": "int.safe", "kind": "intention", "title": "safe",
            "depends_on": ["inv.sum", "asm.d"] }),
        );
    });
    git(&dir, &["init", "-q"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "audited"]);
    git(&dir, &["tag", "audit-1"]);
    let same = cli(&dir, &["diff", "audit-1"]);
    assert_eq!(same.code, 0, "{}", same.err);
    assert_eq!(
        same.out,
        "Since audit-1: 0 gone or weakened, 0 guard changes, 0 nodes with changed files, 0 added."
    );

    fs::write(dir.join("src/D.sol"), "contract D { uint x; }").expect("write");
    fs::write(
        dir.join("test/C.t.sol"),
        "contract CT { function invariant_sum() public { } }",
    )
    .expect("write");
    edit_map(&dir, |m| {
        let nodes = m["nodes"].as_array_mut().expect("nodes");
        nodes.retain(|n| n["id"] != "asm.gone");
        nodes[0]["protected"] = json!(false);
        nodes.push(json!({ "id": "asm.new", "kind": "assumption", "title": "new one" }));
    });
    // Read-only, so an agent may run it too.
    let d = cli(&dir, &["diff", "audit-1"]);
    assert_eq!(d.code, 1, "{}", d.err);
    assert_eq!(
        d.out,
        [
            "Gone or weakened since audit-1:",
            "- asm.gone: removed (\"soon gone\")",
            "- inv.sum: its test is no longer protected; files changed: test/C.t.sol",
            "Guard changes since audit-1:",
            "- test/C.t.sol: guarded file changed",
            "Not what was reviewed at audit-1 (same node, but files it watches changed):",
            "- asm.d: src/D.sol",
            "Added since audit-1:",
            "- asm.new: new one",
            "Since audit-1: 2 gone or weakened, 1 guard change, 1 node with changed files, 1 added.",
        ]
        .join("\n")
    );
    let j: Value =
        serde_json::from_str(&cli(&dir, &["diff", "audit-1", "--json"]).out).expect("json");
    assert_eq!(
        j["summary"],
        json!({ "removed": 1, "weakened": 1, "guard": 1, "changed": 1, "added": 1 })
    );
    assert_eq!(
        j["changed"][0]["files"],
        json!([{ "path": "src/D.sol", "change": "changed" }])
    );
    assert_eq!(cli(&dir, &["diff", "nope"]).code, 2);
    assert_eq!(cli(&dir, &["diff"]).code, 2);
}
