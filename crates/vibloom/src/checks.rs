//! Reports of tools other than the project's runner: Halmos (`--json-output`)
//! and Echidna (its text summary, or `--format json`). Each result keeps the
//! kind of guarantee it gives, and anything short of a verdict stays short of
//! one: a timeout is never a pass, and never a failure either.

use crate::forge::{How, HowKind, Outcome, RunnerOutputError, Status};
use crate::map::{Tool, test_name};
use crate::proc::last_json;
use serde_json::Value;

/// The value after a flag in a command, as `--loop 4` or `--loop=4`, also
/// inside a shell line (`sh -c "echidna ... --test-limit 5000"`).
pub fn flag_value(command: &[String], flag: &str) -> Option<String> {
    let words: Vec<&str> = command.iter().flat_map(|a| a.split_whitespace()).collect();
    words.iter().enumerate().find_map(|(i, w)| {
        let v = match w.strip_prefix(flag) {
            Some("") => words.get(i + 1).copied(),
            Some(rest) => rest.strip_prefix('='),
            None => None,
        };
        v.map(|v| v.trim_matches(['"', '\'']).to_string())
    })
}

pub fn flag_number(command: &[String], flag: &str) -> Option<u64> {
    flag_value(command, flag).and_then(|v| v.parse().ok())
}

fn clip(s: &str) -> String {
    s.chars().take(500).collect()
}

// The values of a Halmos model: the test's own parameters first, as
// `name=value`, since they are what a person reruns the test with.
// serde_json reads a 256-bit integer as a float and loses its digits; the
// report's own text keeps them.
fn raw_value(text: &str, full: &str) -> Option<String> {
    let at = text.find(&format!("\"{full}\""))?;
    let rest = &text[at..];
    let v = rest.find("\"value\"")?;
    let rest = rest[v + "\"value\"".len()..]
        .trim_start()
        .strip_prefix(':')?;
    let token: String = rest
        .trim_start()
        .chars()
        .take_while(|c| !matches!(c, ',' | '}' | '\n' | '\r'))
        .collect();
    let token = token.trim();
    (!token.is_empty() && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then(|| token.to_string())
}

fn model_text(text: &str, models: Option<&Value>) -> Option<String> {
    let model = models?.as_array()?.first()?.get("model")?.as_object()?;
    let mut params = vec![];
    let mut others = vec![];
    for (full, v) in model {
        let name = v
            .get("variable_name")
            .and_then(Value::as_str)
            .unwrap_or(full);
        let value = match v.get("value") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) if n.is_f64() => {
                raw_value(text, full).unwrap_or_else(|| n.to_string())
            }
            Some(x) => x.to_string(),
            None => "?".into(),
        };
        let pair = format!("{name}={value}");
        if full.starts_with("p_") {
            params.push(pair);
        } else {
            others.push(pair);
        }
    }
    let all = if params.is_empty() { others } else { params };
    (!all.is_empty()).then(|| all.join(", "))
}

/// Halmos `--json-output`: `test_results` maps "file:Contract" to the
/// results of its `check_` and `invariant_` functions.
pub fn parse_halmos(
    text: &str,
    loop_bound: Option<u64>,
) -> Result<Vec<Outcome>, RunnerOutputError> {
    let report = last_json(text)
        .ok_or_else(|| RunnerOutputError("the Halmos report could not be parsed".into()))?;
    let results = report
        .get("test_results")
        .and_then(Value::as_object)
        .ok_or_else(|| RunnerOutputError("the Halmos report has no test_results".into()))?;
    let how = How {
        loop_bound,
        ..How::of(HowKind::Symbolic)
    };
    let mut out = vec![];
    for (suite, list) in results {
        let (file, contract) = suite.rsplit_once(':').unwrap_or(("", suite));
        for r in list.as_array().into_iter().flatten() {
            let Some(name) = r.get("name").and_then(Value::as_str) else {
                continue;
            };
            let code = r.get("exitcode").and_then(Value::as_i64);
            let unfinished = |what: &str| {
                Some(format!(
                    "halmos did not finish ({what}), so the property is neither shown nor refuted"
                ))
            };
            let (status, reason) = match code {
                Some(0) => (Status::Pass, None),
                Some(1) => (
                    Status::Fail,
                    Some(clip(&match model_text(text, r.get("models")) {
                        Some(m) => format!("counterexample: {m}"),
                        None => "counterexample found (the report holds no model)".into(),
                    })),
                ),
                Some(4) => (
                    Status::Vacuous,
                    Some(
                        "every path reverted (REVERT_ALL), so the property was never checked"
                            .into(),
                    ),
                ),
                Some(2) => (Status::Inconclusive, unfinished("TIMEOUT")),
                Some(3) => (Status::Inconclusive, unfinished("STUCK")),
                Some(5) => (Status::Inconclusive, unfinished("EXCEPTION")),
                // An exit code this version does not know is never a pass.
                other => (
                    Status::Inconclusive,
                    Some(format!(
                        "halmos reported an unknown exit code {}",
                        other.map_or("none".to_string(), |c| c.to_string())
                    )),
                ),
            };
            out.push(Outcome {
                file: file.to_string(),
                contract: contract.to_string(),
                name: test_name(name),
                status,
                reason,
                fuzz: None,
                tool: Some(Tool::Halmos),
                how: Some(how.clone()),
            });
        }
    }
    Ok(out)
}

