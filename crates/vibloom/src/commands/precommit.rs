use crate::cli::{Fallible, Io};
use crate::git::{git, staged_files};
use crate::hooks::Role;
use crate::store::{load_log, load_map, views_at};
use std::path::Path;

pub(crate) fn precommit(root: &Path, io: &mut Io) -> Fallible<i32> {
    if git(root, &["rev-parse", "--git-dir"]).is_err() {
        return Err("Not a git repository: the commit check reads what a commit stages, so it runs only inside one.".into());
    }
    let staged: Vec<String> = staged_files(root)?;
    // In a repository that holds more than this project, a commit
    // that touches nothing of it is not this project's to judge.
    if staged.is_empty() {
        return Ok(0);
    }
    let problems = crate::gate::precommit(
        &load_map(root)?,
        &views_at(root, io.role == Role::Verifier)?,
        &staged,
        io.role,
        &load_log(root).problems,
    );
    if problems.is_empty() {
        return Ok(0);
    }
    (io.err)(&format!(
        "VIBloom refused the commit:\n- {}",
        problems.join("\n- ")
    ));
    (io.err)(
        "Run `vibloom run` after changing code. Guarded files are the person's to change and commit, from their own terminal.",
    );
    Ok(1)
}
