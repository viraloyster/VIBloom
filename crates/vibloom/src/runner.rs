//! Running the tests and recording the run in the local log.

use crate::cli::Fallible;
use crate::derive::{Evidence, NodeView, Snapshot, derive, matches, node_digest};
use crate::forge::{Outcome, RunnerOutputError, parse_forge};
use crate::git::uncommitted;
use crate::junit::parse_junit;
use crate::log::{RunBody, RunEntry, next_entry, to_line};
use crate::map::RootsMap;
use crate::proc::run_child;
use crate::store::{
    append, hash_watched, iso_now, load_log, load_map, locked, log_path, write_snapshot,
};
use std::path::Path;

pub struct RunReport {
    pub entry: RunEntry,
    /// From every recorded run, as `status` reads them.
    pub views: Vec<NodeView>,
    /// From this run alone: what `check` decides on, so nothing recorded
    /// before, here or anywhere else, can make a node hold.
    pub fresh: Vec<NodeView>,
}

const LOG_BROKEN: &str = "The local run log failed verification";

pub fn run(root: &Path, extra: &[String]) -> Fallible<RunReport> {
    let map = load_map(root)?;
    let log = load_log(root);
    if !log.problems.is_empty() {
        return Err(format!(
            "{LOG_BROKEN}:\n- {}\nA verifier can set the broken part aside with `vibloom repair`.",
            log.problems.join("\n- ")
        ));
    }
    // Hashed before the run: these are the files the tests ran against.
    let files = hash_watched(root, &map);
    let digests = map
        .nodes
        .iter()
        .filter(|n| n.test.is_some())
        .map(|n| (n.id.clone(), node_digest(n, &files)))
        .collect();
    let mut command = map.runner.clone();
    command.extend(extra.iter().cloned());
    let (exe, args) = command.split_first().ok_or("the runner is empty")?;
    // A report left by an earlier run must never be read as this run's.
    if let Some(report) = &map.report {
        let path = root.join(report);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("could not remove the old report {report}: {e}"))?;
        }
    }
    let mut outcomes: Vec<Outcome> = vec![];
    let mut error = None;
    match run_child(exe, args, root, map.timeout) {
        Err(e) => error = Some(e),
        Ok(res) => {
            let stdout = res.stdout;
            let parsed = match &map.report {
                None => parse_forge(&stdout),
                Some(report) => match std::fs::read_to_string(root.join(report)) {
                    Ok(xml) => parse_junit(&xml, &root.to_string_lossy()),
                    Err(_) => Err(RunnerOutputError(format!(
                        "the runner wrote no report at {report}"
                    ))),
                },
            };
            match parsed {
                Ok(o) => outcomes = o,
                Err(e) => {
                    let stderr = res.stderr;
                    let src = if stderr.trim().is_empty() {
                        stdout
                    } else {
                        stderr
                    };
                    let lines: Vec<&str> = src.trim().lines().collect();
                    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
                    error = Some(if tail.is_empty() {
                        e.0
                    } else {
                        format!("{}\n{tail}", e.0)
                    });
                }
            }
        }
    }
    // The tests may have taken minutes and another run may have been recorded
    // meanwhile: the entry is chained to the log as it is now, under the lock.
    let (entry, mut entries) = locked(root, || {
        let log = load_log(root);
        if !log.problems.is_empty() {
            return Err(format!("{LOG_BROKEN}:\n- {}", log.problems.join("\n- ")));
        }
        let entry = next_entry(
            log.entries.last(),
            RunBody {
                at: iso_now(),
                command,
                outcomes,
                digests,
                error,
            },
        );
        append(&log_path(root), &to_line(&entry))?;
        write_snapshot(
            root,
            &Snapshot {
                seq: entry.seq,
                files: files.clone(),
            },
        )?;
        Ok((entry, log.entries))
    })?;
    entries.push(entry.clone());
    let snap = Snapshot {
        seq: entry.seq,
        files,
    };
    let current = hash_watched(root, &map);
    let changed = uncommitted(root, &map, false);
    let views = derive(&map, &entries, &current, Some(&snap), &changed);
    let mut fresh = derive(
        &map,
        std::slice::from_ref(&entry),
        &current,
        Some(&snap),
        &changed,
    );
    // The whole suite ran without a test that an earlier run had: it is gone,
    // which says more than "untested".
    if entry.error.is_none() && entry.command == map.runner {
        for v in fresh
            .iter_mut()
            .filter(|v| v.evidence == Evidence::Untested)
        {
            let Some(n) = map.nodes.iter().find(|n| n.id == v.id) else {
                continue;
            };
            if let Some(e) = entries
                .iter()
                .rev()
                .find(|e| e.outcomes.iter().any(|o| matches(n, o)))
                .filter(|e| e.seq != entry.seq)
            {
                v.evidence = Evidence::Missing;
                v.reason = Some(format!(
                    "its test last ran in run {} and was not in run {}",
                    e.seq, entry.seq
                ));
            }
        }
    }
    Ok(RunReport {
        entry,
        views,
        fresh,
    })
}

/// The failing tests of a run that no node rests on, by name: those that
/// fail the check, and those the map's `ignore_failures` lets pass.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Failures {
    pub failed: usize,
    pub untracked: Vec<String>,
    pub ignored: Vec<String>,
}