// "deposit(1) -> withdraw(1)": the calls that break the property. A call
// with no arguments in the report is a wait, a creation or raw calldata
// (lib/Echidna/Output/JSON.hs:174-178), shown as its name alone.
fn transactions_text(txs: Option<&Value>) -> Option<String> {
    let calls: Vec<String> = txs?
        .as_array()?
        .iter()
        .filter_map(|t| {
            let f = t.get("function").and_then(Value::as_str)?;
            let Some(args) = t.get("arguments").and_then(Value::as_array) else {
                return Some(f.to_string());
            };
            let args: Vec<String> = args
                .iter()
                .map(|a| a.as_str().map_or_else(|| a.to_string(), str::to_string))
                .collect();
            Some(format!("{f}({})", args.join(", ")))
        })
        .collect();
    (!calls.is_empty()).then(|| calls.join(" -> "))
}

/// What an Echidna command printed, saved to the report: the text summary
/// (`--format text`, and the default when stdout is no terminal) or
/// `--format json`, told apart by the contents. Neither names the contract,
/// so a result's contract is the command's `--contract`, if any. Runs and
/// sequence length are not in either; the command may set them.
pub fn parse_echidna(text: &str, command: &[String]) -> Result<Vec<Outcome>, RunnerOutputError> {
    let how = echidna_how(command);
    match last_json(text).filter(|v| v.get("tests").is_some() || v.get("error").is_some()) {
        Some(report) => echidna_json(&report, how),
        None => echidna_text(
            text,
            how,
            &flag_value(command, "--contract").unwrap_or_default(),
        ),
    }
}

// `--format json`: one campaign, `{success, error, tests}`, each test
// `{contract, name, status, error, reason, transactions}`, printed after the
// campaign's log lines.
fn echidna_json(report: &Value, how: How) -> Result<Vec<Outcome>, RunnerOutputError> {
    if let Some(e) = report.get("error").and_then(Value::as_str) {
        return Err(RunnerOutputError(format!(
            "echidna reported an error: {}",
            clip(e)
        )));
    }
    let tests = report
        .get("tests")
        .and_then(Value::as_array)
        .ok_or_else(|| RunnerOutputError("the Echidna report has no tests".into()))?;
    let mut out = vec![];
    for t in tests {
        let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or_default();
        // Echidna writes every test as "name" with no contract
        // (lib/Echidna/Output/JSON.hs:141-142): which result is which test
        // cannot be told, and guessing would tie a verdict to the wrong node.
        if s("name") == "name" && s("contract").is_empty() {
            return Err(RunnerOutputError(
                "the Echidna report does not name its tests (each is \"name\"), so its results cannot be tied to nodes: write Echidna's text summary instead, with `--format text > <report>` in the check's command".into(),
            ));
        }
        if s("name").is_empty() {
            continue;
        }
        let falsified = |what: &str| {
            Some(clip(&match transactions_text(t.get("transactions")) {
                Some(calls) => format!("{what} by: {calls}"),
                None => format!("{what} (the report lists no transactions)"),
            }))
        };
        let (status, reason) = match s("status") {
            // A test never falsified stays "fuzzing" when the campaign ends
            // (Open, lib/Echidna/Output/JSON.hs:151), and Echidna's own exit
            // code counts it a success (lib/Echidna/Types/Test.hs:199-200).
            // "passed" and "verified" come from its symbolic worker.
            "fuzzing" | "passed" | "verified" => (Status::Pass, None),
            "solved" => (Status::Fail, falsified("falsified")),
            // Falsified, with the sequence not yet shrunk to its shortest.
            "shrinking" => (Status::Fail, falsified("falsified (not fully shrunk)")),
            "error" => (
                Status::Inconclusive,
                Some(clip(&format!(
                    "echidna could not evaluate the test{}",
                    match s("error") {
                        "" => String::new(),
                        e => format!(": {e}"),
                    }
                ))),
            ),
            // A status this version does not know is never a pass.
            other => (
                Status::Inconclusive,
                Some(clip(&format!(
                    "echidna reported an unknown status \"{other}\""
                ))),
            ),
        };
        out.push(Outcome {
            file: String::new(),
            contract: s("contract").to_string(),
            name: s("name").to_string(),
            status,
            reason,
            fuzz: None,
            tool: Some(Tool::Echidna),
            how: Some(how.clone()),
        });
    }
    Ok(out)
}

