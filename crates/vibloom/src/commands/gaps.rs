use crate::cli::Fallible;
use crate::foundry::compiled;
use crate::setup::{is_test_code, unmentioned};
use crate::store::{files_under, load_map, views};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// What the tests leave out, for a Foundry project: state-changing functions
/// of the project's contracts that no test file even names, and handler
/// functions whose every call reverted in the latest run.
pub fn gaps(root: &Path) -> Fallible<String> {
    let map = load_map(root)?;
    let (contracts, dirs) = compiled(root, &map, "gaps")?;
    let mut tests = Vec::new();
    files_under(root, map.tests.trim_end_matches('/'), &mut tests);
    let mut sources = Vec::new();
    files_under(root, &dirs.src, &mut sources);
    tests.extend(
        sources
            .into_iter()
            .filter(|f| is_test_code(f, &map.tests, &dirs.script)),
    );
    let tests: BTreeSet<String> = tests.into_iter().collect();
    let text: String = tests
        .iter()
        .filter_map(|f| fs::read_to_string(root.join(f)).ok())
        .collect::<Vec<_>>()
        .join("\n");
    let mut unnamed = Vec::new();
    let mut lines = Vec::new();
    for c in &contracts {
        let (own, from_libraries) = c.names();
        // A contract no test names is not deployed by any test: whatever
        // names it shares with another contract, nothing of its own runs.
        if !unmentioned(std::slice::from_ref(&c.name), &text).is_empty() {
            unnamed.push(format!("- {} ({}): {}", c.name, c.file, own.join(", ")));
            continue;
        }
        let missing = unmentioned(&own, &text);
        let inherited = unmentioned(&from_libraries, &text);
        let mut parts = Vec::new();
        if !missing.is_empty() {
            parts.push(missing.join(", "));
        }
        if !inherited.is_empty() {
            parts.push(format!("inherited: {}", inherited.join(", ")));
        }
        if !parts.is_empty() {
            lines.push(format!("- {} ({}): {}", c.name, c.file, parts.join("; ")));
        }
    }
    let mut out = Vec::new();
    if !unnamed.is_empty() {
        out.push(format!(
            "Contracts no file under {} names, so no test reaches any of their functions:",
            map.tests
        ));
        out.extend(unnamed);
    }
    if !lines.is_empty() {
        out.push(format!(
            "State-changing functions no file under {} names, so no test can reach them:",
            map.tests
        ));
        out.extend(lines);
    }
    if out.is_empty() {
        out.push(format!(
            "Every contract and state-changing function of the project is named somewhere in {}.",
            map.tests
        ));
    }
    let dead: BTreeSet<String> = views(root)?
        .iter()
        .filter_map(|v| v.fuzz.as_ref())
        .flat_map(|f| f.dead.iter().cloned())
        .collect();
    if !dead.is_empty() {
        out.push("Handler functions whose every call reverted in the latest run:".into());
        out.extend(dead.iter().map(|d| format!("- {d}")));
    }
    out.push(
        "A name that appears in the tests may still not be exercised; one that does not appear cannot be."
            .into(),
    );
    Ok(out.join("\n"))
}
