//! The `vibloom` command: the only part of the guard that touches the disk,
//! runs processes or talks to git.

use crate::commands;
use crate::git::install_hook;
use crate::hooks::Role;
use crate::map::MAP_PATH;
use std::path::PathBuf;

pub use crate::commands::agents::hooks_config;
pub use crate::commands::gaps::gaps;
pub use crate::commands::research::{NOTES_PATH, research};
pub use crate::commands::status::table;
pub use crate::commands::survey::survey;
pub use crate::git::uncommitted;
pub use crate::paths::relative_to;
pub use crate::runner::{RunReport, recorded, run};
pub use crate::store::{
    append, find_root, hash_watched, iso_now, load_log, load_map, locked, views,
};

pub struct Io<'a> {
    pub cwd: PathBuf,
    pub role: Role,
    pub stdin: &'a mut dyn FnMut() -> String,
    pub out: &'a mut dyn FnMut(&str),
    pub err: &'a mut dyn FnMut(&str),
}

pub type Fallible<T> = Result<T, String>;

/// The options and words of a command line, as `dispatch` sorted them.
pub(crate) struct Args<'a> {
    pub(crate) opts: Vec<(&'a str, &'a str)>,
    pub(crate) set: Vec<&'a str>,
    pub(crate) words: Vec<&'a str>,
}

impl<'a> Args<'a> {
    pub(crate) fn opt(&self, k: &str) -> Option<&'a str> {
        self.opts
            .iter()
            .rev()
            .find(|(n, _)| *n == k)
            .map(|(_, v)| *v)
    }

    pub(crate) fn all(&self, k: &str) -> Vec<String> {
        self.opts
            .iter()
            .filter(|(n, _)| *n == k)
            .map(|(_, v)| (*v).to_string())
            .collect()
    }
}

pub const USAGE: &str = "vibloom: assumptions, invariants and intentions for a code project.

  vibloom init [--stack S] [--agent claude|codex]
                             create .vibloom/roots.json for this project (foundry, hardhat,
                             cargo or pytest; detected when not given), install the commit
                             check and, with --agent, connect that agent
  vibloom setup claude|codex connect an agent to an existing map (verifier)
  vibloom install-hook       install the commit check in another clone
  vibloom add <kind> \"<title>\" [--file F --test N [--contract C]] [--watch P] [--on ID]
                             add an assumption, invariant or intention (verifier)
                             also: [--detail D] [--evidence E] [--id ID]
                             [--hypothetical | --adopted]; an assumption starts
                             hypothetical, an invariant or intention adopted
  vibloom edit <id> [--title T] [--detail D] [--stance S] [--on ID] [--not-on ID]
                    [--watch P] [--unwatch P] [--evidence E] [--drop-evidence E]
                    [--accept ID --reason R] [--unaccept ID]
                             change a node (verifier); --accept lets it rest on a
                             dependency that is off, for the reason given
  vibloom remove <id>        take a node out of the map (verifier)
  vibloom scan               add invariant tests the map does not list yet (verifier)
  vibloom survey [<Contract>...] [--propose]
                             Foundry: what the code says (who may call what, upgrades,
                             external calls) and the assumptions and invariants that follow,
                             for every contract or only those named; --propose files the
                             assumptions as proposals
  vibloom research           the brief an agent works from to find and propose nodes: the
                             notes, a summary of the survey and how to work
  vibloom status [--json]    the derived state of every node (exit 1 if any needs attention)
  vibloom run [-- args]      run the tests, record the run, show what changed
  vibloom check [--base ref] [-- args]
                             run, then exit 1 if any node needs attention (for CI); with
                             --base, first require the log to extend the one on that commit
  vibloom sync --base ref    after the base branch moved on: take its run log and record
                             the tests again on top of it
  vibloom context [file]     what an agent should know before touching a file
  vibloom gaps               Foundry: state-changing functions no test names, and handler
                             functions whose every call reverted
  vibloom verify             check the run log's hash chain
  vibloom repair             set aside everything after a broken link in the log (verifier)
  vibloom precommit          refuse a commit that changes guarded files or leaves a node
                             broken or untested since its files changed (any agent, any editor)
  vibloom proposals          list what agents proposed and nobody decided yet
  vibloom proposals accept <id>... [--on ID]... | reject <id>...
                             move proposals into the map, or turn them down (verifier)
  vibloom mcp                serve the map to any MCP client over stdio

Optional, for Claude Code:
  vibloom hooks              print the hooks configuration for .claude/settings.json
  vibloom hook <event>       called by those hooks: pre-tool, post-tool or stop

Set VIBLOOM_ROLE=verifier for the one agent or person allowed to change
protected tests and the map.";

pub fn main(argv: &[String], io: &mut Io) -> i32 {
    match dispatch(argv, io) {
        Ok(code) => code,
        Err(e) => {
            (io.err)(&e);
            1
        }
    }
}

