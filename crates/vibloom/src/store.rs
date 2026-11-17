//! The record on disk: finding the root, reading and writing the map, the
//! local log and the proposals, the lock, and hashing what the nodes watch.

use crate::cli::Fallible;
use crate::derive::{Files, NodeView, Snapshot, derive};
use crate::git::{git, uncommitted};
use crate::hash::sha256_hex;
use crate::log::{ReadLog, read_log};
use crate::map::{
    LEGACY_LOG_PATH, LOCAL_DIR, MAP_PATH, PROPOSALS_PATH, RootsMap, parse_map, watched_by,
};
use crate::proposals::Book;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// Skipped only when git cannot say what is ignored (not a repository).
pub(crate) const SKIP_DIRS: [&str; 10] = [
    ".git",
    "node_modules",
    "out",
    "cache",
    "broadcast",
    "artifacts",
    "target",
    "__pycache__",
    ".venv",
    "dist",
];

/// UTC time in the format JavaScript's `toISOString` writes.
pub fn iso_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Days to civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

pub fn find_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(MAP_PATH).is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

pub(crate) fn parse_map_text(text: &str) -> Fallible<RootsMap> {
    let raw: Value =
        serde_json::from_str(text).map_err(|e| format!("{MAP_PATH} is not valid JSON: {e}"))?;
    parse_map(&raw).map_err(|errs| format!("{MAP_PATH} has problems:\n- {}", errs.join("\n- ")))
}

pub fn load_map(root: &Path) -> Fallible<RootsMap> {
    let text = fs::read_to_string(root.join(MAP_PATH))
        .map_err(|e| format!("cannot read {MAP_PATH}: {e}"))?;
    let mut map = parse_map_text(&text)?;
    // A folder written by hand without its "/" is still a folder: read as one
    // file it would never change.
    for n in &mut map.nodes {
        for w in &mut n.watch {
            if !w.ends_with('/') && root.join(&*w).is_dir() {
                w.push('/');
            }
        }
    }
    Ok(map)
}

pub(crate) fn load_book(root: &Path) -> Book {
    Book::read(&fs::read_to_string(root.join(PROPOSALS_PATH)).unwrap_or_default())
}

// What must never be staged or committed (the run log, its snapshot, the
// lock, what the agent was already told) lives in the repository's git
// folder, one folder per project, or in `.vibloom/local/` without git.
pub(crate) fn state_dir(root: &Path) -> PathBuf {
    let dir = match git(root, &["rev-parse", "--absolute-git-dir", "--show-prefix"]) {
        Ok(out) => {
            let mut lines = out.lines();
            let git_dir = PathBuf::from(lines.next().unwrap_or_default().trim());
            let prefix = lines
                .next()
                .unwrap_or_default()
                .trim()
                .trim_end_matches('/');
            let dir = git_dir.join("vibloom");
            if prefix.is_empty() {
                dir
            } else {
                dir.join(prefix)
            }
        }
        Err(_) => {
            ignore_local(root);
            root.join(LOCAL_DIR)
        }
    };
    let _ = fs::create_dir_all(&dir);
    dir
}

// Without git the local folder sits inside `.vibloom/`, which is committed
// once the project is: it is ignored from the start.
pub(crate) fn ignore_local(root: &Path) {
    let path = root.join(".vibloom/.gitignore");
    let text = fs::read_to_string(&path).unwrap_or_default();
    if !text.lines().any(|l| l.trim() == "local/") {
        let _ = fs::create_dir_all(root.join(".vibloom"));
        let sep = if text.is_empty() || text.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let _ = fs::write(&path, format!("{text}{sep}local/\n"));
    }
}

pub fn log_path(root: &Path) -> PathBuf {
    state_dir(root).join("log.jsonl")
}

fn snapshot_path(root: &Path) -> PathBuf {
    state_dir(root).join("state.json")
}

pub fn load_log(root: &Path) -> ReadLog {
    read_log(&fs::read_to_string(log_path(root)).unwrap_or_default())
}

pub(crate) fn load_snapshot(root: &Path) -> Option<Snapshot> {
    serde_json::from_str(&fs::read_to_string(snapshot_path(root)).ok()?).ok()
}

pub(crate) fn write_snapshot(root: &Path, snap: &Snapshot) -> Fallible<()> {
    write_atomic(
        &snapshot_path(root),
        &serde_json::to_string(snap).unwrap_or_default(),
    )
}

/// Moves a run log committed by 0.7.0 or earlier out of the project, into
/// the local folder, and says once what is left to do. It is kept, not read:
/// a committed log is whatever the last committer wrote, so no state may
/// come from it. The next run records the states again.
pub(crate) fn migrate_log(root: &Path) -> Option<String> {
    let dir = state_dir(root);
    let old = root.join(LEGACY_LOG_PATH);
    if !old.is_file() {
        return None;
    }
    let mut to = dir.join("log.committed.jsonl");
    if to.exists() {
        to = dir.join(format!(
            "log.committed-{}.jsonl",
            iso_now().replace([':', '.'], "-")
        ));
    }
    let moved =
        fs::rename(&old, &to).or_else(|_| fs::copy(&old, &to).and_then(|_| fs::remove_file(&old)));
    if let Err(e) = moved {
        return Some(format!(
            "VIBloom: could not move {LEGACY_LOG_PATH} to {}: {e}",
            to.display()
        ));
    }
    Some(format!(
        "VIBloom: the run log is local state now and a committed one is never read. Moved {LEGACY_LOG_PATH} aside to {}; `vibloom run` records the states again. Take it out of git once, from your own terminal: git rm --cached {LEGACY_LOG_PATH}",
        to.display()
    ))
}

