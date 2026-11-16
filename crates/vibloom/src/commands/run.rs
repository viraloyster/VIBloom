use crate::cli::{Fallible, Io};
use crate::commands::status::{GuardReport, Report, node_files, table, to_json};
use crate::derive::{NodeView, label, needs_attention, troubled, unreviewed, why};
use crate::git::{files_at, git, is_commit, prefix, show_at};
use crate::guard::{Reader, file_changes, guarded_at_base, map_changes};
use crate::map::{MAP_PATH, RootsMap};
use crate::runner::{RunReport, failures, recorded, run};
use crate::store::{load_map, parse_map_text, views};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Format {
    Text,
    Json,
    Github,
}

impl Format {
    pub(crate) fn parse(s: &str) -> Fallible<Self> {
        match s {
            "text" => Ok(Self::Text),
            "json" => Ok(Self::Json),
            "github" => Ok(Self::Github),
            other => Err(format!("Unknown format {other}: use text, json or github.")),
        }
    }
}

pub(crate) struct CheckOpts<'a> {
    pub(crate) base: Option<&'a str>,
    pub(crate) allow_guard_changes: bool,
    pub(crate) strict: bool,
    pub(crate) format: Format,
}

fn before(root: &Path) -> Fallible<HashMap<String, &'static str>> {
    Ok(views(root)?
        .iter()
        .map(|v| (v.id.clone(), label(v)))
        .collect())
}

fn moved(before: &HashMap<String, &'static str>, after: &[NodeView]) -> Option<String> {
    let lines: Vec<String> = after
        .iter()
        .filter(|v| before.get(&v.id).copied() != Some(label(v)))
        .map(|v| {
            format!(
                "  {}: {} -> {}",
                v.id,
                before.get(&v.id).copied().unwrap_or("new"),
                label(v)
            )
        })
        .collect();
    (!lines.is_empty()).then(|| format!("Changed:\n{}", lines.join("\n")))
}

fn print_run(
    io: &mut Io,
    map: &RootsMap,
    report: &RunReport,
    vs: &[NodeView],
    strict: bool,
    was: &HashMap<String, &'static str>,
) {
    if let Some(e) = &report.entry.error {
        (io.err)(&format!(
            "Run {} recorded with an error: {e}",
            report.entry.seq
        ));
    }
    (io.out)(&recorded(&report.entry, map));
    if let Some(m) = moved(was, vs) {
        (io.out)(&m);
    }
    (io.out)(&table(vs, strict));
}

pub(crate) fn run_tests(root: &Path, io: &mut Io, extra: &[String]) -> Fallible<i32> {
    let map = load_map(root)?;
    let was = before(root)?;
    let report = run(root, extra)?;
    print_run(io, &map, &report, &report.views, map.strict, &was);
    Ok(if report.entry.error.is_some() {
        2
    } else {
        i32::from(report.views.iter().any(|v| needs_attention(v, map.strict)))
    })
}

/// Runs the tests and decides from that run alone. With a base, first
/// compares the guard with the base's map.
pub(crate) fn check(root: &Path, io: &mut Io, o: &CheckOpts, extra: &[String]) -> Fallible<i32> {
    let map = load_map(root)?;
    let strict = o.strict || map.strict;
    let guard = match o.base {
        Some(b) => Some(compare_base(root, b, &map, o.allow_guard_changes)?),
        None => None,
    };
    let was = before(root)?;
    let report = run(root, extra)?;
    let vs = &report.fresh;
    let error = report.entry.error.as_deref();
    let guard_fails = guard
        .as_ref()
        .is_some_and(|g| !g.changes.is_empty() && !g.allowed);
    // A red suite is red: a failing test no node rests on still fails, or an
    // approved change that guts the invariants could pass while a plain unit
    // test catches the bug.
    let fails = failures(&report.entry, &map);
    let exit = if error.is_some() {
        2
    } else {
        i32::from(
            guard_fails
                || !fails.untracked.is_empty()
                || vs.iter().any(|v| needs_attention(v, strict)),
        )
    };
    if o.format == Format::Json {
        (io.out)(
            &to_json(&Report {
                exit,
                strict,
                views: vs,
                guard: guard.as_ref(),
                run: Some(&report.entry),
                failures: Some(&fails),
                ignore_failures: &map.ignore_failures,
                log_problems: &[],
                tool_error: error
                    .map(|e| format!("the runner produced no report: {e}"))
                    .as_deref(),
            })
            .to_string(),
        );
        return Ok(exit);
    }
    if let Some(g) = &guard {
        (io.out)(&guard_text(g));
    }
    print_run(io, &map, &report, vs, strict, &was);
    if o.format == Format::Github {
        let pre = prefix(root).unwrap_or_default();
        for line in annotations(root, &map, vs, strict, guard.as_ref(), error, &pre) {
            (io.out)(&line);
        }
    }
    Ok(exit)
}

fn guard_text(g: &GuardReport) -> String {
    if !g.base_has_map {
        return format!(
            "{} has no {MAP_PATH} yet, so there is no guard to compare with.",
            g.base
        );
    }
    if g.changes.is_empty() {
        return format!("The guard is as it is on {}.", g.base);
    }
    let mut out = vec![format!("Guard changes against {}:", g.base)];
    out.extend(g.changes.iter().map(|c| format!("- {}", c.message)));
    out.push(if g.allowed {
        "Passed with --allow-guard-changes: a reviewer approved these guard changes.".into()
    } else {
        "These are guard changes: they weaken what the tests prove, so they need a person's review. Once a reviewer has approved them, run with --allow-guard-changes.".into()
    });
    out.join("\n")
}

