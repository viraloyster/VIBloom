//! Reads `forge test --json`: one entry per suite ("path:Contract"), one result
//! per test. Only status and reason are kept; traces stay with Foundry.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Fail,
    Skip,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    pub file: String,
    pub contract: String,
    pub name: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct RunnerOutputError(pub String);

pub fn parse_forge(stdout: &str) -> Result<Vec<Outcome>, RunnerOutputError> {
    // Foundry may print notices before the JSON; the report is the last line
    // that opens an object.
    let line = stdout
        .lines()
        .map(str::trim)
        .rfind(|l| l.starts_with('{'))
        .ok_or_else(|| RunnerOutputError("the runner printed no JSON report".into()))?;
    let report: Value = serde_json::from_str(line)
        .map_err(|_| RunnerOutputError("the runner's JSON report could not be parsed".into()))?;
    let report = report
        .as_object()
        .ok_or_else(|| RunnerOutputError("the runner's report is not an object".into()))?;
    let mut out = Vec::new();
    for (suite, body) in report {
        let Some((file, contract)) = suite.rsplit_once(':') else {
            continue;
        };
        let Some(results) = body.get("test_results").and_then(Value::as_object) else {
            continue;
        };
        for (sig, r) in results {
            let status = match r.get("status").and_then(Value::as_str) {
                Some("Success") => Status::Pass,
                Some("Failure") => Status::Fail,
                Some("Skipped") => Status::Skip,
                _ => continue,
            };
            let reason = r
                .get("reason")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(500).collect());
            out.push(Outcome {
                file: file.into(),
                contract: contract.into(),
                name: sig.split('(').next().unwrap_or(sig).into(),
                status,
                reason,
            });
        }
    }
    Ok(out)
}

static FORGE_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bforge\s+test\b").expect("static regex"));

pub const FILTER_FLAGS: [&str; 12] = [
    "--match-path",
    "--mp",
    "--match-test",
    "--mt",
    "--match-contract",
    "--mc",
    "--no-match-path",
    "--nmp",
    "--no-match-test",
    "--nmt",
    "--no-match-contract",
    "--nmc",
];

/// The test filters of a `forge test` command line, to re-run the same subset.
pub fn forge_filters(command: &str) -> Option<Vec<String>> {
    let start = FORGE_TEST.find(command)?.start();
    let words: Vec<&str> = command[start..].split_whitespace().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        if w.contains([';', '&', '|']) {
            break;
        }
        let (flag, inline) = match w.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (w, None),
        };
        if FILTER_FLAGS.contains(&flag) {
            let value = match inline {
                Some(v) => Some(v),
                None => {
                    i += 1;
                    words.get(i).copied()
                }
            };
            if let Some(v) = value.filter(|v| !v.is_empty()) {
                out.push(flag.to_string());
                out.push(v.trim_matches(['"', '\'']).to_string());
            }
        }
        i += 1;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = r#"{"test/Counter.t.sol:CounterTest":{"duration":"1ms","test_results":{"invariant_totalMatchesAdded()":{"status":"Failure","reason":"total drifted: 1 != 0"},"invariant_totalBounded()":{"status":"Success","reason":null},"test_skipMe()":{"status":"Skipped","reason":null}},"warnings":[]}}"#;

    #[test]
    fn reads_every_result() {
        let mut out = parse_forge(&format!("Compiling...\n{REPORT}\n")).expect("report");
        out.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(out.len(), 3);
        assert_eq!(out[1].name, "invariant_totalMatchesAdded");
        assert_eq!(out[1].status, Status::Fail);
        assert_eq!(out[1].reason.as_deref(), Some("total drifted: 1 != 0"));
        assert_eq!(out[0].status, Status::Pass);
        assert_eq!(out[0].reason, None);
        assert_eq!(out[2].status, Status::Skip);
        assert_eq!(
            (out[0].file.as_str(), out[0].contract.as_str()),
            ("test/Counter.t.sol", "CounterTest")
        );
    }

    #[test]
    fn fails_loudly_without_a_report() {
        assert_eq!(
            parse_forge("Error: Compiler run failed:\nError (2314)"),
            Err(RunnerOutputError(
                "the runner printed no JSON report".into()
            ))
        );
    }

    #[test]
    fn keeps_the_subset_a_test_command_asked_for() {
        let s = |v: &[&str]| Some(v.iter().map(|x| (*x).to_string()).collect::<Vec<_>>());
        assert_eq!(
            forge_filters("forge test --match-path test/A.t.sol -vvv"),
            s(&["--match-path", "test/A.t.sol"])
        );
        assert_eq!(
            forge_filters("cd x && forge test --mt=invariant_a --mc 'Foo' | tail"),
            s(&["--mt", "invariant_a", "--mc", "Foo"])
        );
        assert_eq!(forge_filters("forge test"), s(&[]));
        assert_eq!(forge_filters("forge build"), None);
        assert_eq!(forge_filters("echo forge"), None);
    }
}
