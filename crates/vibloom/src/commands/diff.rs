//! `vibloom diff <ref>`: what changed in the map and under it since a commit,
//! usually the audited one. Read-only, for anyone: it decides nothing.

use crate::cli::{Args, Fallible, Io};
use crate::git::{files_at, git, is_commit, prefix, show_at};
use crate::guard::{GuardChange, Reader, file_changes, guarded_at_base, map_changes};
use crate::map::{MAP_PATH, RootNode, RootsMap, watched_by};
use crate::store::{files_under, load_map, parse_map_text};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
struct FileChange {
    path: String,
    change: &'static str,
}

#[derive(Serialize)]
struct NodeDiff {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    changes: Vec<GuardChange>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    files: Vec<FileChange>,
}

#[derive(Default)]
struct Diff {
    removed: Vec<NodeDiff>,
    weakened: Vec<NodeDiff>,
    guard: Vec<GuardChange>,
    changed: Vec<NodeDiff>,
    added: Vec<NodeDiff>,
}

fn node(n: &RootNode) -> NodeDiff {
    NodeDiff {
        id: n.id.clone(),
        title: n.title.clone(),
        changes: vec![],
        files: vec![],
    }
}

// The files a node watches on either side, each compared with its content
// on the base.
fn watched_changes(
    root: &Path,
    rev: &str,
    pre: &str,
    b: &RootNode,
    h: &RootNode,
) -> Vec<FileChange> {
    let mut files = BTreeSet::new();
    for w in watched_by(b).into_iter().chain(watched_by(h)) {
        match w.strip_suffix('/') {
            Some(dir) => {
                files.extend(files_at(root, rev, pre, dir));
                let mut now = vec![];
                files_under(root, dir, &mut now);
                files.extend(now);
            }
            None => {
                files.insert(w);
            }
        }
    }
    files
        .into_iter()
        .filter_map(|f| {
            let change = match (show_at(root, rev, pre, &f), fs::read(root.join(&f)).ok()) {
                (Some(a), Some(b)) if a == b => return None,
                (None, None) => return None,
                (Some(_), Some(_)) => "changed",
                (Some(_), None) => "removed",
                (None, Some(_)) => "added",
            };
            Some(FileChange { path: f, change })
        })
        .collect()
}

fn compare(root: &Path, rev: &str, pre: &str, base: &RootsMap, head: &RootsMap) -> Diff {
    let mut d = Diff::default();
    let changes = map_changes(base, head);
    for b in &base.nodes {
        let mine: Vec<GuardChange> = changes
            .iter()
            .filter(|c| c.node.as_deref() == Some(b.id.as_str()))
            .cloned()
            .collect();
        let Some(h) = head.nodes.iter().find(|h| h.id == b.id) else {
            d.removed.push(node(b));
            continue;
        };
        let mut nd = node(h);
        nd.files = watched_changes(root, rev, pre, b, h);
        if !mine.is_empty() {
            nd.changes = mine;
            d.weakened.push(nd);
        } else if !nd.files.is_empty() {
            d.changed.push(nd);
        }
    }
    d.guard = changes.into_iter().filter(|c| c.node.is_none()).collect();
    let read_text =
        |f: &str| show_at(root, rev, pre, f).map(|b| String::from_utf8_lossy(&b).into_owned());
    let reader = Reader {
        base: &|f| show_at(root, rev, pre, f),
        now: &|f| fs::read(root.join(f)).ok(),
        base_dir: &|dir| files_at(root, rev, pre, dir),
    };
    d.guard
        .extend(file_changes(&guarded_at_base(base, &read_text), &reader));
    d.added = head
        .nodes
        .iter()
        .filter(|h| !base.nodes.iter().any(|b| b.id == h.id))
        .map(node)
        .collect();
    d
}

// A screen for a normal project: long lists are cut, the JSON has them all.
const ROWS: usize = 12;
const FILES: usize = 4;

fn files_text(files: &[FileChange]) -> String {
    let mut shown: Vec<String> = files
        .iter()
        .take(FILES)
        .map(|f| match f.change {
            "changed" => f.path.clone(),
            other => format!("{} ({other})", f.path),
        })
        .collect();
    if files.len() > FILES {
        shown.push(format!("and {} more", files.len() - FILES));
    }
    shown.join(", ")
}