fn dispatch(argv: &[String], io: &mut Io) -> Fallible<i32> {
    let (cmd, rest) = match argv.split_first() {
        Some((c, r)) => (c.as_str(), r),
        None => {
            (io.out)(USAGE);
            return Ok(1);
        }
    };
    // Our options come first; only what follows "--" goes to the runner, so a
    // mistyped option is never run as a test filter.
    let valued: &[&str] = match cmd {
        "check" | "sync" => &["--base"],
        "init" => &["--stack", "--agent"],
        "edit" => &[
            "--title",
            "--detail",
            "--stance",
            "--watch",
            "--unwatch",
            "--on",
            "--not-on",
            "--evidence",
            "--drop-evidence",
            "--accept",
            "--reason",
            "--unaccept",
        ],
        "proposals" => &["--on"],
        "add" => &[
            "--id",
            "--file",
            "--contract",
            "--test",
            "--watch",
            "--on",
            "--detail",
            "--evidence",
        ],
        _ => &[],
    };
    let flags: &[&str] = match cmd {
        "status" => &["--json"],
        "add" => &["--hypothetical", "--adopted", "--unprotected"],
        "survey" => &["--propose"],
        _ => &[],
    };
    let mut opts: Vec<(&str, &str)> = vec![];
    let mut set: Vec<&str> = vec![];
    let mut extra: Vec<String> = vec![];
    let mut words: Vec<&str> = vec![];
    let runs = matches!(cmd, "run" | "check");
    let mut i = 0;
    while i < rest.len() {
        let a = rest[i].as_str();
        match a {
            "--" if runs => {
                extra.extend(rest[i + 1..].iter().cloned());
                break;
            }
            "--help" | "-h" => {
                (io.out)(USAGE);
                return Ok(0);
            }
            _ if valued.contains(&a) => {
                i += 1;
                let v = rest.get(i).ok_or_else(|| format!("{a} needs a value."))?;
                opts.push((a, v.as_str()));
            }
            _ if flags.contains(&a) => set.push(a),
            _ if a.starts_with('-') && cmd != "hook" => {
                return Err(if runs {
                    format!("Unknown option {a}. Arguments for the test runner go after `--`.")
                } else {
                    format!("Unknown option {a} for `vibloom {cmd}`.")
                });
            }
            _ => words.push(a),
        }
        i += 1;
    }
    let args = Args { opts, set, words };
    let base = args.opt("--base");
    let as_json = args.set.contains(&"--json");
    let takes_words = matches!(
        cmd,
        "hook" | "context" | "proposals" | "add" | "setup" | "edit" | "remove" | "survey"
    );
    if !takes_words && !args.words.is_empty() {
        return Err(format!(
            "`vibloom {cmd}` takes no argument like {}.{}",
            args.words[0],
            if runs {
                " Arguments for the test runner go after `--`."
            } else {
                ""
            }
        ));
    }

    match cmd {
        "help" | "--help" | "-h" => {
            (io.out)(USAGE);
            return Ok(0);
        }
        "--version" | "-V" => {
            (io.out)(concat!("vibloom ", env!("CARGO_PKG_VERSION")));
            return Ok(0);
        }
        "hook" => {
            let stdin = (io.stdin)();
            let r = commands::hook::hook(
                rest.first().map_or("", String::as_str),
                &stdin,
                io.role,
                &io.cwd,
            )?;
            if let Some(s) = &r.stdout {
                (io.out)(s);
            }
            if let Some(s) = &r.stderr {
                (io.err)(s);
            }
            return Ok(0);
        }
        "hooks" => {
            (io.out)(&serde_json::to_string_pretty(&hooks_config()).unwrap_or_default());
            return Ok(0);
        }
        "init" => return commands::init::init(io, &args),
        "mcp" => return crate::mcp::serve(&io.cwd).map(|()| 0),
        _ => {}
    }

    let root = find_root(&io.cwd).ok_or_else(|| {
        format!("No {MAP_PATH} here or above. Run `vibloom init` at the project root.")
    })?;
    match cmd {
        "scan" => commands::init::rescan(&root, io),
        "add" => commands::nodes::add(&root, io, &args),
        "install-hook" => {
            (io.out)(&install_hook(&root)?);
            Ok(0)
        }
        "setup" => commands::agents::setup(&root, io, &args),
        "status" => commands::status::status(&root, io, as_json),
        "sync" => commands::run::sync(&root, io, base),
        "run" | "check" => commands::run::run_or_check(&root, io, cmd, base, &extra),
        "repair" => commands::repair::repair(&root, io),
        "gaps" => {
            (io.out)(&gaps(&root)?);
            Ok(0)
        }
        "survey" => {
            let only: Vec<String> = args.words.iter().map(|w| (*w).to_string()).collect();
            (io.out)(&survey(&root, args.set.contains(&"--propose"), &only)?);
            Ok(0)
        }
        "research" => {
            (io.out)(&research(&root)?);
            Ok(0)
        }
        "edit" => commands::nodes::edit(&root, io, &args),
        "remove" => commands::nodes::remove(&root, io, &args),
        "context" => commands::status::context(&root, io, &args),
        "verify" => commands::status::verify(&root, io),
        "precommit" => commands::precommit::precommit(&root, io),
        "proposals" => commands::proposals::proposals(&root, &args.words, &args.all("--on"), io),
        other => Err(format!("Unknown command {other}.\n\n{USAGE}")),
    }
}
