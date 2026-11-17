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
    append, find_root, hash_watched, iso_now, load_log, load_map, locked, log_path, views,
};

pub struct Io<'a> {
    pub cwd: PathBuf,
    pub role: Role,
    /// Why the role is what it is, said when a command is refused for it.
    pub role_why: String,
    /// The command line as typed, for a refusal to hand to the person.
    pub line: String,
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

pub const USAGE: &str = "vibloom: a map of what a code project assumes and what must always hold,
checked against its tests on every run. `vibloom` alone says where things stand.

Everyday:
  vibloom init [--agent claude|codex]   write the map from the invariant tests found here
  vibloom check                         run the tests and decide from that run (exit 1: look)
  vibloom status                        every node and its state, what needs attention first
  vibloom add \"<title>\" [--on ID]       write down an assumption; --on X: it rests on X,
                                        so if X fails it is at risk
  vibloom proposals [accept|reject]     what agents or the survey proposed; you decide
  vibloom survey [<Contract>...]        Foundry: who may call what, and what to write down

More:
  Map editing
    vibloom add assumption|invariant|intention \"<title>\" [--on ID]... [--file F --test N
                [--contract C] [--tool T]] [--watch P]... [--evidence E]... [--detail D]
                [--id ID] [--hypothetical | --adopted] [--unprotected]
    vibloom edit <id> [--title T] [--detail D] [--stance adopted|hypothetical|off]
                [--on ID] [--not-on ID] [--watch P] [--unwatch P] [--evidence E]
                [--drop-evidence E] [--accept ID --reason R] [--unaccept ID]
    vibloom remove <id>                 take a node out (refused while others rest on it)
    vibloom scan [--tighten]            add invariant tests the map does not list yet
    vibloom proposals <id> | --full | --contract C      one proposal, or all with evidence
    vibloom proposals accept <id>... | --all [--contract C] [--on ID]...
    vibloom proposals reject <id>... | --all [--contract C]
    vibloom survey --propose            file the survey's assumptions as proposals
  Agents
    vibloom setup claude|codex          connect an agent to an existing map
    vibloom context [file]              what an agent should know before touching a file
    vibloom research                    the brief an agent works from to propose nodes
    vibloom gaps                        Foundry: functions no test names
    vibloom run [-- args]               run the tests (args go to the runner) and record them
    vibloom mcp                         serve the map to any MCP client over stdio
    vibloom hooks | hook <event>        Claude Code hooks: print them, or run one
  CI
    vibloom check --base <ref> [--allow-guard-changes] [--strict] [--json | --format github]
    vibloom status --json [--strict]
    vibloom install-hook                install the commit check in this clone
  Audit
    vibloom diff <ref> [--json]         what is gone, weakened or changed under the map
                                        since <ref> (the audited tag); read-only
    vibloom precommit                   the commit check itself
  Repair
    vibloom verify                      check the local run log's hash chain
    vibloom repair                      set aside everything after a broken link

Who decides: a person at a terminal changes the map; an AI agent (detected by
the variables Claude Code, Codex, Cursor and Gemini CLI set, or VIBLOOM_ROLE=builder)
only proposes. VIBLOOM_ROLE=verifier or builder overrides the detection.

Exit codes: 0 nothing needs attention, 1 something does (a verdict), 2 vibloom
could not do its job (no map, bad arguments, git error, the runner failed).";

const COMMANDS: [&str; 23] = [
    "init",
    "check",
    "status",
    "add",
    "proposals",
    "survey",
    "edit",
    "remove",
    "scan",
    "setup",
    "context",
    "research",
    "gaps",
    "run",
    "mcp",
    "hooks",
    "hook",
    "install-hook",
    "precommit",
    "verify",
    "repair",
    "diff",
    "help",
];