pub fn failures(entry: &RunEntry, map: &RootsMap) -> Failures {
    let mut out = Failures::default();
    for o in entry
        .outcomes
        .iter()
        .filter(|o| o.status == crate::forge::Status::Fail)
    {
        out.failed += 1;
        if map.nodes.iter().any(|n| crate::derive::matches(n, o)) {
            continue;
        }
        let name = test_label(o);
        if ignored_by(map, o).is_some() {
            out.ignored.push(name);
        } else {
            out.untracked.push(name);
        }
    }
    out
}

fn test_label(o: &crate::forge::Outcome) -> String {
    if o.contract.is_empty() {
        o.name.clone()
    } else {
        format!("{}.{}", o.contract, o.name)
    }
}

/// The `ignore_failures` pattern that covers a test, if any: a glob on
/// `Contract.test` or on the test's file.
pub fn ignored_by<'a>(map: &'a RootsMap, o: &crate::forge::Outcome) -> Option<&'a str> {
    let label = test_label(o);
    map.ignore_failures
        .iter()
        .find(|p| glob(p, &label) || (!o.file.is_empty() && glob(p, &o.file)))
        .map(String::as_str)
}

// `*` stands for any run of characters, `?` for one; nothing else is special.
fn glob(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// The line that says what a run recorded, and the failing tests no node
/// rests on: they fail the check too, unless the map ignores them by rule.
pub fn recorded(entry: &RunEntry, map: &RootsMap) -> String {
    let n = entry.outcomes.len();
    let f = failures(entry, map);
    let mut line = format!(
        "Run {}: {n} test {} recorded",
        entry.seq,
        if n == 1 { "result" } else { "results" }
    );
    if f.failed > 0 {
        line.push_str(&format!(", {} failed", f.failed));
    }
    line.push('.');
    if !f.untracked.is_empty() {
        let shown: Vec<&str> = f.untracked.iter().take(5).map(String::as_str).collect();
        let more = f.untracked.len() - shown.len();
        line.push_str(&format!(
            "\n{} failing {} no node rests on, which still {} the check: {}{}.\nFix {}, or tie {} to a node; a test known to be red can be listed in \"ignore_failures\" in the map.",
            f.untracked.len(),
            if f.untracked.len() == 1 { "test" } else { "tests" },
            if f.untracked.len() == 1 { "fails" } else { "fail" },
            shown.join(", "),
            if more > 0 { format!(" and {more} more") } else { String::new() },
            if f.untracked.len() == 1 { "it" } else { "them" },
            if f.untracked.len() == 1 { "it" } else { "them" },
        ));
    }
    if !f.ignored.is_empty() {
        line.push_str(&format!(
            "\nIgnoring {} failing {} by rule (ignore_failures in the map).",
            f.ignored.len(),
            if f.ignored.len() == 1 {
                "test"
            } else {
                "tests"
            }
        ));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Outcome, Status};
    use crate::log::{RunBody, next_entry};
    use crate::map::parse_map;
    use serde_json::json;

    fn outcome(file: &str, contract: &str, name: &str, status: Status) -> Outcome {
        Outcome {
            file: file.into(),
            contract: contract.into(),
            name: name.into(),
            status,
            reason: None,
            fuzz: None,
        }
    }

    #[test]
    fn globs_match_whole_names() {
        assert!(glob("LegacyTest.*", "LegacyTest.test_old"));
        assert!(glob("test/legacy/*", "test/legacy/Old.t.sol"));
        assert!(glob("*.test_?", "A.test_x"));
        assert!(!glob("Legacy*", "VaultTest.test_x"));
        assert!(!glob("A.test", "A.test_x"));
    }

    #[test]
    fn counts_failures_no_node_rests_on_and_those_ignored_by_rule() {
        let map = parse_map(&json!({
            "version": 1,
            "ignore_failures": ["Legacy*"],
            "nodes": [{ "id": "inv.sum", "kind": "invariant", "title": "sum",
                        "test": { "file": "test/C.t.sol", "name": "invariant_sum" } }]
        }))
        .expect("valid");
        let entry = next_entry(
            None,
            RunBody {
                at: "t".into(),
                command: vec![],
                outcomes: vec![
                    outcome("test/C.t.sol", "CT", "invariant_sum", Status::Fail),
                    outcome("test/C.t.sol", "CT", "test_edge", Status::Fail),
                    outcome("test/L.t.sol", "LegacyTest", "test_old", Status::Fail),
                    outcome("test/C.t.sol", "CT", "test_ok", Status::Pass),
                ],
                digests: Default::default(),
                error: None,
            },
        );
        let f = failures(&entry, &map);
        assert_eq!(f.failed, 3);
        assert_eq!(f.untracked, vec!["CT.test_edge"]);
        assert_eq!(f.ignored, vec!["LegacyTest.test_old"]);
        let line = recorded(&entry, &map);
        assert!(
            line.contains(
                "1 failing test no node rests on, which still fails the check: CT.test_edge."
            ),
            "{line}"
        );
        assert!(line.contains("Ignoring 1 failing test by rule"), "{line}");
    }
}
