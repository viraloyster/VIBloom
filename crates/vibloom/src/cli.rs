//! The `vibloom` command: the only part of the guard that touches the disk,
//! runs processes or talks to git.

use crate::context::context;
use crate::derive::{Files, NodeView, derive, label, troubled};
use crate::forge::{Outcome, RunnerOutputError, forge_filters, parse_forge};
use crate::gate::precommit;
use crate::hash::sha256_hex;
use crate::hooks::{HookInput, HookOutput, Role, post_tool, pre_tool, stop};
use crate::junit::parse_junit;
use crate::log::{ReadLog, RunBody, RunEntry, extends_log, next_entry, read_log, to_line};
use crate::map::{
    LOG_PATH, MAP_PATH, PROPOSALS_PATH, RootsMap, parse_map, serialize_map, watched_by,
};
use crate::proposals::{Book, Decision, accept};
use crate::scan::{add_found, find_invariants};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const SKIP_DIRS: [&str; 5] = [".git", "node_modules", "out", "cache", "broadcast"];

pub struct Io<'a> {
    pub cwd: PathBuf,
    pub role: Role,
    pub stdin: &'a mut dyn FnMut() -> String,
    pub out: &'a mut dyn FnMut(&str),
    pub err: &'a mut dyn FnMut(&str),
}

pub type Fallible<T> = Result<T, String>;

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
    parse_map(&raw).map_err(|errs| format!("{MAP_PATH} has problems:\n- {}", errs.join("\n- ")))
}

pub fn load_log(root: &Path) -> ReadLog {
    read_log(&fs::read_to_string(root.join(LOG_PATH)).unwrap_or_default())
}

fn load_book(root: &Path) -> Book {
    Book::read(&fs::read_to_string(root.join(PROPOSALS_PATH)).unwrap_or_default())
}

fn append(root: &Path, rel: &str, line: &str) -> Fallible<()> {
    fs::create_dir_all(root.join(".vibloom")).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(rel))
        .map_err(|e| format!("cannot write {rel}: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("cannot write {rel}: {e}"))
}

fn walk(root: &Path, dir: &str, out: &mut Vec<String>) {
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

/// The hash of every file any node watches, as the tree is right now.
pub fn hash_watched(root: &Path, map: &RootsMap) -> Files {
    let mut out = Files::new();
    let watches: BTreeSet<String> = map.nodes.iter().flat_map(watched_by).collect();
    for w in watches {
        let mut files = Vec::new();
        if let Some(dir) = w.strip_suffix('/') {
            walk(root, dir, &mut files);
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
    let map = load_map(root)?;
    Ok(derive(
        &map,
        &load_log(root).entries,
        &hash_watched(root, &map),
    ))
}

pub struct RunReport {
    pub entry: RunEntry,
    pub views: Vec<NodeView>,
}

pub fn run(root: &Path, extra: &[String]) -> Fallible<RunReport> {
    let map = load_map(root)?;
    let log = load_log(root);
    if !log.problems.is_empty() {
        return Err(format!(
            "{LOG_PATH} failed verification:\n- {}",
            log.problems.join("\n- ")
        ));
    }
    // Hashed before the run: these are the files the tests ran against.
    let files = hash_watched(root, &map);
    let mut command = map.runner.clone();
    command.extend(extra.iter().cloned());
    let (exe, args) = command.split_first().ok_or("the runner is empty")?;
    // A report left by an earlier run must never be read as this run's.
    if let Some(report) = &map.report {
        let path = root.join(report);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("could not remove the old report {report}: {e}"))?;
        }
    }
    let mut outcomes: Vec<Outcome> = vec![];
    let mut error = None;
    match Command::new(exe).args(args).current_dir(root).output() {
        Err(e) => error = Some(format!("could not start {exe}: {e}")),
        Ok(res) => {
            let stdout = String::from_utf8_lossy(&res.stdout);
            let parsed = match &map.report {
                None => parse_forge(&stdout),
                Some(report) => match std::fs::read_to_string(root.join(report)) {
                    Ok(xml) => parse_junit(&xml, &root.to_string_lossy()),
                    Err(_) => Err(RunnerOutputError(format!(
                        "the runner wrote no report at {report}"
                    ))),
                },
            };
            match parsed {
                Ok(o) => outcomes = o,
                Err(e) => {
                    let stderr = String::from_utf8_lossy(&res.stderr);
                    let src = if stderr.trim().is_empty() {
                        stdout
                    } else {
                        stderr
                    };
                    let lines: Vec<&str> = src.trim().lines().collect();
                    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
                    error = Some(if tail.is_empty() {
                        e.0
                    } else {
                        format!("{}\n{tail}", e.0)
                    });
                }
            }
        }
    }
    let entry = next_entry(
        log.entries.last(),
        RunBody {
            at: iso_now(),
            command,
            outcomes,
            files,
            error,
        },
    );
    append(root, LOG_PATH, &to_line(&entry))?;
    let mut entries = log.entries;
    entries.push(entry.clone());
    let views = derive(&map, &entries, &hash_watched(root, &map));
    Ok(RunReport { entry, views })
}

pub fn table(vs: &[NodeView]) -> String {
    if vs.is_empty() {
        return "The map has no nodes yet. Run `vibloom scan` or edit .vibloom/roots.json.".into();
    }
    let w = vs.iter().map(|v| label(v).len()).max().unwrap_or(0);
    let iw = vs.iter().map(|v| v.id.len()).max().unwrap_or(0);
    vs.iter()
        .map(|v| format!("{:w$}  {:iw$}  {}", label(v), v.id, v.title))
        .collect::<Vec<_>>()
        .join("\n")
}

fn scan(root: &Path, map: &RootsMap) -> (RootsMap, Vec<String>) {
    let mut files = Vec::new();
    walk(root, map.tests.trim_end_matches('/'), &mut files);
    let found: Vec<_> = files
        .iter()
        .filter(|f| f.ends_with(".t.sol"))
        .flat_map(|f| find_invariants(f, &fs::read_to_string(root.join(f)).unwrap_or_default()))
        .collect();
    add_found(map, &found)
}

pub fn hooks_config() -> Value {
    json!({ "hooks": {
        "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
                         "hooks": [{ "type": "command", "command": "vibloom hook pre-tool" }] }],
        "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
                          "hooks": [{ "type": "command", "command": "vibloom hook post-tool" }] }],
        "Stop": [{ "hooks": [{ "type": "command", "command": "vibloom hook stop" }] }]
    }})
}

