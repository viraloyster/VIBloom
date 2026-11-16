//! The record on disk: finding the root, reading and writing the map, the
//! log and the proposals, the lock, and hashing what the nodes watch.

use crate::cli::Fallible;
use crate::derive::{Files, NodeView, derive};
use crate::git::{git, uncommitted};
use crate::hash::sha256_hex;
use crate::log::{ReadLog, read_log};
use crate::map::{LOG_PATH, MAP_PATH, PROPOSALS_PATH, RootsMap, parse_map, watched_by};
use crate::paths::real;
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

pub fn load_map(root: &Path) -> Fallible<RootsMap> {
    let text = fs::read_to_string(root.join(MAP_PATH))
        .map_err(|e| format!("cannot read {MAP_PATH}: {e}"))?;
    let raw: Value =
        serde_json::from_str(&text).map_err(|e| format!("{MAP_PATH} is not valid JSON: {e}"))?;
    let mut map = parse_map(&raw)
        .map_err(|errs| format!("{MAP_PATH} has problems:\n- {}", errs.join("\n- ")))?;
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

pub fn load_log(root: &Path) -> ReadLog {
    read_log(&fs::read_to_string(root.join(LOG_PATH)).unwrap_or_default())
}

pub(crate) fn load_book(root: &Path) -> Book {
    Book::read(&fs::read_to_string(root.join(PROPOSALS_PATH)).unwrap_or_default())
}

// Where the guard keeps what must never be staged or committed (its lock,
// what it already told the agent): the repository's git folder, or a folder
// of its own in the temp folder when there is no repository.
pub(crate) fn state_dir(root: &Path) -> PathBuf {
    git(root, &["rev-parse", "--absolute-git-dir"]).map_or_else(
        |_| {
            let id = sha256_hex(real(root).to_string_lossy().as_bytes());
            let dir = std::env::temp_dir().join(format!("vibloom-{}", &id[..16]));
            let _ = fs::create_dir_all(&dir);
            dir
        },
        |d| PathBuf::from(d.trim()),
    )
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

pub fn append(root: &Path, rel: &str, line: &str) -> Fallible<()> {
    fs::create_dir_all(root.join(".vibloom")).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(rel))
        .map_err(|e| format!("cannot write {rel}: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("cannot write {rel}: {e}"))
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
