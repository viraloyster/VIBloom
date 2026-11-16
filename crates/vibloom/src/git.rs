//! What git says: changed and staged files, files as they are on another
//! commit, and the commit hook.

use crate::cli::Fallible;
use crate::derive::Uncommitted;
use crate::map::{RootsMap, covers};
use crate::setup::helpers;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::Command;

pub(crate) fn git(root: &Path, args: &[&str]) -> Fallible<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The agents' own files: guarded so the guard cannot be switched off, but
/// no test leans on them.
pub(crate) const AGENT_FILES: [&str; 4] = [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".mcp.json",
    "AGENTS.md",
];

// Files of the project that differ from HEAD in the index or the working
// tree, with one call to git. A file not in HEAD (added, never committed) is
// left out: the verifier added it and has not committed yet.
pub(crate) fn changed_from_head(root: &Path, staged: bool) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Ok(prefix) = git(root, &["rev-parse", "--show-prefix"]) else {
        return out;
    };
    let prefix = prefix.trim();
    let Ok(text) = git(
        root,
        &[
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=no",
            "--no-renames",
            "--",
            ".",
        ],
    ) else {
        return out;
    };
    for rec in text.split('\0') {
        let (Some(x), Some(y), Some(path)) = (rec.chars().next(), rec.chars().nth(1), rec.get(3..))
        else {
            continue;
        };
        if x == 'A' || x == '?' || (staged && y == ' ') {
            continue;
        }
        // Porcelain paths start at the repository's top, not at the project.
        if let Some(rel) = path.strip_prefix(prefix) {
            out.insert(rel.to_string());
        }
    }
    out
}

/// For each protected test, the guarded files it leans on that are not
/// committed: the test itself, the handlers it imports that the map guards,
/// and the test configuration (`foundry.toml` and the like), which bears on
/// every test.
pub fn uncommitted(root: &Path, map: &RootsMap, staged: bool) -> Uncommitted {
    let mut out = Uncommitted::new();
    let changed = changed_from_head(root, staged);
    if changed.is_empty() {
        return out;
    }
    let read = |f: &str| fs::read_to_string(root.join(f)).ok();
    let shared: Vec<&String> = map
        .protect
        .iter()
        .filter(|p| !covers(&map.tests, p) && !AGENT_FILES.contains(&p.as_str()))
        .collect();
    for n in map.nodes.iter().filter(|n| n.protected) {
        let Some(t) = &n.test else { continue };
        let mut leans = vec![t.file.clone()];
        // Guarded files the node watches by name: the handlers `init` found
        // through forge's imports, remapped paths included. A watched folder
        // says nothing about what the test leans on.
        leans.extend(map.protect.iter().filter(|p| n.watch.contains(p)).cloned());
        leans.extend(
            helpers(std::slice::from_ref(&t.file), &map.tests, &read)
                .into_iter()
                .filter(|h| map.protect.iter().any(|p| covers(p, h))),
        );
        leans.extend(shared.iter().map(|p| (*p).clone()));
        let files: Vec<String> = changed
            .iter()
            .filter(|f| leans.iter().any(|l| covers(l, f)))
            .cloned()
            .collect();
        if !files.is_empty() {
            out.insert(n.id.clone(), files);
        }
    }
    out
}

// The project's folder inside the repository, "" at its top.
pub(crate) fn prefix(root: &Path) -> Fallible<String> {
    Ok(git(root, &["rev-parse", "--show-prefix"])?
        .trim()
        .to_string())
}

pub(crate) fn is_commit(root: &Path, rev: &str) -> bool {
    git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
    .is_ok()
}

/// A project file as it is on `rev`, read from git and never from the working
/// tree, so a branch cannot change what it is compared with. None when the
/// file is not there.
pub(crate) fn show_at(root: &Path, rev: &str, prefix: &str, file: &str) -> Option<Vec<u8>> {
    let spec = format!("{rev}:{prefix}{file}");
    let ok = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
    };
    // A tree (a folder) is not a file.
    let kind = ok(&["cat-file", "-t", &spec])?;
    if String::from_utf8_lossy(&kind.stdout).trim() != "blob" {
        return None;
    }
    ok(&["cat-file", "blob", &spec]).map(|o| o.stdout)
}

/// The project files under a folder on `rev`, relative to the project.
pub(crate) fn files_at(root: &Path, rev: &str, prefix: &str, dir: &str) -> Vec<String> {
    let listed = git(
        root,
        &[
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            "--full-tree",
            rev,
            "--",
            &format!("{prefix}{}/", dir.trim_end_matches('/')),
        ],
    )
    .unwrap_or_default();
    listed
        .split('\0')
        .filter_map(|f| f.strip_prefix(prefix))
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .collect()
}

// The files the commit stages, relative to the project.
pub(crate) fn staged_files(root: &Path) -> Fallible<Vec<String>> {
    Ok(git(
        root,
        // Without rename detection, so a moved file shows its old path too.
        &[
            "diff",
            "--cached",
            "--name-only",
            "--no-renames",
            "-z",
            "--relative",
        ],
    )
    .map_err(|e| format!("git diff --cached failed: {e}"))?
    .split('\0')
    .filter(|s| !s.is_empty())
    .map(str::to_string)
    .collect())
}

pub(crate) const HOOK_LINE: &str = "vibloom precommit";

// The commit check in this clone's git hooks. Says what it did; an existing
// hook of another tool is never overwritten.
pub(crate) fn install_hook(root: &Path) -> Fallible<String> {
    let rel = git(root, &["rev-parse", "--git-path", "hooks/pre-commit"])
        .map_err(|e| format!("This is not a git repository: {e}"))?;
    let path = root.join(rel.trim());
    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.contains(HOOK_LINE) {
            return Ok("The commit check is already installed.".into());
        }
        return Err(format!(
            "{} already exists. Add this line to it: {HOOK_LINE} || exit 1",
            path.display()
        ));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Git runs hooks at the top of the repository; when the map lives in a
    // folder below it, the check has to go there first.
    let prefix = git(root, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let prefix = prefix.trim().trim_end_matches('/');
    let cd = if prefix.is_empty() {
        String::new()
    } else {
        format!("cd \"{prefix}\" || exit 1\n")
    };
    fs::write(
        &path,
        format!(
            "#!/bin/sh\n# VIBloom: refuse a commit that breaks the map.\nif ! command -v vibloom >/dev/null 2>&1; then\n  echo \"VIBloom: vibloom is not on PATH, so the commit check cannot run.\" >&2\n  exit 1\nfi\n{cd}exec {HOOK_LINE}\n"
        ),
    )
    .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(format!(
        "Installed the commit check at {}. Each clone installs its own.",
        path.display()
    ))
}
