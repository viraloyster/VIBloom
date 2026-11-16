use crate::cli::{Args, Fallible, Io};
use crate::derive::{NodeView, label, needs_attention, shown, summary_line, troubled, why};
use crate::guard::GuardChange;
use crate::log::RunEntry;
use crate::map::RootsMap;
use crate::paths::relative_to;
use crate::runner::{Failures, failures};
use crate::store::{load_log, load_map, views};
use serde_json::{Value, json};
use std::path::Path;

pub fn table(vs: &[NodeView], strict: bool) -> String {
    if vs.is_empty() {
        return "The map has no nodes yet. Run `vibloom scan` or edit .vibloom/roots.json.".into();
    }
    let w = vs.iter().map(|v| shown(v).len()).max().unwrap_or(0);
    let iw = vs.iter().map(|v| v.id.len()).max().unwrap_or(0);
    // What needs attention first; on a long map it must not be looked for.
    let mut rows: Vec<&NodeView> = vs.iter().collect();
    rows.sort_by_key(|v| !needs_attention(v, strict));
    let mut out = vec![summary_line(vs, strict)];
    out.extend(
        rows.iter()
            .map(|v| format!("{:w$}  {:iw$}  {}", shown(v), v.id, v.title)),
    );
    let open = not_reviewed(vs);
    if !open.is_empty() {
        out.push(String::new());
        out.push("Not yet reviewed (yours to decide: adopt it or switch it off):".into());
        out.extend(open.iter().map(|(id, _)| {
            format!("- {id}: vibloom edit {id} --stance adopted   (or --stance off)")
        }));
    }
    let risks = accepted_risks(vs);
    if !risks.is_empty() {
        out.push(String::new());
        out.push("Accepted risks:".into());
        out.extend(risks);
    }
    out.join("\n")
}

fn not_reviewed(vs: &[NodeView]) -> Vec<(&str, &str)> {
    vs.iter()
        .filter(|v| crate::derive::unreviewed(v))
        .map(|v| (v.id.as_str(), v.title.as_str()))
        .collect()
}

// Each risk a node accepts, with its reason, so an accepted weakness is never
// out of sight; one no longer in effect is pointed out for removal.
fn accepted_risks(vs: &[NodeView]) -> Vec<String> {
    vs.iter()
        .flat_map(|v| {
            v.accepts.iter().map(|a| {
                if a.in_effect {
                    format!("- {} accepts {} being off: {}", v.id, a.id, a.reason)
                } else {
                    format!(
                        "- {} accepts {} being off, but it is on again: remove it with `vibloom edit {} --unaccept {}`",
                        v.id, a.id, v.id, a.id
                    )
                }
            })
        })
        .collect()
}

// An escape from "a red suite is red" stays in sight for as long as it is
// in the map.
fn ignoring(map: &RootsMap, f: Option<&Failures>) -> Option<String> {
    if map.ignore_failures.is_empty() {
        return None;
    }
    let n = f.map_or(0, |f| f.ignored.len());
    Some(format!(
        "\nIgnoring {n} failing {} by rule (in the latest run; ignore_failures: {}).",
        if n == 1 { "test" } else { "tests" },
        map.ignore_failures.join(", ")
    ))
}

/// What `--base` found, for the report.
pub(crate) struct GuardReport {
    pub(crate) base: String,
    pub(crate) base_has_map: bool,
    pub(crate) allowed: bool,
    pub(crate) changes: Vec<GuardChange>,
}

/// Everything `status --json` and `check --json` print, in one shape.
pub(crate) struct Report<'a> {
    pub(crate) exit: i32,
    pub(crate) strict: bool,
    pub(crate) views: &'a [NodeView],
    pub(crate) guard: Option<&'a GuardReport>,
    pub(crate) run: Option<&'a RunEntry>,
    /// The failing tests of the run (`check`) or of the latest one (`status`).
    pub(crate) failures: Option<&'a Failures>,
    pub(crate) ignore_failures: &'a [String],
    pub(crate) log_problems: &'a [String],
    pub(crate) tool_error: Option<&'a str>,
}

// The files a node is about: its test first, then what it watches.
pub(crate) fn node_files(v: &NodeView) -> Vec<String> {
    let mut out: Vec<String> = v.test_file.iter().cloned().collect();
    out.extend(
        v.watch
            .iter()
            .filter(|w| !out.contains(w))
            .cloned()
            .collect::<Vec<_>>(),
    );
    out
}