fn compare_base(root: &Path, base: &str, head: &RootsMap, allowed: bool) -> Fallible<GuardReport> {
    if git(root, &["rev-parse", "--git-dir"]).is_err() {
        return Err(
            "`check --base` compares with a commit, so it runs only in a git repository.".into(),
        );
    }
    if !is_commit(root, base) {
        return Err(format!(
            "{base} is not a commit here (in CI, fetch the base branch first, for example with fetch-depth: 0)."
        ));
    }
    let pre = prefix(root)?;
    let mut report = GuardReport {
        base: base.to_string(),
        base_has_map: false,
        allowed,
        changes: vec![],
    };
    let Some(text) = show_at(root, base, &pre, MAP_PATH) else {
        return Ok(report);
    };
    let base_map = parse_map_text(&String::from_utf8_lossy(&text))
        .map_err(|e| format!("The map on {base} cannot be read: {e}"))?;
    report.base_has_map = true;
    let read_text =
        |f: &str| show_at(root, base, &pre, f).map(|b| String::from_utf8_lossy(&b).into_owned());
    let entries = guarded_at_base(&base_map, &read_text);
    let reader = Reader {
        base: &|f| show_at(root, base, &pre, f),
        now: &|f| fs::read(root.join(f)).ok(),
        base_dir: &|d| files_at(root, base, &pre, d),
    };
    report.changes = map_changes(&base_map, head);
    report.changes.extend(file_changes(&entries, &reader));
    Ok(report)
}

// GitHub reads workflow commands from the log: data escapes %, CR and LF,
// properties also ":" and ",".
fn esc(s: &str, property: bool) -> String {
    let mut out = s
        .replace('%', "%25")
        .replace('\r', "%0D")
        .replace('\n', "%0A");
    if property {
        out = out.replace(':', "%3A").replace(',', "%2C");
    }
    out
}

fn command(
    level: &str,
    file: Option<(String, Option<usize>)>,
    title: &str,
    message: &str,
) -> String {
    let mut props = vec![];
    if let Some((f, line)) = file {
        props.push(format!("file={}", esc(&f, true)));
        if let Some(l) = line {
            props.push(format!("line={l}"));
        }
    }
    props.push(format!("title={}", esc(title, true)));
    format!("::{level} {}::{}", props.join(","), esc(message, false))
}

// The line a test is defined on, so the annotation sits on it.
fn test_line(root: &Path, file: &str, name: &str) -> Option<usize> {
    let name = name.rsplit("::").next().unwrap_or(name);
    let text = fs::read_to_string(root.join(file)).ok()?;
    let defs = [
        format!("function {name}"),
        format!("def {name}"),
        format!("fn {name}"),
    ];
    text.lines()
        .position(|l| defs.iter().any(|d| l.contains(d.as_str())))
        .map(|i| i + 1)
}

fn annotations(
    root: &Path,
    map: &RootsMap,
    vs: &[NodeView],
    strict: bool,
    guard: Option<&GuardReport>,
    error: Option<&str>,
    pre: &str,
) -> Vec<String> {
    let mut out = vec![];
    if let Some(e) = error {
        out.push(command("error", None, "VIBloom could not run the tests", e));
    }
    for g in guard.into_iter() {
        let level = if g.allowed { "warning" } else { "error" };
        for c in &g.changes {
            out.push(command(
                level,
                Some((format!("{pre}{}", c.path), None)),
                "VIBloom guard change",
                &c.message,
            ));
        }
    }
    for v in vs {
        let attention = needs_attention(v, strict);
        if !attention && !unreviewed(v) {
            continue;
        }
        let at = node_files(v)
            .into_iter()
            .find(|f| !f.ends_with('/'))
            .map(|f| {
                let line = map
                    .nodes
                    .iter()
                    .find(|n| n.id == v.id)
                    .and_then(|n| n.test.as_ref())
                    .filter(|t| t.file == f)
                    .and_then(|t| test_line(root, &t.file, &t.name));
                (format!("{pre}{f}"), line)
            });
        let (level, what) = if troubled(v) {
            ("error", why(v).unwrap_or_default())
        } else if attention {
            ("error", "not yet reviewed (strict)".to_string())
        } else {
            (
                "warning",
                "not yet reviewed: adopt it or switch it off".to_string(),
            )
        };
        out.push(command(
            level,
            at,
            &format!("VIBloom {} [{}]", v.id, label(v)),
            &format!("{}: {what}", v.title),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_workflow_commands() {
        assert_eq!(
            command(
                "error",
                Some(("test/A, B.t.sol".into(), Some(3))),
                "VIBloom inv.x [BROKEN]",
                "100% wrong\nreally"
            ),
            "::error file=test/A%2C B.t.sol,line=3,title=VIBloom inv.x [BROKEN]::100%25 wrong%0Areally"
        );
        assert_eq!(
            command("warning", None, "a:b", "m"),
            "::warning title=a%3Ab::m"
        );
    }
}
