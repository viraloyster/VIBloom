//! Running the tests and recording the run in the log.

use crate::cli::Fallible;
use crate::derive::{NodeView, derive};
use crate::forge::{Outcome, RunnerOutputError, parse_forge};
use crate::git::uncommitted;
use crate::junit::parse_junit;
use crate::log::{RunBody, RunEntry, next_entry, to_line};
use crate::map::{LOG_PATH, RootsMap};
use crate::proc::run_child;
use crate::store::{append, hash_watched, iso_now, load_log, load_map, locked};
use std::path::Path;

pub struct RunReport {
    pub entry: RunEntry,
    pub views: Vec<NodeView>,
}

pub fn run(root: &Path, extra: &[String]) -> Fallible<RunReport> {
    let map = load_map(root)?;
    let log = load_log(root);
    if !log.problems.is_empty() {
        return Err(format!(
            "{LOG_PATH} failed verification:\n- {}\nA verifier can set the broken part aside with `vibloom repair`.",
            log.problems.join("\n- ")
        ));
    }
    // Hashed before the run: these are the files the tests ran against.
    let files = hash_watched(root, &map);
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
            return Err(format!(
                "{LOG_PATH} failed verification:\n- {}",
                log.problems.join("\n- ")
            ));
        }
        let entry = next_entry(
            log.entries.last(),
            RunBody {
                at: iso_now(),
                command,
                outcomes,
                files,
                error,
            },
        );
        append(root, LOG_PATH, &to_line(&entry))?;
        Ok((entry, log.entries))
    })?;
    entries.push(entry.clone());
    let views = derive(
        &map,
        &entries,
        &hash_watched(root, &map),
        &uncommitted(root, &map, false),
    );
    Ok(RunReport { entry, views })
}

/// The line that says what a run recorded. Failures are counted too: a test
/// no node rests on can fail without any node needing attention, and that
/// must not read as a clean run.
pub fn recorded(entry: &RunEntry, map: &RootsMap) -> String {
    let n = entry.outcomes.len();
    let failed: Vec<_> = entry
        .outcomes
        .iter()
        .filter(|o| o.status == crate::forge::Status::Fail)
        .collect();
    let mut line = format!(
        "Run {}: {n} test {} recorded",
        entry.seq,
        if n == 1 { "result" } else { "results" }
    );
    if !failed.is_empty() {
        let loose = failed
            .iter()
            .filter(|o| !map.nodes.iter().any(|nd| crate::derive::matches(nd, o)))
            .count();
        line.push_str(&format!(", {} failed", failed.len()));
        if loose > 0 {
            line.push_str(&format!(
                " ({loose} tied to no node, so no state shows them)"
            ));
        }
    }
    line.push('.');
    line
}
