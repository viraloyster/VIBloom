//! Paths as the map writes them: relative to the root, with forward slashes.

use crate::cli::Fallible;
use std::path::{Component, Path, PathBuf};

// Lexical normalisation, so "a/../b" and symlink-free paths compare as written.
pub(crate) fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

// The deepest ancestor that exists is resolved, so a new file in a new folder
// under a symlinked root (macOS's /var -> /private/var) still lands inside it.
pub(crate) fn real(p: &Path) -> PathBuf {
    let p = normalize(p);
    let mut rest = Vec::new();
    let mut cur = p.as_path();
    loop {
        if let Ok(c) = cur.canonicalize() {
            return rest.iter().rev().fold(c, |acc, part| acc.join(part));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => return p,
        }
    }
}

/// A path as the map writes it: relative to the root, with forward slashes,
/// or None when it lies outside the project.
pub fn relative_to(root: &Path, base: &Path, p: &str) -> Option<String> {
    let path = Path::new(p);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let abs = real(&normalize(&abs));
    let root = real(root);
    let rel = abs.strip_prefix(&root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

// A path to watch, as the map writes it: relative to the root, and ending in
// "/" when it is a folder.
pub(crate) fn watch_path(root: &Path, cwd: &Path, w: &str) -> Fallible<String> {
    let r = relative_to(root, cwd, w).ok_or_else(|| format!("{w} is outside the project."))?;
    Ok(if w.ends_with('/') || root.join(&r).is_dir() {
        format!("{r}/")
    } else {
        r
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_stay_inside_the_root() {
        let root = std::env::temp_dir();
        let r = relative_to(&root, &root, "src/../test/A.t.sol");
        assert_eq!(r.as_deref(), Some("test/A.t.sol"));
        assert_eq!(relative_to(&root, &root, "/definitely/elsewhere"), None);
        assert_eq!(relative_to(&root, &root, "../outside"), None);
    }

    #[cfg(unix)]
    #[test]
    fn resolves_a_new_folder_under_a_symlinked_root() {
        let base = std::env::temp_dir().join(format!("vibloom-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("real")).expect("dir");
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).expect("symlink");
        let root = base.join("link");
        let r = relative_to(&root, &root, "new/dir/A.t.sol");
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(r.as_deref(), Some("new/dir/A.t.sol"));
    }
}
