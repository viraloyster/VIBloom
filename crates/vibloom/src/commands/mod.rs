//! The commands that need more than a line or two in `dispatch`.

pub(crate) mod agents;
pub(crate) mod diff;
pub(crate) mod gaps;
pub(crate) mod guide;
pub(crate) mod hook;
pub(crate) mod init;
pub(crate) mod nodes;
pub(crate) mod precommit;
pub(crate) mod proposals;
pub(crate) mod repair;
pub(crate) mod research;
pub(crate) mod run;
pub(crate) mod status;
pub(crate) mod survey;

use crate::cli::{Fallible, Io};
use crate::hooks::Role;

/// Refuses an agent what only the person decides, and says how the person
/// does it.
pub(crate) fn verifier(io: &Io, what: &str) -> Fallible<()> {
    if io.role == Role::Verifier {
        return Ok(());
    }
    Err(format!(
        "This {what}, which is a decision for the person, not for the agent writing the code: whoever is judged by the checks must not be able to change them.\nvibloom treats this command as an agent's ({}).\nThe person runs it in their own terminal: {}",
        io.role_why, io.line
    ))
}