fn section(out: &mut Vec<String>, head: String, rows: Vec<String>) {
    if rows.is_empty() {
        return;
    }
    out.push(head);
    let more = rows.len().saturating_sub(ROWS);
    out.extend(rows.into_iter().take(ROWS));
    if more > 0 {
        out.push(format!(
            "  ... and {more} more (`vibloom diff --json` lists all)"
        ));
    }
}

fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn text(rev: &str, d: &Diff) -> Vec<String> {
    let mut out = vec![];
    let mut gone: Vec<String> = d
        .removed
        .iter()
        .map(|n| format!("- {}: removed (\"{}\")", n.id, n.title))
        .collect();
    gone.extend(d.weakened.iter().map(|n| {
        let what: Vec<String> = n
            .changes
            .iter()
            .map(|c| {
                c.message
                    .strip_prefix(&format!("{}: ", n.id))
                    .unwrap_or(&c.message)
                    .to_string()
            })
            .collect();
        let mut line = format!("- {}: {}", n.id, what.join("; "));
        if !n.files.is_empty() {
            line.push_str(&format!("; files changed: {}", files_text(&n.files)));
        }
        line
    }));
    section(&mut out, format!("Gone or weakened since {rev}:"), gone);
    section(
        &mut out,
        format!("Guard changes since {rev}:"),
        d.guard.iter().map(|c| format!("- {}", c.message)).collect(),
    );
    section(
        &mut out,
        format!("Not what was reviewed at {rev} (same node, but files it watches changed):"),
        d.changed
            .iter()
            .map(|n| format!("- {}: {}", n.id, files_text(&n.files)))
            .collect(),
    );
    section(
        &mut out,
        format!("Added since {rev}:"),
        d.added
            .iter()
            .map(|n| format!("- {}: {}", n.id, n.title))
            .collect(),
    );
    out.push(format!(
        "Since {rev}: {} gone or weakened, {}, {} with changed files, {} added.",
        d.removed.len() + d.weakened.len(),
        count(d.guard.len(), "guard change", "guard changes"),
        count(d.changed.len(), "node", "nodes"),
        d.added.len()
    ));
    out
}

pub(crate) fn diff(root: &Path, io: &mut Io, args: &Args, as_json: bool) -> Fallible<i32> {
    let [rev] = args.words.as_slice() else {
        return Err("Usage: vibloom diff <ref> [--json]: what changed in the map and under it since <ref>, such as the audited tag.".into());
    };
    if git(root, &["rev-parse", "--git-dir"]).is_err() {
        return Err(
            "`vibloom diff` compares with a commit, so it runs only in a git repository.".into(),
        );
    }
    if !is_commit(root, rev) {
        return Err(format!("{rev} is not a commit here."));
    }
    let head = load_map(root)?;
    let pre = prefix(root)?;
    let base = match show_at(root, rev, &pre, MAP_PATH) {
        None => None,
        Some(t) => Some(
            parse_map_text(&String::from_utf8_lossy(&t))
                .map_err(|e| format!("The map on {rev} cannot be read: {e}"))?,
        ),
    };
    let d = match &base {
        Some(b) => compare(root, rev, &pre, b, &head),
        None => Diff {
            added: head.nodes.iter().map(node).collect(),
            ..Diff::default()
        },
    };
    let exit = i32::from(
        !(d.removed.is_empty()
            && d.weakened.is_empty()
            && d.guard.is_empty()
            && d.changed.is_empty()),
    );
    if as_json {
        (io.out)(
            &json!({
                "format": 1,
                "base": rev,
                "base_has_map": base.is_some(),
                "exit": exit,
                "removed": d.removed,
                "weakened": d.weakened,
                "guard": d.guard,
                "changed": d.changed,
                "added": d.added,
                "summary": {
                    "removed": d.removed.len(),
                    "weakened": d.weakened.len(),
                    "guard": d.guard.len(),
                    "changed": d.changed.len(),
                    "added": d.added.len(),
                },
            })
            .to_string(),
        );
        return Ok(exit);
    }
    if base.is_none() {
        (io.out)(&format!(
            "{rev} has no {MAP_PATH}, so every node is new since then."
        ));
    }
    for line in text(rev, &d) {
        (io.out)(&line);
    }
    Ok(exit)
}
