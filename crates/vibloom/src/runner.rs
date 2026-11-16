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