// The lines ppCampaign prints after the tests (lib/Echidna/UI/Report.hs:63-79).
const ECHIDNA_FOOTER: [&str; 5] = [
    "Unique instructions: ",
    "Unique codehashes: ",
    "Corpus size: ",
    "Seed: ",
    "Total calls: ",
];

#[derive(Debug)]
enum Head {
    Passing,
    Passed,
    Verified,
    Failed,
    Error,
    Max(String),
}

// The first line of a test in the summary, `<name>: <status>`
// (lib/Echidna/UI/Report.hs:184-237). Only the statuses Echidna prints
// start a test; any other line belongs to the one before.
fn echidna_head(line: &str) -> Option<(&str, Head)> {
    let (name, rest) = line.split_once(": ")?;
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    let head = match rest.trim() {
        "passing" => Head::Passing,
        "passed! \u{1F389}" => Head::Passed,
        "verified \u{2705}" => Head::Verified,
        "failed!\u{1F4A5}" => Head::Failed,
        "could not evaluate \u{2623}" => Head::Error,
        r => Head::Max(r.strip_prefix("max value:")?.trim().to_string()),
    };
    Some((name, head))
}

// A falsified test: "  Reason: ...", then "  Call sequence[, shrinking n/m]:"
// and one call per line indented by four, or "  No transactions were
// needed..." (lib/Echidna/UI/Report.hs:150-163). The traces after are not read.
fn echidna_failed(body: &[&str]) -> String {
    let Some(at) = body.iter().position(|l| l.starts_with("  Call sequence")) else {
        return if body.iter().any(|l| l.starts_with("  No transactions")) {
            "falsified with no transactions".into()
        } else {
            "falsified (the summary lists no call sequence)".into()
        };
    };
    let what = if body[at].contains(", shrinking ") {
        "falsified (not fully shrunk)"
    } else {
        "falsified"
    };
    let calls: Vec<&str> = body[at + 1..]
        .iter()
        .take_while(|l| l.starts_with("    "))
        .map(|l| l.trim())
        .collect();
    if calls.is_empty() {
        format!("{what} (the summary lists no calls)")
    } else {
        format!("{what} by: {}", calls.join(" -> "))
    }
}