// Lexical normalisation, so "a/../b" and symlink-free paths compare as written.
fn normalize(p: &Path) -> PathBuf {
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

fn real(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    match (
        p.parent().and_then(|d| d.canonicalize().ok()),
        p.file_name(),
    ) {
        (Some(d), Some(f)) => d.join(f),
        _ => normalize(p),
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

fn hook(kind: &str, stdin: &str, role: Role, cwd: &Path) -> Fallible<HookOutput> {
    let Ok(raw) = serde_json::from_str::<Value>(if stdin.trim().is_empty() { "{}" } else { stdin })
    else {
        return Ok(HookOutput {
            stderr: Some("VIBloom: the hook input was not JSON; nothing checked.".into()),
            stdout: None,
        });
    };
    let input = HookInput::from_json(&raw);
    let base = input
        .cwd
        .as_ref()
        .map_or_else(|| cwd.to_path_buf(), PathBuf::from);
    let Some(root) = find_root(&base) else {
        return Ok(HookOutput::default());
    };
    let rel = |p: &str| relative_to(&root, &base, p);
    let map = match load_map(&root) {
        Ok(m) => m,
        Err(e) => {
            return Ok(HookOutput {
                stderr: Some(e),
                stdout: None,
            });
        }
    };
    match kind {
        "pre-tool" => Ok(pre_tool(&input, &map, role, &rel)),
        "post-tool" => {
            // After a test run, the guard re-runs the same subset with --json
            // and records it; the agent's own output is never parsed or trusted.
            let filters = (input.tool_name == "Bash")
                .then(|| forge_filters(input.command.as_deref().unwrap_or_default()))
                .flatten();
            let vs = match filters {
                Some(f) => run(&root, &f)?.views,
                None => views(&root)?,
            };
            Ok(post_tool(&input, &vs, &rel))
        }
        "stop" => Ok(stop(&input, &views(&root)?, &load_log(&root).problems)),
        other => Ok(HookOutput {
            stderr: Some(format!("VIBloom: unknown hook {other}")),
            stdout: None,
        }),
    }
}

fn git(root: &Path, args: &[&str]) -> Fallible<String> {
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

// The log on the base commit, read from git rather than the working tree, so a
// branch cannot change what it is compared against.
fn check_base(root: &Path, base: &str) -> Vec<String> {
    if git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base}^{{commit}}"),
        ],
    )
    .is_err()
    {
        return vec![format!(
            "{base} is not a commit here (in CI, fetch the base branch first)"
        )];
    }
    let shown = git(root, &["show", &format!("{base}:./{LOG_PATH}")]).unwrap_or_default();
    let base_log = read_log(&shown);
    if !base_log.problems.is_empty() {
        return base_log
            .problems
            .iter()
            .map(|p| format!("base log: {p}"))
            .collect();
    }
    let head = load_log(root);
    if !head.problems.is_empty() {
        return head.problems;
    }
    extends_log(&base_log.entries, &head.entries)
}

pub const USAGE: &str = "vibloom: assumptions, invariants and intentions for a code project.

  vibloom init               create .vibloom/roots.json and list the invariant tests found
  vibloom scan               add invariant tests the map does not list yet
  vibloom status             the derived state of every node (exit 1 if any needs attention)
  vibloom run [-- args]      run the tests, record the run, show what changed
  vibloom check [--base ref] [-- args]
                             run, then exit 1 if any node needs attention (for CI); with
                             --base, first require the log to extend the one on that commit
  vibloom context [file]     what an agent should know before touching a file
  vibloom verify             check the run log's hash chain
  vibloom precommit          refuse a commit that changes guarded files or leaves a node
                             broken or untested since its files changed (any agent, any editor)
  vibloom proposals          list what agents proposed and nobody decided yet
  vibloom proposals accept|reject <id>
                             move a proposal into the map, or turn it down
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
    // Our options come first; anything else, or anything after "--", goes to the runner.
    let mut base: Option<String> = None;
    let mut extra: Vec<String> = vec![];
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--" => {
                extra.extend(rest[i + 1..].iter().cloned());
                break;
            }
            "--base" if cmd == "check" => {
                i += 1;
                base = rest.get(i).cloned();
            }
            a => extra.push(a.to_string()),
        }
        i += 1;
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
            let r = hook(
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
        "init" => {
            if io.cwd.join(MAP_PATH).exists() {
                return Err(format!("{MAP_PATH} already exists here."));
            }
            fs::create_dir_all(io.cwd.join(".vibloom")).map_err(|e| e.to_string())?;
            let (map, added) = scan(&io.cwd, &RootsMap::empty());
            fs::write(io.cwd.join(MAP_PATH), serialize_map(&map)).map_err(|e| e.to_string())?;
            (io.out)(&format!(
                "Created {MAP_PATH} with {} invariant tests found.",
                added.len()
            ));
            (io.out)(
                "Give them titles, add assumptions and intentions, and set up the commit check (see docs/guard.md).",
            );
            return Ok(0);
        }
        "mcp" => return crate::mcp::serve(&io.cwd).map(|()| 0),
        _ => {}
    }

    let root = find_root(&io.cwd).ok_or_else(|| {
        format!("No {MAP_PATH} here or above. Run `vibloom init` at the project root.")
    })?;
    match cmd {
        "scan" => {
            let (map, added) = scan(&root, &load_map(&root)?);
            if !added.is_empty() {
                fs::write(root.join(MAP_PATH), serialize_map(&map)).map_err(|e| e.to_string())?;
            }
            (io.out)(&if added.is_empty() {
                "No new invariant tests.".to_string()
            } else {
                format!("Added {}.", added.join(", "))
            });
            Ok(0)
        }
        "status" => {
            let vs = views(&root)?;
            let problems = load_log(&root).problems;
            if !problems.is_empty() {
                (io.err)(&format!(
                    "The run log failed verification; only runs before the break count:\n- {}",
                    problems.join("\n- ")
                ));
            }
            (io.out)(&table(&vs));
            Ok(i32::from(vs.iter().any(troubled) || !problems.is_empty()))
        }
        "run" | "check" => {
            if let Some(b) = base.as_deref() {
                let problems = check_base(&root, b);
                if !problems.is_empty() {
                    (io.err)(&format!(
                        "VIBloom: the run log does not extend the one on {b}:\n- {}",
                        problems.join("\n- ")
                    ));
                    return Ok(1);
                }
            }
            let before: std::collections::HashMap<String, &'static str> = views(&root)?
                .iter()
                .map(|v| (v.id.clone(), label(v)))
                .collect();
            let report = run(&root, &extra)?;
            if let Some(e) = &report.entry.error {
                (io.err)(&format!(
                    "Run {} recorded with an error: {e}",
                    report.entry.seq
                ));
            }
            (io.out)(&format!(
                "Run {}: {} test results recorded.",
                report.entry.seq,
                report.entry.outcomes.len()
            ));
            let moved: Vec<String> = report
                .views
                .iter()
                .filter(|v| before.get(&v.id).copied() != Some(label(v)))
                .map(|v| {
                    format!(
                        "  {}: {} -> {}",
                        v.id,
                        before.get(&v.id).copied().unwrap_or("new"),
                        label(v)
                    )
                })
                .collect();
            if !moved.is_empty() {
                (io.out)(&format!("Changed:\n{}", moved.join("\n")));
            }
            (io.out)(&table(&report.views));
            let failed = report.views.iter().any(troubled) || report.entry.error.is_some();
            Ok(i32::from(cmd == "check" && failed))
        }
        "context" => {
            let file = rest.first().and_then(|f| relative_to(&root, &io.cwd, f));
            (io.out)(&context(&views(&root)?, file.as_deref()));
            Ok(0)
        }
        "verify" => {
            let log = load_log(&root);
            if !log.problems.is_empty() {
                (io.err)(&log.problems.join("\n"));
                return Ok(1);
            }
            (io.out)(&format!("{} runs, chain intact.", log.entries.len()));
            Ok(0)
        }
        "precommit" => {
            let staged: Vec<String> = git(
                &root,
                &["diff", "--cached", "--name-only", "-z", "--relative"],
            )
            .map_err(|e| format!("git diff --cached failed: {e}"))?
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
            let problems = precommit(
                &load_map(&root)?,
                &views(&root)?,
                &staged,
                io.role,
                &load_log(&root).problems,
            );
            if problems.is_empty() {
                return Ok(0);
            }
            (io.err)(&format!(
                "VIBloom refused the commit:\n- {}",
                problems.join("\n- ")
            ));
            (io.err)(
                "Run `vibloom run` after changing code; only the verifier changes protected tests.",
            );
            Ok(1)
        }
        "proposals" => proposals(&root, rest, io),
        other => Err(format!("Unknown command {other}.\n\n{USAGE}")),
    }
}