pub(crate) fn to_json(r: &Report) -> Value {
    let vs = r.views;
    let nodes: Vec<Value> = vs
        .iter()
        .map(|v| {
            json!({
                "id": v.id,
                "kind": v.kind,
                "title": v.title,
                "stance": v.stance,
                "state": label(v),
                "shown": shown(v),
                "troubled": troubled(v),
                "needs_attention": needs_attention(v, r.strict),
                "reason": why(v),
                "files": node_files(v),
                "changed": v.changed,
                "rests_on_unreviewed": v.unreviewed,
                "run": v.run,
                "fuzz": v.fuzz,
                "how": v.how.as_ref().map(|h| json!({
                    "kind": h.kind,
                    "runs": h.runs,
                    "depth": h.depth,
                    "loop": h.loop_bound,
                    "shown": h.shown(),
                })),
            })
        })
        .collect();
    let open: Vec<Value> = not_reviewed(vs)
        .iter()
        .map(|(id, title)| {
            json!({
                "id": id,
                "title": title,
                "adopt": format!("vibloom edit {id} --stance adopted"),
                "switch_off": format!("vibloom edit {id} --stance off"),
            })
        })
        .collect();
    let risks: Vec<Value> = vs
        .iter()
        .flat_map(|v| {
            v.accepts.iter().map(|a| {
                json!({ "node": v.id, "dependency": a.id, "reason": a.reason, "in_effect": a.in_effect })
            })
        })
        .collect();
    json!({
        "format": 1,
        "exit": r.exit,
        "summary": {
            "nodes": vs.len(),
            "need_attention": vs.iter().filter(|v| needs_attention(v, r.strict)).count(),
            "not_yet_reviewed": open.len(),
            "accepted_risks": risks.len(),
            "strict": r.strict,
        },
        "nodes": nodes,
        "not_yet_reviewed": open,
        "accepted_risks": risks,
        "guard": r.guard.map(|g| json!({
            "base": g.base,
            "base_has_map": g.base_has_map,
            "allowed": g.allowed,
            "changes": g.changes,
        })),
        "run": r.run.map(|e| json!({ "seq": e.seq, "command": e.command, "error": e.error })),
        "failures": r.failures.map(|f| json!({
            "failed": f.failed,
            "untracked": f.untracked,
            "ignored": f.ignored,
        })),
        "ignore_failures": r.ignore_failures,
        "log_problems": r.log_problems,
        "tool_error": r.tool_error,
    })
}

/// The JSON printed when vibloom could not do its job at all (exit 2).
pub(crate) fn error_json(e: &str) -> String {
    to_json(&Report {
        exit: 2,
        strict: false,
        views: &[],
        guard: None,
        run: None,
        failures: None,
        ignore_failures: &[],
        log_problems: &[],
        tool_error: Some(e),
    })
    .to_string()
}

pub(crate) fn status(root: &Path, io: &mut Io, as_json: bool, strict: bool) -> Fallible<i32> {
    let map = load_map(root)?;
    let strict = strict || map.strict;
    let vs = views(root)?;
    let log = load_log(root);
    let problems = log.problems;
    let fails = log.entries.last().map(|e| failures(e, &map));
    // A damaged record is the guard failing at its job, not a verdict.
    let exit = if !problems.is_empty() {
        2
    } else {
        i32::from(vs.iter().any(|v| needs_attention(v, strict)))
    };
    if !problems.is_empty() {
        (io.err)(&format!(
            "The local run log failed verification; only runs before the break count:\n- {}",
            problems.join("\n- ")
        ));
    }
    if as_json {
        (io.out)(
            &to_json(&Report {
                exit,
                strict,
                views: &vs,
                guard: None,
                run: None,
                failures: fails.as_ref(),
                ignore_failures: &map.ignore_failures,
                log_problems: &problems,
                tool_error: (!problems.is_empty())
                    .then_some("the local run log failed verification"),
            })
            .to_string(),
        );
    } else {
        (io.out)(&table(&vs, strict));
        if let Some(line) = ignoring(&map, fails.as_ref()) {
            (io.out)(&line);
        }
    }
    Ok(exit)
}

pub(crate) fn context(root: &Path, io: &mut Io, args: &Args) -> Fallible<i32> {
    let file = match args.words.first() {
        None => None,
        Some(f) => Some(
            relative_to(root, &io.cwd, f).ok_or_else(|| format!("{f} is outside the project."))?,
        ),
    };
    (io.out)(&crate::context::context(&views(root)?, file.as_deref()));
    Ok(0)
}

pub(crate) fn verify(root: &Path, io: &mut Io) -> Fallible<i32> {
    let log = load_log(root);
    if !log.problems.is_empty() {
        (io.err)(&log.problems.join("\n"));
        return Ok(1);
    }
    (io.out)(&format!("{} runs, chain intact.", log.entries.len()));
    Ok(0)
}