// `--format text`: log lines, a `[status]` line every few seconds, then
// ppCampaign once the campaign ends (lib/Echidna/UI.hs:219-245). With
// `--format none` the summary is never printed.
fn echidna_text(text: &str, how: How, contract: &str) -> Result<Vec<Outcome>, RunnerOutputError> {
    let lines: Vec<&str> = text.lines().collect();
    let no_summary = || {
        RunnerOutputError(
            "the Echidna report holds no final summary: redirect `echidna ... --format text` to the report (with --format none Echidna prints none)".into(),
        )
    };
    let end = (0..lines.len())
        .rev()
        .find(|&i| {
            ECHIDNA_FOOTER
                .iter()
                .enumerate()
                .all(|(k, p)| lines.get(i + k).is_some_and(|l| l.starts_with(p)))
        })
        .ok_or_else(no_summary)?;
    // The status line printed last comes right before the summary
    // (lib/Echidna/UI.hs:223,236); the log lines above it are not read.
    let start = lines[..end]
        .iter()
        .rposition(|l| l.starts_with('[') && l.contains("] [status] "))
        .ok_or_else(no_summary)?
        + 1;
    let mut tests: Vec<(&str, Head, Vec<&str>)> = vec![];
    for line in &lines[start..end] {
        if let Some((name, head)) = echidna_head(line) {
            tests.push((name, head, vec![]));
        } else if let Some(t) = tests.last_mut() {
            t.2.push(line);
        } else if !line.trim().is_empty() {
            return Err(RunnerOutputError(format!(
                "the Echidna summary has a line vibloom does not know: {}",
                clip(line)
            )));
        }
    }
    let mut out: Vec<Outcome> = vec![];
    for (printed, head, body) in tests {
        // An assertion test prints its signature; a node names the function.
        let name = test_name(printed);
        // Two tests with one name (an overload, the same assertion in two
        // contracts) cannot be told apart.
        if out.iter().any(|o| o.name == name) {
            return Err(RunnerOutputError(format!(
                "the Echidna summary names two tests {name}, so their results cannot be tied to nodes"
            )));
        }
        let first = body.iter().map(|l| l.trim()).find(|l| !l.is_empty());
        let error = |e: Option<&str>| {
            Some(clip(&format!(
                "echidna could not evaluate the test{}",
                e.map_or(String::new(), |e| format!(": {e}"))
            )))
        };
        let (status, reason) = match head {
            // "passing" is a test never falsified when the campaign ends
            // (Open with no reproducer, Report.hs:188), "fuzzing" in the JSON.
            Head::Passing | Head::Passed | Head::Verified => {
                if let Some(l) = first {
                    return Err(RunnerOutputError(format!(
                        "the Echidna summary has a line vibloom does not know after {printed}: {}",
                        clip(l)
                    )));
                }
                (Status::Pass, None)
            }
            Head::Failed => (Status::Fail, Some(clip(&echidna_failed(&body)))),
            Head::Error => (Status::Inconclusive, error(first)),
            // An optimization test reports a maximum, never a verdict.
            Head::Max(v) => match first.and_then(|l| l.strip_prefix("could not evaluate")) {
                Some(_) => (
                    Status::Inconclusive,
                    error(
                        body.iter()
                            .map(|l| l.trim())
                            .filter(|l| !l.is_empty())
                            .nth(1),
                    ),
                ),
                None => (
                    Status::Inconclusive,
                    Some(clip(&format!(
                        "an optimization test reports a maximum ({v}), not a verdict"
                    ))),
                ),
            },
        };
        out.push(Outcome {
            file: String::new(),
            contract: contract.to_string(),
            name,
            status,
            reason,
            fuzz: None,
            tool: Some(Tool::Echidna),
            how: Some(how.clone()),
        });
    }
    Ok(out)
}

/// The guarantee of a tool's test before its report says more.
pub fn default_how(tool: Tool) -> How {
    How::of(match tool {
        Tool::Halmos => HowKind::Symbolic,
        Tool::Echidna => HowKind::Fuzzed,
        Tool::Junit => HowKind::Unit,
    })
}

