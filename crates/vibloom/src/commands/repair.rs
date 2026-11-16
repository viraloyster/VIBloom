use crate::cli::{Fallible, Io};
use crate::hooks::Role;
use crate::log::read_log;
use crate::map::LOG_PATH;
use crate::store::{iso_now, locked, write_atomic};
use std::fs;
use std::path::Path;

// Sets aside everything from the first broken link on. The runs before it
// still verify; the rest was never trusted and is kept apart, not deleted.
pub(crate) fn repair(root: &Path, io: &mut Io) -> Fallible<i32> {
    if io.role != Role::Verifier {
        return Err(
            "Only the verifier repairs the record: run it as VIBLOOM_ROLE=verifier.".into(),
        );
    }
    locked(root, || {
        let text = fs::read_to_string(root.join(LOG_PATH)).unwrap_or_default();
        let log = read_log(&text);
        if log.problems.is_empty() {
            (io.out)("The run log verifies; nothing to repair.");
            return Ok(0);
        }
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let (kept, rejected) = lines.split_at(log.entries.len());
        let aside = format!(
            ".vibloom/log.rejected-{}.jsonl",
            iso_now().replace([':', '.'], "-")
        );
        let join = |ls: &[&str]| ls.iter().map(|l| format!("{l}\n")).collect::<String>();
        fs::write(root.join(&aside), join(rejected)).map_err(|e| e.to_string())?;
        write_atomic(&root.join(LOG_PATH), &join(kept))?;
        (io.out)(&format!(
            "Kept {} verified runs; moved {} unverified lines to {aside}. Run the tests again.",
            kept.len(),
            rejected.len()
        ));
        Ok(0)
    })
}
