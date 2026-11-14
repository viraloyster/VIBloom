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

struct Out {
    code: i32,
    out: String,
    err: String,
}

fn vibloom(dir: &Path, args: &[&str], stdin: &str, verifier: bool) -> Out {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_vibloom"));
    cmd.args(args)
        .current_dir(dir)
        .env_remove("VIBLOOM_ROLE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if verifier {
        cmd.env("VIBLOOM_ROLE", "verifier");
    }
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
    let ok = Command::new("git")
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
    assert_eq!(r.code, 1);
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
    let log = fs::read_to_string(dir.join(".vibloom/log.jsonl")).expect("log");
    assert!(log.contains("sum < total"), "{log}");

    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    assert_eq!(cli(&dir, &["check"]).code, 0);

    // The report from the last run is still on disk; it must not count again.
    edit_map(&dir, |m| m["runner"] = json!(["sh", "junit.sh", "none"]));
    let none = cli(&dir, &["check"]);
    assert_eq!(none.code, 1);
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

#[test]
fn refuses_a_branch_whose_log_was_rewritten() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    git(&dir, &["init", "-q"]);
    cli(&dir, &["run"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    git(&dir, &["branch", "base"]);
    cli(&dir, &["run"]);
    assert_eq!(cli(&dir, &["check", "--base", "base"]).code, 0);

    fs::write(dir.join(".vibloom/log.jsonl"), "").expect("write");
    cli(&dir, &["run"]);
    assert_eq!(cli(&dir, &["verify"]).code, 0);
    let r = cli(&dir, &["check", "--base", "base"]);
    assert_eq!(r.code, 1);
    assert!(r.err.contains("rewritten, not extended"), "{}", r.err);
    assert!(
        cli(&dir, &["check", "--base", "nope"])
            .err
            .contains("nope is not a commit here")
    );
}

#[test]
fn verifies_and_extends_a_log_written_by_the_typescript_guard() {
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
    assert_eq!(cli(&dir, &["verify"]).out, "2 runs, chain intact.");
    let status = cli(&dir, &["status"]);
    assert_eq!(status.code, 0, "{}", status.out);
    assert!(status.out.contains("holds") && status.out.contains("inv.sum"));

    edit_map(&dir, |m| m["runner"] = json!(["sh", "runner.sh"]));
    assert!(cli(&dir, &["run"]).out.starts_with("Run 3:"));
    assert_eq!(cli(&dir, &["verify"]).out, "3 runs, chain intact.");
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
            "kind": "assumption", "title": "Only add() changes total", "depends_on": ["inv.sum"], "by": "test-agent" } } }),
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
            .contains("p1  assumption  Only add() changes total")
    );
    // An agent cannot accept what it proposed: deciding needs the verifier.
    let refused = cli(&dir, &["proposals", "accept", "p1"]);
    assert_eq!(refused.code, 1);
    assert!(
        refused.err.contains("Only the verifier decides"),
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
            .contains("UNSUPPORTED  asm.only-add-changes-total")
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
    assert!(typo.out.contains("untested  inv.typo"), "{}", typo.out);
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
    assert!(skipped.out.contains("skipped  inv.sum"), "{}", skipped.out);

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
            Command::new(env!("CARGO_BIN_EXE_vibloom"))
                .arg("run")
                .current_dir(&dir)
                .env_remove("VIBLOOM_ROLE")
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
    let path = dir.join(".vibloom/log.jsonl");
    let text = fs::read_to_string(&path).expect("log");
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    lines[3] = lines[3].replace("\"fail\"", "\"pass\"");
    fs::write(&path, lines.join("\n") + "\n").expect("write");
    assert_eq!(cli(&dir, &["verify"]).code, 1);
    let stuck = cli(&dir, &["run"]);
    assert!(stuck.err.contains("vibloom repair"), "{}", stuck.err);
    assert_eq!(cli(&dir, &["repair"]).code, 1);
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
    assert_eq!(cli(&dir, &["run"]).code, 0);
    let before = fs::read_to_string(dir.join(".vibloom/log.jsonl")).expect("log");

    // A mistyped option is not handed to the runner, and records nothing.
    let bad = cli(&dir, &["run", "--mt", "x"]);
    assert_eq!(bad.code, 1);
    assert!(bad.err.contains("go after `--`"), "{}", bad.err);
    assert!(cli(&dir, &["run", "--help"]).out.starts_with("vibloom:"));
    assert_eq!(
        fs::read_to_string(dir.join(".vibloom/log.jsonl")).expect("log"),
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
    assert_eq!(typo.code, 1);
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