/// What an Echidna command says about its campaign: `--test-limit` runs of
/// `--seq-len` calls.
pub fn echidna_how(command: &[String]) -> How {
    How {
        runs: flag_number(command, "--test-limit"),
        depth: flag_number(command, "--seq-len"),
        ..How::of(HowKind::Fuzzed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

    fn fixture(p: &str) -> String {
        std::fs::read_to_string(format!("{FIX}/{p}")).expect("fixture")
    }

    fn by_name(o: &[Outcome], name: &str) -> Outcome {
        o.iter().find(|x| x.name == name).cloned().expect(name)
    }

    // The Halmos fixtures are real halmos 0.3.3 output on a copy of
    // examples/foundry-vault.
    #[test]
    fn reads_a_halmos_pass_counterexample_and_revert_all() {
        let pass = parse_halmos(&fixture("halmos/pass.json"), None).expect("report");
        assert_eq!(pass.len(), 1);
        let p = &pass[0];
        assert_eq!(
            (p.file.as_str(), p.contract.as_str(), p.name.as_str()),
            (
                "test/VaultSym.t.sol",
                "VaultSymTest",
                "check_withdrawTakesAssetsOut"
            )
        );
        assert_eq!(p.status, Status::Pass);
        assert_eq!(p.guarantee().shown(), "symbolic (bounded)");

        let cex = parse_halmos(&fixture("halmos/counterexample.json"), Some(4)).expect("report");
        assert_eq!(cex[0].status, Status::Fail);
        assert_eq!(
            cex[0].reason.as_deref(),
            Some(
                "counterexample: a=57896044618658097711785492504343953926634992332820282019728792003956564819968, s=1"
            )
        );
        assert_eq!(cex[0].guarantee().shown(), "symbolic (bounded, loop 4)");

        let revert = parse_halmos(&fixture("halmos/revert-all.json"), None).expect("report");
        assert_eq!(revert[0].status, Status::Vacuous);
    }

    #[test]
    fn a_halmos_timeout_is_neither_a_pass_nor_a_failure() {
        let o = parse_halmos(&fixture("halmos/invariants-timeout.json"), None).expect("report");
        let t = by_name(&o, "invariant_sharesAreBacked");
        assert_eq!(t.status, Status::Inconclusive);
        assert_eq!(
            t.reason.as_deref(),
            Some("halmos did not finish (TIMEOUT), so the property is neither shown nor refuted")
        );
        assert_eq!(
            by_name(&o, "invariant_assetsMatchFlows").status,
            Status::Fail
        );
        for (code, want) in [(3, "STUCK"), (5, "EXCEPTION")] {
            let text = format!(
                r#"{{"test_results":{{"test/A.t.sol:A":[{{"name":"check_x()","exitcode":{code}}}]}}}}"#
            );
            let o = parse_halmos(&text, None).expect("report");
            assert_eq!(o[0].status, Status::Inconclusive);
            assert!(o[0].reason.as_deref().unwrap_or_default().contains(want));
        }
        let odd = parse_halmos(
            r#"{"test_results":{"test/A.t.sol:A":[{"name":"check_x()","exitcode":9}]}}"#,
            None,
        )
        .expect("report");
        assert_eq!(odd[0].status, Status::Inconclusive);
        assert!(parse_halmos("not json", None).is_err());
        assert!(parse_halmos("{}", None).is_err());
    }

    // The Echidna fixtures follow lib/Echidna/Output/JSON.hs and
    // lib/Echidna/UI.hs at crytic/echidna fb0fd78b (2026-11-06): log lines,
    // then the campaign on one line. No release binary could be downloaded
    // where they were written.
    #[test]
    fn a_real_echidna_report_names_no_test_and_is_refused() {
        for f in ["echidna/passed.json", "echidna/solved.json"] {
            let e = parse_echidna(&fixture(f), &[]).expect_err(f);
            assert_eq!(
                e.0,
                "the Echidna report does not name its tests (each is \"name\"), so its results cannot be tied to nodes: write Echidna's text summary instead, with `--format text > <report>` in the check's command"
            );
        }
    }

    #[test]
    fn reads_an_echidna_campaign_with_named_tests() {
        let cmd: Vec<String> = vec![
            "sh".into(),
            "-c".into(),
            "echidna . --test-limit 5000 --seq-len 50 --format json > e.json".into(),
        ];
        assert_eq!(echidna_how(&cmd).shown(), "fuzzed 5000x50");
        // The fixture's shape with the names Echidna's text output gives.
        let named = |tests: &str| {
            format!(
                "[2026-11-17 10:00:03.01] [status] tests: 1/5, fuzzing: 5000/5000\n{{\"success\":true,\"error\":null,\"tests\":[{tests}],\"seed\":42,\"coverage\":{{}}}}"
            )
        };
        let test = |name: &str, status: &str, error: &str, txs: &str| {
            format!(
                r#"{{"contract":"VaultEchidna","name":"{name}","status":"{status}","error":{error},"reason":null,"events":[],"type":"property","transactions":{txs}}}"#
            )
        };
        let txs = r#"[{"contract":"","function":"deposit","arguments":["1"],"gas":"12500000","gasprice":"0","value":"0"},{"contract":"","function":"*wait*","arguments":null,"gas":"12500000","gasprice":"0","value":"0"},{"contract":"","function":"withdraw","arguments":["1",["2","3"]],"gas":"12500000","gasprice":"0","value":"0"}]"#;
        let text = named(
            &[
                test("echidna_shares_backed", "fuzzing", "null", "null"),
                test("echidna_assets_match_flows", "solved", "null", txs),
                test("echidna_fees_bounded", "shrinking", "null", txs),
                test(
                    "echidna_never_reverts",
                    "error",
                    r#""VM attempted an illegal operation: x""#,
                    "null",
                ),
                test("echidna_odd", "paused", "null", "null"),
            ]
            .join(","),
        );
        let o = parse_echidna(&text, &cmd).expect("report");
        // Unbroken at the end of a normal campaign: Echidna still says fuzzing.
        let open = by_name(&o, "echidna_shares_backed");
        assert_eq!((open.status, open.reason.as_deref()), (Status::Pass, None));
        assert_eq!(open.contract, "VaultEchidna");
        assert_eq!(open.guarantee().shown(), "fuzzed 5000x50");
        let solved = by_name(&o, "echidna_assets_match_flows");
        assert_eq!(solved.status, Status::Fail);
        assert_eq!(
            solved.reason.as_deref(),
            Some(r#"falsified by: deposit(1) -> *wait* -> withdraw(1, ["2","3"])"#)
        );
        let shrinking = by_name(&o, "echidna_fees_bounded");
        assert_eq!(shrinking.status, Status::Fail);
        assert!(
            shrinking
                .reason
                .as_deref()
                .unwrap_or_default()
                .starts_with("falsified (not fully shrunk) by: deposit(1)")
        );
        let error = by_name(&o, "echidna_never_reverts");
        assert_eq!(error.status, Status::Inconclusive);
        assert_eq!(
            error.reason.as_deref(),
            Some("echidna could not evaluate the test: VM attempted an illegal operation: x")
        );
        assert_eq!(by_name(&o, "echidna_odd").status, Status::Inconclusive);
        for status in ["passed", "verified"] {
            let o = parse_echidna(&named(&test("echidna_x", status, "null", "null")), &[])
                .expect("report");
            assert_eq!(o[0].status, Status::Pass);
        }
        assert!(
            parse_echidna(
                r#"{"success":false,"error":"compilation failed","tests":[]}"#,
                &[]
            )
            .is_err()
        );
    }

    // Echidna's text summary, written from crytic/echidna fb0fd78b
    // (2026-11-06): log lines (lib/Echidna/UI/Report.hs:33-46), the
    // `[status]` lines (lib/Echidna/UI.hs:219-236, timePrefix in
    // lib/Echidna/Utility.hs:27-29), then ppCampaign (Report.hs:63-79) with
    // ppTests (Report.hs:219-237), ppTS and ppOPT (Report.hs:184-204),
    // ppFail (Report.hs:150-163), ppOptimized (Report.hs:206-216) and ppTx
    // (Report.hs:81-104, ppDelay 130-133). The trace lines stand for hevm's
    // trace tree and are not read. Not output of a real campaign: no
    // release binary could be downloaded where this was written.
    const ECHIDNA_TEXT: &str = concat!(
        "[2026-11-17 10:00:00.12] [Worker 0] New coverage: 812 instr, 2 contracts, 1 seqs in corpus (deposit)\n",
        "[2026-11-17 10:00:01.40] [Worker 0] Test echidna_assets_match_flows falsified!\n",
        "  Call sequence:\n",
        "VaultEchidna.deposit(1)\n",
        "VaultEchidna.withdraw(1)\n",
        "\n",
        "[2026-11-17 10:00:03.01] [status] tests: 2/6, fuzzing: 5000/5000, values: [7], cov: 812, corpus: 3, shrinking: W0:12/5000(2), gas/s: 41000\n",
        "[2026-11-17 10:00:03.02] [Worker 0] Test limit reached. Stopping.\n",
        "[2026-11-17 10:00:03.05] [status] tests: 2/6, fuzzing: 5000/5000, values: [7], cov: 812, corpus: 3, gas/s: 0\n",
        "echidna_shares_backed: passing\n",
        "echidna_assets_match_flows: failed!\u{1F4A5}  \n",
        "  Reason: ReturnFalse\n",
        "  Call sequence:\n",
        "    VaultEchidna.deposit(1) from: 0x0000000000000000000000000000000000010000\n",
        "    *wait* Time delay: 5 seconds Block delay: 2\n",
        "    VaultEchidna.withdraw(1) from: 0x0000000000000000000000000000000000020000\n",
        "\n",
        "Traces: \n",
        "call VaultEchidna::echidna_assets_match_flows() (test/VaultEchidna.sol:21)\n",
        "\u{2514}\u{2574}\u{2190} (false)\n",
        "\n",
        "withdraw(uint256): passing\n",
        "echidna_fees_bounded: failed!\u{1F4A5}  \n",
        "  Reason: ReturnFalse\n",
        "  Call sequence, shrinking 12/5000:\n",
        "    VaultEchidna.deposit(2)\n",
        "    VaultEchidna.skim()\n",
        "\n",
        "Traces: \n",
        "call VaultEchidna::echidna_fees_bounded() (test/VaultEchidna.sol:25)\n",
        "\n",
        "echidna_never_reverts: could not evaluate \u{2623}\n",
        "  VM attempted an illegal operation: StackUnderrun\n",
        "echidna_max_fee: max value: 7\n",
        "\n",
        "  Call sequence:\n",
        "    VaultEchidna.deposit(7)\n",
        "\n",
        "Traces: \n",
        "call VaultEchidna::echidna_max_fee() (test/VaultEchidna.sol:29)\n",
        "\n",
        "\n",
        "Unique instructions: 812\n",
        "Unique codehashes: 2\n",
        "Corpus size: 3\n",
        "Seed: 42\n",
        "Total calls: 5000\n",
        "\n",
    );

    fn echidna_cmd(line: &str) -> Vec<String> {
        vec!["sh".into(), "-c".into(), line.into()]
    }

    #[test]
    fn reads_the_echidna_text_summary() {
        let cmd = echidna_cmd(
            "echidna . --contract VaultEchidna --config echidna.yaml --test-limit 5000 --seq-len 50 --format text > echidna.txt",
        );
        let o = parse_echidna(ECHIDNA_TEXT, &cmd).expect("summary");
        // The log's call sequence above the last status line is no test.
        assert_eq!(o.len(), 6, "{o:?}");
        let open = by_name(&o, "echidna_shares_backed");
        assert_eq!((open.status, open.reason.as_deref()), (Status::Pass, None));
        assert_eq!(open.contract, "VaultEchidna");
        assert_eq!(open.guarantee().shown(), "fuzzed 5000x50");
        let solved = by_name(&o, "echidna_assets_match_flows");
        assert_eq!(solved.status, Status::Fail);
        assert_eq!(
            solved.reason.as_deref(),
            Some(
                "falsified by: VaultEchidna.deposit(1) from: 0x0000000000000000000000000000000000010000 -> *wait* Time delay: 5 seconds Block delay: 2 -> VaultEchidna.withdraw(1) from: 0x0000000000000000000000000000000000020000"
            )
        );
        // An assertion test prints its signature; its name is the function.
        assert_eq!(by_name(&o, "withdraw").status, Status::Pass);
        let shrinking = by_name(&o, "echidna_fees_bounded");
        assert_eq!(shrinking.status, Status::Fail);
        assert_eq!(
            shrinking.reason.as_deref(),
            Some("falsified (not fully shrunk) by: VaultEchidna.deposit(2) -> VaultEchidna.skim()")
        );
        let error = by_name(&o, "echidna_never_reverts");
        assert_eq!(error.status, Status::Inconclusive);
        assert_eq!(
            error.reason.as_deref(),
            Some(
                "echidna could not evaluate the test: VM attempted an illegal operation: StackUnderrun"
            )
        );
        let max = by_name(&o, "echidna_max_fee");
        assert_eq!(max.status, Status::Inconclusive);
        assert_eq!(
            max.reason.as_deref(),
            Some("an optimization test reports a maximum (7), not a verdict")
        );
        // Without --contract, no contract is claimed.
        let o = parse_echidna(ECHIDNA_TEXT, &[]).expect("summary");
        assert!(o.iter().all(|x| x.contract.is_empty()));
    }

    #[test]
    fn reads_the_other_echidna_statuses_and_refuses_what_it_does_not_know() {
        let summary = |tests: &str| {
            format!(
                "[2026-11-17 10:00:03.05] [status] tests: 0/1, fuzzing: 0/5000, values: [], cov: 0, corpus: 0, gas/s: 0\n{tests}\nUnique instructions: 1\nUnique codehashes: 1\nCorpus size: 0\nSeed: 1\nTotal calls: 0\n\n"
            )
        };
        let read = |tests: &str| parse_echidna(&summary(tests), &[]);
        let o = read(concat!(
            "echidna_a:  passed! \u{1F389}\n",
            "echidna_b: verified \u{2705}\n",
            "echidna_c: failed!\u{1F4A5}  \n",
            "  Reason: ReturnFalse\n",
            "  No transactions were needed to reach the failure.\n",
            "echidna_d: max value: -3\n",
            "could not evaluate \u{2623}\n",
            "  VM attempted an illegal operation: x\n",
            "echidna_e: max value: 0\n",
            " passed! \u{1F389}\n",
        ))
        .expect("summary");
        assert_eq!(by_name(&o, "echidna_a").status, Status::Pass);
        assert_eq!(by_name(&o, "echidna_b").status, Status::Pass);
        let c = by_name(&o, "echidna_c");
        assert_eq!(
            (c.status, c.reason.as_deref()),
            (Status::Fail, Some("falsified with no transactions"))
        );
        let d = by_name(&o, "echidna_d");
        assert_eq!(
            (d.status, d.reason.as_deref()),
            (
                Status::Inconclusive,
                Some("echidna could not evaluate the test: VM attempted an illegal operation: x")
            )
        );
        assert_eq!(by_name(&o, "echidna_e").status, Status::Inconclusive);
        assert!(read("").expect("summary").is_empty());

        // A status this version does not know is never a pass.
        let e = read("echidna_a: passing\necho_b: timed out\n").expect_err("unknown");
        assert_eq!(
            e.0,
            "the Echidna summary has a line vibloom does not know after echidna_a: echo_b: timed out"
        );
        assert!(read("echidna_a: timed out\n").is_err());
        let twice = read("f(uint256): passing\nf(address): passing\n").expect_err("twice");
        assert!(twice.0.contains("names two tests f,"), "{}", twice.0);
        // --format none prints the status lines and no summary.
        let none = parse_echidna(
            "[2026-11-17 10:00:03.05] [status] tests: 0/1, fuzzing: 5000/5000, values: [], cov: 9, corpus: 1, gas/s: 0\n",
            &[],
        )
        .expect_err("none");
        assert!(none.0.contains("holds no final summary"), "{}", none.0);
        assert!(parse_echidna("", &[]).is_err());
    }

    #[test]
    fn reads_a_flag_s_value() {
        let cmd = echidna_cmd("echidna . --contract=VaultEchidna --contract-addr 0x1");
        assert_eq!(
            flag_value(&cmd, "--contract").as_deref(),
            Some("VaultEchidna")
        );
        let cmd = echidna_cmd("echidna . --contract-addr 0x1 --contract 'VaultEchidna'");
        assert_eq!(
            flag_value(&cmd, "--contract").as_deref(),
            Some("VaultEchidna")
        );
        assert_eq!(flag_value(&echidna_cmd("echidna ."), "--contract"), None);
    }

    #[test]
    fn reads_flags_written_either_way() {
        let c = |s: &[&str]| s.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
        assert_eq!(
            flag_number(&c(&["halmos", "--loop", "4"]), "--loop"),
            Some(4)
        );
        assert_eq!(flag_number(&c(&["halmos", "--loop=8"]), "--loop"), Some(8));
        assert_eq!(flag_number(&c(&["halmos", "--loops", "3"]), "--loop"), None);
        assert_eq!(flag_number(&c(&["halmos"]), "--loop"), None);
    }
}