pub fn main(argv: &[String], io: &mut Io) -> i32 {
    let cmd = argv.first().map_or("", String::as_str);
    io.line = std::iter::once("vibloom".to_string())
        .chain(argv.iter().map(|a| {
            if a.is_empty() || a.contains(|c: char| c.is_whitespace() || "\"'$`;&|<>()".contains(c))
            {
                format!("'{}'", a.replace('\'', "'\\''"))
            } else {
                a.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ");
    match dispatch(argv, io) {
        Ok(code) => code,
        // A hook keeps the agent's protocol: exit 2 there would block the tool.
        Err(e) if cmd == "hook" => {
            (io.err)(&e);
            1
        }
        Err(e) => {
            // A reader of the JSON gets JSON even when nothing could be done.
            let ours: Vec<&String> = argv.iter().take_while(|a| *a != "--").collect();
            let wants_json = matches!(cmd, "status" | "check")
                && (ours.iter().any(|a| *a == "--json")
                    || ours
                        .windows(2)
                        .any(|w| w[0] == "--format" && w[1] == "json"));
            if wants_json {
                (io.out)(&crate::commands::status::error_json(&e));
            }
            (io.err)(&e);
            2
        }
    }
}

fn dispatch(argv: &[String], io: &mut Io) -> Fallible<i32> {
    let (cmd, rest) = match argv.split_first() {
        Some((c, r)) => (c.as_str(), r),
        None => return commands::guide::guide(io),
    };
    if cmd == "sync" {
        return Err("`vibloom sync` is gone: the run log is local since 0.8.0, so there is nothing to merge. CI re-runs the tests with `vibloom check --base`.".into());
    }
    if !COMMANDS.contains(&cmd) && !matches!(cmd, "--help" | "-h" | "--version" | "-V") {
        return Err(format!(
            "{} `vibloom help` lists the commands.",
            crate::suggest::unknown("command", cmd, COMMANDS)
        ));
    }
    // Our options come first; only what follows "--" goes to the runner, so a
    // mistyped option is never run as a test filter.
    let valued: &[&str] = match cmd {
        "check" => &["--base", "--format"],
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
        "proposals" => &["--on", "--contract"],
        "add" => &[
            "--id",
            "--file",
            "--contract",
            "--tool",
            "--test",
            "--watch",
            "--on",
            "--detail",
            "--evidence",
        ],
        _ => &[],
    };
    let flags: &[&str] = match cmd {
        "status" => &["--json", "--strict"],
        "diff" => &["--json"],
        "check" => &["--json", "--strict", "--allow-guard-changes"],
        "scan" => &["--tighten"],
        "add" => &["--hypothetical", "--adopted", "--unprotected"],
        "survey" => &["--propose"],
        "proposals" => &["--all", "--full"],
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
    let strict = args.set.contains(&"--strict");
    let takes_words = matches!(
        cmd,
        "hook" | "context" | "proposals" | "add" | "setup" | "edit" | "remove" | "survey" | "diff"
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
    // Only a command that records a run moves an old committed log aside; a
    // command that only reads must leave the project's files as they are.
    crate::store::follow_git(&root);
    let note = if matches!(cmd, "run" | "check") {
        crate::store::migrate_log(&root)
    } else {
        crate::store::legacy_log_note(&root)
    };
    if let Some(note) = note {
        (io.err)(&note);
    }
    match cmd {
        "scan" => commands::init::rescan(&root, io, args.set.contains(&"--tighten")),
        "add" => commands::nodes::add(&root, io, &args),
        "install-hook" => {
            (io.out)(&install_hook(&root)?);
            Ok(0)
        }
        "setup" => commands::agents::setup(&root, io, &args),
        "status" => commands::status::status(&root, io, as_json, strict),
        "diff" => commands::diff::diff(&root, io, &args, as_json),
        "run" => commands::run::run_tests(&root, io, &extra),
        "check" => {
            let format = match (as_json, args.opt("--format")) {
                (true, Some(f)) if f != "json" => {
                    return Err("--json and --format say two things; give one.".into());
                }
                (true, _) => commands::run::Format::Json,
                (false, None) => commands::run::Format::Text,
                (false, Some(f)) => commands::run::Format::parse(f)?,
            };
            let allow = args.set.contains(&"--allow-guard-changes");
            if allow && base.is_none() {
                return Err("--allow-guard-changes only means something with --base.".into());
            }
            let o = commands::run::CheckOpts {
                base,
                allow_guard_changes: allow,
                strict,
                format,
            };
            commands::run::check(&root, io, &o, &extra)
        }
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
        "proposals" => commands::proposals::proposals(&root, &args, io),
        other => Err(format!("Unknown command {other}.")),
    }
}