fn proposals(root: &Path, rest: &[String], io: &mut Io) -> Fallible<i32> {
    let book = load_book(root);
    match (rest.first().map(String::as_str), rest.get(1)) {
        (None | Some("list"), _) => {
            let pending = book.pending();
            if pending.is_empty() {
                (io.out)("No pending proposals.");
            }
            for p in pending {
                let mut line = format!("{}  {}  {}", p.id, p.kind, p.title);
                if !p.depends_on.is_empty() {
                    line.push_str(&format!("  (rests on {})", p.depends_on.join(", ")));
                }
                if let Some(by) = &p.by {
                    line.push_str(&format!("  [by {by}]"));
                }
                (io.out)(&line);
                if let Some(d) = &p.detail {
                    (io.out)(&format!("    {d}"));
                }
            }
            Ok(0)
        }
        (Some(action @ ("accept" | "reject")), Some(id)) => {
            let Some(p) = book.pending().into_iter().find(|p| &p.id == id).cloned() else {
                return Err(format!("No pending proposal {id}."));
            };
            let mut node = None;
            if action == "accept" {
                let (map, new_id) = accept(&load_map(root)?, &p)
                    .map_err(|e| format!("{id} cannot be accepted:\n- {}", e.join("\n- ")))?;
                fs::write(root.join(MAP_PATH), serialize_map(&map)).map_err(|e| e.to_string())?;
                node = Some(new_id);
            }
            let d = Decision {
                decide: p.id.clone(),
                decision: action.into(),
                at: iso_now(),
                node: node.clone(),
            };
            append(
                root,
                PROPOSALS_PATH,
                &format!("{}\n", serde_json::to_string(&d).unwrap_or_default()),
            )?;
            (io.out)(&match node {
                Some(n) => format!(
                    "Accepted {id} as {n}. Review .vibloom/roots.json and commit it as the verifier."
                ),
                None => format!("Rejected {id}."),
            });
            Ok(0)
        }
        _ => Err("Usage: vibloom proposals [list | accept <id> | reject <id>]".into()),
    }
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

    #[test]
    fn relative_paths_stay_inside_the_root() {
        let root = std::env::temp_dir();
        let r = relative_to(&root, &root, "src/../test/A.t.sol");
        assert_eq!(r.as_deref(), Some("test/A.t.sol"));
        assert_eq!(relative_to(&root, &root, "/definitely/elsewhere"), None);
        assert_eq!(relative_to(&root, &root, "../outside"), None);
    }
}