/// Runs recorded before `git init` follow the project into the git folder.
/// Local state only: nothing the project tracks is touched.
pub(crate) fn follow_git(root: &Path) {
    let dir = state_dir(root);
    let before_git = root.join(LOCAL_DIR);
    if dir != before_git && !dir.join("log.jsonl").exists() {
        for f in ["log.jsonl", "state.json"] {
            if before_git.join(f).is_file() {
                let _ = fs::rename(before_git.join(f), dir.join(f));
            }
        }
    }
}

/// What a reading command says about a run log committed by 0.7.0 or
/// earlier, without touching it.
pub(crate) fn legacy_log_note(root: &Path) -> Option<String> {
    root.join(LEGACY_LOG_PATH).is_file().then(|| {
        format!(
            "VIBloom: {LEGACY_LOG_PATH} was committed by an older vibloom and is never read; `vibloom check` moves it aside and records the states again. Then take it out of git once, from your own terminal: git rm --cached {LEGACY_LOG_PATH}"
        )
    })
}

/// Holds the guard's lock while `f` runs, so two processes (two agents, a hook
/// and a person) never write the record at once. Released when the file
/// closes, even if the process dies.
pub fn locked<T>(root: &Path, f: impl FnOnce() -> Fallible<T>) -> Fallible<T> {
    let path = state_dir(root).join("vibloom.lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    file.lock()
        .map_err(|e| format!("cannot lock {}: {e}", path.display()))?;
    let out = f();
    let _ = file.unlock();
    out
}

// Written beside the target and renamed over it: a crash leaves the old file.
pub(crate) fn write_atomic(path: &Path, text: &str) -> Fallible<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub fn append(path: &Path, line: &str) -> Fallible<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub(crate) fn walk(root: &Path, dir: &str, out: &mut Vec<String>) {
    let Ok(read) = fs::read_dir(root.join(dir)) else {
        return;
    };
    let mut names: Vec<String> = read
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let rel = if dir.is_empty() {
            name
        } else {
            format!("{dir}/{name}")
        };
        let p = root.join(&rel);
        if p.is_dir() {
            walk(root, &rel, out);
        } else if p.is_file() {
            out.push(rel);
        }
    }
}

// The files of a watched directory: what git tracks or would track there, so
// build output and caches that the project ignores never count as a change.
pub(crate) fn files_under(root: &Path, dir: &str, out: &mut Vec<String>) {
    let listed = git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            &format!("{dir}/"),
        ],
    );
    match listed {
        Ok(text) => out.extend(
            text.split('\0')
                .filter(|f| !f.is_empty())
                .map(str::to_string),
        ),
        Err(_) => walk(root, dir, out),
    }
}

/// The hash of every file any node watches, as the tree is right now.
pub fn hash_watched(root: &Path, map: &RootsMap) -> Files {
    let mut out = Files::new();
    let watches: BTreeSet<String> = map.nodes.iter().flat_map(watched_by).collect();
    for w in watches {
        let mut files = Vec::new();
        if let Some(dir) = w.strip_suffix('/') {
            files_under(root, dir, &mut files);
        } else {
            files.push(w);
        }
        for f in files {
            let hash = fs::read(root.join(&f)).ok().map(|b| sha256_hex(&b));
            out.insert(f, hash);
        }
    }
    out
}

pub fn views(root: &Path) -> Fallible<Vec<NodeView>> {
    views_at(root, false)
}

// `staged` counts what the index holds as committed: the commit check runs
// just before the commit that will hold it.
pub(crate) fn views_at(root: &Path, staged: bool) -> Fallible<Vec<NodeView>> {
    let map = load_map(root)?;
    Ok(derive(
        &map,
        &load_log(root).entries,
        &hash_watched(root, &map),
        load_snapshot(root).as_ref(),
        &uncommitted(root, &map, staged),
    ))
}

pub(crate) fn read_json(path: &Path) -> Fallible<Value> {
    match fs::read_to_string(path) {
        Err(_) => Ok(json!({})),
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str::<Value>(&text)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| format!("{} is not a JSON object; fix it first.", path.display())),
    }
}

pub(crate) fn write_json(path: &Path, v: &Value) -> Fallible<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(
        path,
        &format!("{}\n", serde_json::to_string_pretty(v).unwrap_or_default()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_now_has_the_javascript_shape() {
        let s = iso_now();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z') && &s[4..5] == "-" && &s[10..11] == "T" && &s[19..20] == ".");
        assert!(s.as_str() > "2026-01-01");
    }
}
