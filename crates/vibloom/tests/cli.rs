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
    let out = cli(&dir, &["init"]).out;
    assert!(out.contains("1 invariant tests found"), "{out}");
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
    assert_eq!(cli(&dir, &["init", "--stack", "cobol"]).code, 1);

    let add = ["add", "invariant", "a balance never goes negative"];
    let test = [
        "--file",
        "tests/test_vault.py",
        "--test",
        "test_never_negative",
    ];
    let refused = cli(&dir, &[&add[..], &test[..]].concat());
    assert_eq!(refused.code, 1);
    assert!(refused.err.contains("only the verifier"), "{}", refused.err);
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
        "Added int.withdraw-caps-at-the-balance (adopted)."
    );
    // One rule: an assumption is hypothetical until someone adopts it.
    let asm = ["add", "assumption", "the oracle is fresh"];
    assert_eq!(
        vibloom(&dir, &asm, "", true).out,
        "Added asm.the-oracle-is-fresh (hypothetical)."
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
        "Added int.maybe (hypothetical)."
    );
    let both = vibloom(
        &dir,
        &[&asm[..], &["--adopted", "--hypothetical"][..]].concat(),
        "",
        true,
    );
    assert_eq!(both.code, 1);
    assert!(both.err.contains("not both"), "{}", both.err);
    let unknown = vibloom(
        &dir,
        &["add", "assumption", "x", "--on", "inv.nope"],
        "",
        true,
    );
    assert!(
        unknown.err.contains("depends on unknown inv.nope"),
        "{}",
        unknown.err
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
    assert_eq!(cli(&dir, &["install-hook"]).code, 1);
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
    assert_eq!(other.code, 1);
    assert!(other.err.contains("Add this line to it"), "{}", other.err);
}

#[test]
fn sync_takes_the_base_log_when_two_branches_both_ran() {
    let dir = project();
    with_runner(&dir);
    fs::write(dir.join("src/C.sol"), "contract C { }").expect("write");
    git(&dir, &["init", "-q", "-b", "main"]);
    cli(&dir, &["run"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "base"]);

    git(&dir, &["checkout", "-qb", "feature"]);
    cli(&dir, &["run"]);
    git(&dir, &["commit", "-qam", "feature ran"]);
    git(&dir, &["checkout", "-q", "main"]);
    cli(&dir, &["run"]);
    cli(&dir, &["run"]);
    git(&dir, &["commit", "-qam", "main ran twice"]);
    git(&dir, &["checkout", "-q", "feature"]);

    assert_eq!(cli(&dir, &["check", "--base", "main"]).code, 1);
    assert_eq!(cli(&dir, &["sync"]).code, 1);
    let synced = cli(&dir, &["sync", "--base", "main"]);
    assert_eq!(synced.code, 0, "{}", synced.err);
    assert!(
        synced.out.starts_with("Took the 3 runs on main"),
        "{}",
        synced.out
    );
    assert!(synced.out.contains("Run 4:"), "{}", synced.out);
    assert_eq!(cli(&dir, &["verify"]).out, "4 runs, chain intact.");
    assert_eq!(cli(&dir, &["check", "--base", "main"]).code, 0);
    // Already in step with the base: nothing is replaced.
    assert!(
        cli(&dir, &["sync", "--base", "main"])
            .out
            .starts_with("The run log already extends")
    );
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
    assert_eq!(r.code, 1);
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
    assert_eq!(cli(&dir, &["setup", "claude"]).code, 1);
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
    assert_eq!(vibloom(&dir, &["setup", "cursor"], "", true).code, 1);
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
    assert!(vacuous.out.contains("VACUOUS  inv.sum"), "{}", vacuous.out);
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
        .args(["-c", "\"$VIBLOOM\" proposals | head -1"])
        .env("VIBLOOM", env!("CARGO_BIN_EXE_vibloom"))
        .current_dir(&dir)
        .output()
        .expect("sh");
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("p1  assumption"));
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
    let o = Command::new(env!("CARGO_BIN_EXE_vibloom"))
        .args(args)
        .current_dir(dir)
        .env("PATH", path)
        .env("VIBLOOM_ROLE", "verifier")
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
        Command::new(env!("CARGO_BIN_EXE_vibloom"))
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
        status.out.contains("pending review  inv.sum"),
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
    assert!(!dir.join(".vibloom/log.jsonl").exists());
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
    let out = cli(&dir, &["check"]);
    assert_eq!(out.code, 0, "{}", out.err);
    assert!(
        out.out.contains(
            "Run 1: 2 test results recorded, 1 failed (1 tied to no node, so no state shows them)."
        ),
        "{}",
        out.out
    );
}

#[test]
fn says_what_to_do_outside_the_project_or_a_repository() {
    let dir = project();
    with_runner(&dir);
    let precommit = cli(&dir, &["precommit"]);
    assert_eq!(precommit.code, 1);
    assert!(
        precommit.err.starts_with("Not a git repository"),
        "{}",
        precommit.err
    );
    assert!(precommit.err.lines().count() == 1, "{}", precommit.err);
    let outside = cli(&dir, &["context", "/etc/passwd"]);
    assert_eq!(outside.code, 1);
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
        "Accepted p1 as asm.total-only-grows (hypothetical; asm.grows is already in use)."
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
    assert!(first.out.contains("Filed 1 new proposal."), "{}", first.out);
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
    cmd.arg("mcp")
        .current_dir(dir)
        .env_remove("VIBLOOM_ROLE")
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
    assert_eq!(cli(&dir, &["run"]).code, 0);
    assert_eq!(cli(&dir, &["status"]).code, 1);

    let accept = [
        "edit",
        "int.exact",
        "--accept",
        "asm.token-is-standard",
        "--reason",
        "only USDC is listed, and it takes no fee",
    ];
    assert!(cli(&dir, &accept).err.contains("only the verifier"));
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
    assert!(check.out.contains("TEST CHANGED  inv.sum"), "{}", check.out);
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
    assert_eq!(none.code, 1);
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
