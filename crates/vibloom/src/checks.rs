//! Reports of tools other than the project's runner: Halmos (`--json-output`)
//! and Echidna (`--format json`). Each result keeps the kind of guarantee it
//! gives, and anything short of a verdict stays short of one: a timeout is
//! never a pass, and never a failure either.

use crate::forge::{How, HowKind, Outcome, RunnerOutputError, Status};
use crate::map::{Tool, test_name};
use crate::proc::last_json;
use serde_json::Value;

/// The value after a flag in a command, as `--loop 4` or `--loop=4`, also
/// inside a shell line (`sh -c "echidna ... --test-limit 5000"`).
pub fn flag_number(command: &[String], flag: &str) -> Option<u64> {
    let words: Vec<&str> = command.iter().flat_map(|a| a.split_whitespace()).collect();
    words.iter().enumerate().find_map(|(i, w)| {
        let v = match w.strip_prefix(flag) {
            Some("") => words.get(i + 1).copied(),
            Some(rest) => rest.strip_prefix('='),
            None => None,
        };
        v.and_then(|v| v.trim_matches(['"', '\'']).parse().ok())
    })
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

// "deposit(1) -> withdraw(1)": the calls that break the property.
fn transactions_text(txs: Option<&Value>) -> Option<String> {
    let calls: Vec<String> = txs?
        .as_array()?
        .iter()
        .filter_map(|t| {
            let f = t.get("function").and_then(Value::as_str)?;
            let args: Vec<String> = t
                .get("arguments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|a| a.as_str().map_or_else(|| a.to_string(), str::to_string))
                .collect();
            Some(format!("{f}({})", args.join(", ")))
        })
        .collect();
    (!calls.is_empty()).then(|| calls.join(" -> "))
}

/// Echidna `--format json`: one campaign, `{success, error, tests}`, each
/// test `{contract, name, status, error, transactions}`. Its runs and
/// sequence length are not in the report; the command may set them.
pub fn parse_echidna(text: &str, how: How) -> Result<Vec<Outcome>, RunnerOutputError> {
    let report = last_json(text)
        .ok_or_else(|| RunnerOutputError("the Echidna report could not be parsed".into()))?;
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
        if s("name").is_empty() {
            continue;
        }
        let (status, reason) = match s("status") {
            "passed" | "verified" => (Status::Pass, None),
            "solved" => (
                Status::Fail,
                Some(clip(&match transactions_text(t.get("transactions")) {
                    Some(calls) => format!("falsified by: {calls}"),
                    None => "falsified (the report lists no transactions)".into(),
                })),
            ),
            other => (
                Status::Inconclusive,
                Some(clip(&format!(
                    "echidna did not finish: the test is {}{}",
                    if other.is_empty() {
                        "without a status"
                    } else {
                        other
                    },
                    match s("error") {
                        "" => String::new(),
                        e => format!(" ({e})"),
                    }
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

    // The Echidna fixtures follow its documented `--format json` shape; the
    // release binary could not be downloaded where they were written.
    #[test]
    fn reads_an_echidna_campaign() {
        let how = echidna_how(&[
            "sh".into(),
            "-c".into(),
            "echidna . --test-limit 5000 --seq-len 50 --format json > e.json".into(),
        ]);
        assert_eq!(how.shown(), "fuzzed 5000x50");
        let ok = parse_echidna(&fixture("echidna/passed.json"), how.clone()).expect("report");
        assert!(ok.iter().all(|o| o.status == Status::Pass));
        assert_eq!(ok[0].contract, "VaultEchidna");

        let bad = parse_echidna(&fixture("echidna/solved.json"), How::of(HowKind::Fuzzed))
            .expect("report");
        let solved = by_name(&bad, "echidna_assets_match_flows");
        assert_eq!(solved.status, Status::Fail);
        assert_eq!(
            solved.reason.as_deref(),
            Some("falsified by: deposit(1) -> withdraw(1)")
        );
        let open = by_name(&bad, "echidna_shares_backed");
        assert_eq!(open.status, Status::Inconclusive);
        assert_eq!(
            open.reason.as_deref(),
            Some("echidna did not finish: the test is fuzzing")
        );
        assert_eq!(
            by_name(&bad, "echidna_never_reverts").reason.as_deref(),
            Some("echidna did not finish: the test is error (Revert)")
        );
        assert!(
            parse_echidna(
                r#"{"success":false,"error":"compilation failed","tests":[]}"#,
                how
            )
            .is_err()
        );
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
