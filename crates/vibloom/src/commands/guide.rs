//! `vibloom` with no arguments: where things stand and the one next step,
//! instead of every command at once.

use crate::cli::{Fallible, Io};
use crate::derive::{Evidence, NodeView, label, troubled, unreviewed, why};
use crate::map::{Kind, RootsMap};
use crate::store::{find_root, load_book, load_log, load_map, views};
use std::path::Path;

pub(crate) const TEMPLATE: &str =
    "https://github.com/viraloyster/VIBloom/blob/main/docs/quickstart.md#an-invariant-test";

const START: &str = "vibloom keeps a map of what a code project assumes and what must always hold,
and checks it against the tests on every run, so an agent cannot pass by weakening them.
Start at the root of a project (Foundry, Hardhat, Cargo or pytest):
  vibloom init     find the invariant tests and write the map
  vibloom check    run the tests and see what holds
`vibloom help` lists every command.";

const PROJECT_FILES: [&str; 8] = [
    "foundry.toml",
    "Cargo.toml",
    "package.json",
    "pyproject.toml",
    "setup.py",
    "hardhat.config.js",
    "hardhat.config.ts",
    ".git",
];

pub(crate) fn guide(io: &mut Io) -> Fallible<i32> {
    let Some(root) = find_root(&io.cwd) else {
        if PROJECT_FILES.iter().any(|f| io.cwd.join(f).exists()) {
            (io.out)("No vibloom map here yet (.vibloom/roots.json).");
            (io.out)(
                "Next: `vibloom init` finds the invariant tests and writes the map. `vibloom help` lists every command.",
            );
        } else {
            (io.out)(START);
        }
        return Ok(0);
    };
    for line in summary(&root)? {
        (io.out)(&line);
    }
    Ok(0)
}

// Never run, or run against files that changed since: running the tests is
// the step, not reading the table again.
fn needs_run(v: &NodeView) -> bool {
    matches!(
        v.evidence,
        Evidence::Untested | Evidence::Stale | Evidence::Inconclusive
    ) || !v.changed.is_empty()
}

// Trouble of its own, not only what it rests on.
fn own_trouble(v: &NodeView) -> bool {
    troubled(v) && !matches!(v.evidence, Evidence::None | Evidence::Holds)
}

fn titles<'a>(vs: impl Iterator<Item = &'a NodeView>) -> Vec<String> {
    vs.take(3).map(|v| format!("  - {}", v.title)).collect()
}

pub(crate) fn summary(root: &Path) -> Fallible<Vec<String>> {
    let map = load_map(root)?;
    let vs = views(root)?;
    let runs = load_log(root).entries.len();
    let mut out = vec![format!(
        "{} nodes in .vibloom/roots.json; {}.",
        vs.len(),
        match runs {
            0 => "the tests have not run here yet".to_string(),
            n => format!(
                "{n} test {} recorded here",
                if n == 1 { "run" } else { "runs" }
            ),
        }
    )];
    let proven: Vec<&NodeView> = vs
        .iter()
        .filter(|v| v.kind == Kind::Invariant && label(v) == "holds")
        .collect();
    out.push(if proven.is_empty() {
        "Proven: nothing yet (no invariant holds in a recorded run).".into()
    } else {
        format!(
            "Proven: {} {} in the latest run.",
            proven.len(),
            if proven.len() == 1 {
                "invariant holds"
            } else {
                "invariants hold"
            }
        )
    });
    out.extend(titles(proven.into_iter()));
    let open = vs.iter().filter(|v| unreviewed(v)).count();
    if open > 0 {
        out.push(format!(
            "Only claimed: {open} not yet reviewed (hypothetical: nobody has adopted {}).",
            if open == 1 { "it" } else { "them" }
        ));
    }
    let bad: Vec<&NodeView> = vs.iter().filter(|v| troubled(v)).collect();
    if !bad.is_empty() {
        out.push(format!("Needs attention: {}.", bad.len()));
        out.extend(bad.iter().take(3).map(|v| {
            let why = why(v).map(|w| format!(": {w}")).unwrap_or_default();
            format!("  - {} {}{why}", v.id, label(v))
        }));
    }
    out.extend(next(root, &map, &vs, runs));
    Ok(out)
}

/// The one next step, chosen by the state of the map.
pub(crate) fn next(root: &Path, map: &RootsMap, vs: &[NodeView], runs: usize) -> Vec<String> {
    if !map.nodes.iter().any(|n| n.test.is_some()) {
        let mut out = vec!["No tests in the map yet, so nothing here can be proven.".to_string()];
        if map.report.is_none() {
            out.push(format!(
                "Next: `vibloom survey` lists the invariants worth a test; write one (template: {TEMPLATE}) and run `vibloom scan` to add it."
            ));
        } else {
            out.push(format!(
                "Next: add a test that checks what must hold (template: {TEMPLATE}) with `vibloom add invariant \"<title>\" --file F --test N`."
            ));
        }
        return out;
    }
    let pending = load_book(root).pending().len();
    if pending > 0 {
        return vec![format!(
            "Next: `vibloom proposals` - {pending} {} waiting for you to accept or reject.",
            if pending == 1 {
                "proposal"
            } else {
                "proposals"
            }
        )];
    }
    let bad: Vec<&NodeView> = vs.iter().filter(|v| troubled(v)).collect();
    if !bad.is_empty() {
        let own: Vec<&&NodeView> = bad.iter().filter(|v| own_trouble(v)).collect();
        if !own.is_empty() && own.iter().all(|v| needs_run(v)) {
            return vec![if runs == 0 {
                "Next: `vibloom check` runs the tests and records what holds.".into()
            } else {
                "Next: `vibloom check` runs the tests again; files changed since the last run."
                    .into()
            }];
        }
        return vec!["Next: `vibloom status` shows every node and why.".into()];
    }
    if let Some(v) = vs.iter().find(|v| unreviewed(v)) {
        return vec![format!(
            "Next: decide {}: `vibloom edit {} --stance adopted` if it is true, `--stance off` if not.",
            v.id, v.id
        )];
    }
    if map.nodes.iter().any(|n| n.kind == Kind::Assumption) {
        return vec!["Next: nothing to do; `vibloom check` runs the tests.".into()];
    }
    vec!["Next: nothing to do; `vibloom check` runs the tests. Write down what the code takes as given with `vibloom add \"<title>\"`.".into()]
}
