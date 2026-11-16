use crate::cli::{Fallible, Io};
use crate::commands::status::table;
use crate::derive::{label, troubled};
use crate::git::{check_base, git};
use crate::log::read_log;
use crate::map::LOG_PATH;
use crate::runner::{recorded, run};
use crate::store::{load_map, locked, views, write_atomic};
use std::path::Path;

pub(crate) fn run_or_check(
    root: &Path,
    io: &mut Io,
    cmd: &str,
    base: Option<&str>,
    extra: &[String],
) -> Fallible<i32> {
    if let Some(b) = base {
        let problems = check_base(root, b);
        if !problems.is_empty() {
            (io.err)(&format!(
                "VIBloom: the run log does not extend the one on {b}:\n- {}",
                problems.join("\n- ")
            ));
            return Ok(1);
        }
    }
    let before: std::collections::HashMap<String, &'static str> = views(root)?
        .iter()
        .map(|v| (v.id.clone(), label(v)))
        .collect();
    let report = run(root, extra)?;
    if let Some(e) = &report.entry.error {
        (io.err)(&format!(
            "Run {} recorded with an error: {e}",
            report.entry.seq
        ));
    }
    (io.out)(&recorded(&report.entry, &load_map(root)?));
    let moved: Vec<String> = report
        .views
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
    if !moved.is_empty() {
        (io.out)(&format!("Changed:\n{}", moved.join("\n")));
    }
    (io.out)(&table(&report.views));
    let failed = report.views.iter().any(troubled) || report.entry.error.is_some();
    Ok(i32::from(cmd == "check" && failed))
}

pub(crate) fn sync(root: &Path, io: &mut Io, base: Option<&str>) -> Fallible<i32> {
    let b = base.ok_or("Usage: vibloom sync --base <commit>, for example --base origin/main")?;
    // A branch whose log no longer extends the base's (the base moved
    // on, or a merge left both histories in the file) takes the
    // base's log and records the tests again on top of it.
    if check_base(root, b).is_empty() {
        (io.out)(&format!("The run log already extends the one on {b}."));
    } else {
        let shown = git(root, &["show", &format!("{b}:./{LOG_PATH}")]).unwrap_or_default();
        let base_log = read_log(&shown);
        if !base_log.problems.is_empty() {
            return Err(format!(
                "The run log on {b} does not verify:\n- {}",
                base_log.problems.join("\n- ")
            ));
        }
        locked(root, || write_atomic(&root.join(LOG_PATH), &shown))?;
        (io.out)(&format!(
            "Took the {} runs on {b}; this branch's own runs are replaced by the one recorded now.",
            base_log.entries.len()
        ));
    }
    let report = run(root, &[])?;
    (io.out)(&recorded(&report.entry, &load_map(root)?));
    (io.out)(&table(&report.views));
    Ok(i32::from(
        report.views.iter().any(troubled) || report.entry.error.is_some(),
    ))
}
