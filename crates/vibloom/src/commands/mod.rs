//! The commands that need more than a line or two in `dispatch`.

pub(crate) mod agents;
pub(crate) mod gaps;
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

use crate::cli::Fallible;
use crate::hooks::Role;

pub(crate) fn verifier(role: Role, what: &str) -> Fallible<()> {
    if role == Role::Verifier {
        Ok(())
    } else {
        Err(format!(
            "This {what}: only the verifier does it. Run it as VIBLOOM_ROLE=verifier."
        ))
    }
}
