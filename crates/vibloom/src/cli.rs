//! The `vibloom` command: the only part of the guard that touches the disk,
//! runs processes or talks to git.

use crate::context::context;
use crate::derive::{Files, NodeView, derive, label, troubled};
use crate::forge::{Outcome, RunnerOutputError, parse_forge};
use crate::gate::precommit;
use crate::hash::sha256_hex;
use crate::hooks::{HookInput, HookOutput, Role, post_tool, pre_tool, stop, test_run};
use crate::junit::parse_junit;
use crate::log::{ReadLog, RunBody, RunEntry, extends_log, next_entry, read_log, to_line};
use crate::map::{
    Kind, LOG_PATH, MAP_PATH, PROPOSALS_PATH, RootNode, RootsMap, Stance, TestRef, parse_map,
    serialize_map, test_name, watched_by,
};
use crate::proposals::{Book, Decision, accept, fresh_id, with_node};
use crate::scan::{Found, add_found, find_invariants};
use crate::setup::{Plan, Stack, entry_points, helpers, plan, unmentioned};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

// Skipped only when git cannot say what is ignored (not a repository).
const SKIP_DIRS: [&str; 10] = [
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

// Where the guard keeps what must never be staged or committed (its lock,
// what it already told the agent): the repository's git folder, or a folder
// of its own in the temp folder when there is no repository.
fn state_dir(root: &Path) -> PathBuf {
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
fn write_atomic(path: &Path, text: &str) -> Fallible<()> {
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

// The files of a watched directory: what git tracks or would track there, so
// build output and caches that the project ignores never count as a change.
fn files_under(root: &Path, dir: &str, out: &mut Vec<String>) {
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
    let map = load_map(root)?;
    Ok(derive(
        &map,
        &load_log(root).entries,
        &hash_watched(root, &map),
    ))
}

struct Finished {
    stdout: String,
    stderr: String,
}

// The runner with a time limit: a test that hangs must not hang the agent's
// hook or CI for ever. Output is drained on threads so a full pipe cannot
// block the child.
fn run_child(exe: &str, args: &[String], root: &Path, limit: u64) -> Result<Finished, String> {
    use std::io::Read as _;
    use std::process::Stdio;
    let mut child = Command::new(exe)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {exe}: {e}"))?;
    let drain = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed().as_secs() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "the runner did not finish in {limit} s and was stopped (\"timeout\" in the map sets the limit)"
                ));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(e) => return Err(format!("could not wait for {exe}: {e}")),
        }
    }
    Ok(Finished {
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
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
            "{LOG_PATH} failed verification:\n- {}\nA verifier can set the broken part aside with `vibloom repair`.",
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
    match run_child(exe, args, root, map.timeout) {
        Err(e) => error = Some(e),
        Ok(res) => {
            let stdout = res.stdout;
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
                    let stderr = res.stderr;
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
    // The tests may have taken minutes and another run may have been recorded
    // meanwhile: the entry is chained to the log as it is now, under the lock.
    let (entry, mut entries) = locked(root, || {
        let log = load_log(root);
        if !log.problems.is_empty() {
            return Err(format!(
                "{LOG_PATH} failed verification:\n- {}",
                log.problems.join("\n- ")
            ));
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
        Ok((entry, log.entries))
    })?;
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

fn last_json(text: &str) -> Option<Value> {
    let line = text.lines().map(str::trim).rfind(|l| l.starts_with('{'))?;
    serde_json::from_str(line).ok()
}

// What the project is and how its tests run, asking forge for its own
// folders when it is a Foundry project.
fn project_plan(root: &Path, stack: Option<Stack>) -> Plan {
    let has = |f: &str| root.join(f).is_file();
    let stack = stack.unwrap_or_else(|| Stack::detect(&has));
    let config = (stack == Stack::Foundry)
        .then(|| run_child("forge", &["config".into(), "--json".into()], root, 60).ok())
        .flatten()
        .and_then(|r| last_json(&r.stdout));
    plan(stack, config.as_ref(), &has)
}

// Foundry's own list of tests: it knows the contract each test runs in, also
// for a test inherited from a base contract, which reading the source cannot.
fn forge_invariants(root: &Path, exe: &str) -> Option<Vec<Found>> {
    let args = ["test".to_string(), "--list".into(), "--json".into()];
    let listed = last_json(&run_child(exe, &args, root, 600).ok()?.stdout)?;
    let mut out = Vec::new();
    for (file, contracts) in listed.as_object()? {
        for (contract, tests) in contracts.as_object()? {
            for name in tests.as_array()?.iter().filter_map(Value::as_str) {
                if name.starts_with("invariant") || name.starts_with("statefulFuzz") {
                    out.push(Found {
                        file: file.clone(),
                        contract: contract.clone(),
                        name: test_name(name),
                    });
                }
            }
        }
    }
    Some(out)
}

/// What the tests leave out, for a Foundry project: state-changing functions
/// of the project's contracts that no test file even names, and handler
/// functions whose every call reverted in the latest run.
pub fn gaps(root: &Path) -> Fallible<String> {
    let map = load_map(root)?;
    if map.report.is_some() {
        return Err(
            "`vibloom gaps` reads Foundry's build output; this project uses another runner.".into(),
        );
    }
    let config = run_child("forge", &["config".into(), "--json".into()], root, 60)
        .ok()
        .and_then(|r| last_json(&r.stdout));
    let dir = |k: &str, default: &str| {
        config
            .as_ref()
            .and_then(|c| c.get(k))
            .and_then(Value::as_str)
            .unwrap_or(default)
            .trim_matches('/')
            .to_string()
    };
    let (src, out_dir) = (dir("src", "src"), dir("out", "out"));
    let mut sources = Vec::new();
    files_under(root, &src, &mut sources);
    let mut tests = Vec::new();
    files_under(root, map.tests.trim_end_matches('/'), &mut tests);
    let text: String = tests
        .iter()
        .filter_map(|f| fs::read_to_string(root.join(f)).ok())
        .collect::<Vec<_>>()
        .join("\n");
    let mut lines = Vec::new();
    let mut built = false;
    for file in sources.iter().filter(|f| f.ends_with(".sol")) {
        let base = file.rsplit('/').next().unwrap_or(file);
        let Ok(read) = fs::read_dir(root.join(&out_dir).join(base)) else {
            continue;
        };
        let mut artifacts: Vec<PathBuf> = read.filter_map(|e| Some(e.ok()?.path())).collect();
        artifacts.sort();
        for path in artifacts {
            let Some(artifact) = fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            else {
                continue;
            };
            // Two files may share a name; the artifact says which it compiled.
            let contract = artifact
                .pointer("/metadata/settings/compilationTarget")
                .and_then(|t| t.get(file))
                .and_then(Value::as_str);
            let Some(contract) = contract else { continue };
            built = true;
            let missing = unmentioned(&entry_points(&artifact), &text);
            if !missing.is_empty() {
                lines.push(format!("- {contract} ({file}): {}", missing.join(", ")));
            }
        }
    }
    if !built {
        return Err(format!(
            "No build output for {src}/ under {out_dir}/. Run `forge build` or `vibloom run` first."
        ));
    }
    let mut out = Vec::new();
    if lines.is_empty() {
        out.push(format!(
            "Every state-changing function under {src}/ is named somewhere in {}.",
            map.tests
        ));
    } else {
        out.push(format!(
            "State-changing functions no file under {} names, so no test can reach them:",
            map.tests
        ));
        out.extend(lines);
    }
    let dead: BTreeSet<String> = views(root)?
        .iter()
        .filter_map(|v| v.fuzz.as_ref())
        .flat_map(|f| f.dead.iter().cloned())
        .collect();
    if !dead.is_empty() {
        out.push("Handler functions whose every call reverted in the latest run:".into());
        out.extend(dead.iter().map(|d| format!("- {d}")));
    }
    out.push(
        "A name that appears in the tests may still not be exercised; one that does not appear cannot be."
            .into(),
    );
    Ok(out.join("\n"))
}

struct Scanned {
    map: RootsMap,
    added: Vec<String>,
    /// Handlers and base contracts now guarded with the tests that use them.
    guarded: Vec<String>,
}

fn scan(root: &Path, map: &RootsMap, src: Option<&str>) -> Scanned {
    let foundry = map.report.is_none();
    let found = foundry
        .then(|| forge_invariants(root, map.runner.first().map_or("forge", String::as_str)))
        .flatten()
        .unwrap_or_else(|| {
            let mut files = Vec::new();
            walk(root, map.tests.trim_end_matches('/'), &mut files);
            files
                .iter()
                .filter(|f| f.ends_with(".t.sol"))
                .flat_map(|f| {
                    find_invariants(f, &fs::read_to_string(root.join(f)).unwrap_or_default())
                })
                .collect()
        });
    // A change to the sources or to any test file puts a found invariant up
    // for review: its handler lives among the tests.
    let mut watch: Vec<String> = src.map(str::to_string).into_iter().collect();
    if !watch.contains(&map.tests) {
        watch.push(map.tests.clone());
    }
    let (mut out, added) = add_found(map, &found, &watch);
    let tests: Vec<String> = out
        .nodes
        .iter()
        .filter(|n| n.protected)
        .filter_map(|n| n.test.as_ref().map(|t| t.file.clone()))
        .collect();
    let read = |f: &str| fs::read_to_string(root.join(f)).ok();
    let mut guarded = Vec::new();
    for h in helpers(&tests, &map.tests, &read) {
        if !crate::hooks::is_guarded(&out, &h) {
            out.protect.push(h.clone());
            guarded.push(h);
        }
    }
    Scanned {
        map: out,
        added,
        guarded,
    }
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

// The deepest ancestor that exists is resolved, so a new file in a new folder
// under a symlinked root (macOS's /var -> /private/var) still lands inside it.
fn real(p: &Path) -> PathBuf {
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
            // After a test run, the guard runs the tests itself and records
            // that; the agent's own output is never parsed or trusted.
            let filters = (input.tool_name == "Bash")
                .then(|| test_run(&map, input.command.as_deref().unwrap_or_default()))
                .flatten();
            let ran = filters.is_some();
            let vs = match filters {
                Some(f) => run(&root, &f)?.views,
                None => views(&root)?,
            };
            let out = post_tool(&input, &vs, ran, &rel);
            // The same note after every edit of the same file would only fill
            // the agent's context: it is given once per file and run.
            if !ran && out.stdout.is_some() {
                let seq = load_log(&root).entries.last().map_or(0, |e| e.seq);
                let key = format!(
                    "{seq}\t{}",
                    input.file_path.as_deref().and_then(rel).unwrap_or_default()
                );
                let path = state_dir(&root).join("vibloom-notified");
                let seen = fs::read_to_string(&path).unwrap_or_default();
                if seen.lines().any(|l| l == key) {
                    return Ok(HookOutput::default());
                }
                // Notes from earlier runs no longer matter.
                let kept: String = seen
                    .lines()
                    .filter(|l| l.starts_with(&format!("{seq}\t")))
                    .map(|l| format!("{l}\n"))
                    .collect();
                let _ = fs::write(&path, format!("{kept}{key}\n"));
            }
            Ok(out)
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

  vibloom init [--stack S] [--agent claude|codex]
                             create .vibloom/roots.json for this project (foundry, hardhat,
                             cargo or pytest; detected when not given), install the commit
                             check and, with --agent, connect that agent
  vibloom setup claude|codex connect an agent to an existing map (verifier)
  vibloom install-hook       install the commit check in another clone
  vibloom add <kind> \"<title>\" [--file F --test N [--contract C]] [--watch P] [--on ID]
                             add an assumption, invariant or intention (verifier)
  vibloom scan               add invariant tests the map does not list yet (verifier)
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
  vibloom proposals accept|reject <id>
                             move a proposal into the map, or turn it down (verifier)
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
        "add" => &[
            "--id",
            "--file",
            "--contract",
            "--test",
            "--watch",
            "--on",
            "--detail",
        ],
        _ => &[],
    };
    let flags: &[&str] = match cmd {
        "status" => &["--json"],
        "add" => &["--hypothetical", "--unprotected"],
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
    let opt = |k: &str| opts.iter().rev().find(|(n, _)| *n == k).map(|(_, v)| *v);
    let all = |k: &str| -> Vec<String> {
        opts.iter()
            .filter(|(n, _)| *n == k)
            .map(|(_, v)| (*v).to_string())
            .collect()
    };
    let base = opt("--base").map(str::to_string);
    let as_json = set.contains(&"--json");
    let takes_words = matches!(cmd, "hook" | "context" | "proposals" | "add" | "setup");
    if !takes_words && !words.is_empty() {
        return Err(format!(
            "`vibloom {cmd}` takes no argument like {}.{}",
            words[0],
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
            let stack = match opt("--stack") {
                None => None,
                Some(s) => Some(Stack::parse(s).ok_or_else(|| {
                    format!("Unknown stack {s}: use foundry, hardhat, cargo or pytest.")
                })?),
            };
            let p = project_plan(&io.cwd, stack);
            let mut agent_notes = Vec::new();
            let mut protect = p.protect.clone();
            for agent in all("--agent") {
                let (notes, guard) = setup_agent(&io.cwd, &agent)?;
                agent_notes.extend(notes);
                protect.extend(guard);
            }
            let start = RootsMap {
                runner: p.runner.clone(),
                report: p.report.clone(),
                tests: p.tests.clone(),
                protect,
                ..RootsMap::empty()
            };
            let found = scan(&io.cwd, &start, p.src.as_deref());
            fs::create_dir_all(io.cwd.join(".vibloom")).map_err(|e| e.to_string())?;
            write_atomic(&io.cwd.join(MAP_PATH), &serialize_map(&found.map))?;
            (io.out)(&format!(
                "Created {MAP_PATH}: runner `{}`, {} invariant tests found.",
                p.runner.join(" "),
                found.added.len()
            ));
            if !found.map.protect.is_empty() {
                (io.out)(&format!(
                    "Guarded besides the tests: {}.",
                    found.map.protect.join(", ")
                ));
            }
            for n in p.notes.iter().chain(&agent_notes) {
                (io.out)(n);
            }
            // The commit check comes with the map when this is a git clone
            // with no pre-commit hook of its own.
            match install_hook(&io.cwd) {
                Ok(done) => (io.out)(&done),
                Err(why) => (io.out)(&format!("Commit check not installed: {why}")),
            }
            (io.out)(
                "Next: `vibloom check` to run the tests; `vibloom add` for assumptions and intentions.",
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
            verifier(io.role, "changes the map")?;
            let map = load_map(&root)?;
            let src = project_plan(&root, None).src;
            let found = scan(&root, &map, src.as_deref());
            if !found.added.is_empty() || !found.guarded.is_empty() {
                write_atomic(&root.join(MAP_PATH), &serialize_map(&found.map))?;
            }
            (io.out)(&if found.added.is_empty() {
                "No new invariant tests.".to_string()
            } else {
                format!("Added {}.", found.added.join(", "))
            });
            if !found.guarded.is_empty() {
                (io.out)(&format!("Now guarded: {}.", found.guarded.join(", ")));
            }
            Ok(0)
        }
        "add" => {
            verifier(io.role, "changes the map")?;
            let usage = "Usage: vibloom add <assumption|invariant|intention> \"<title>\" [--file F --test N [--contract C]] [--watch P]... [--on ID]... [--detail D] [--id ID] [--hypothetical] [--unprotected]";
            let (Some(kind), Some(title), None) = (
                words.first().and_then(|k| Kind::parse(k)),
                words.get(1),
                words.get(2),
            ) else {
                return Err(usage.into());
            };
            let map = load_map(&root)?;
            let test = match (opt("--file"), opt("--test")) {
                (Some(f), Some(n)) => Some(TestRef {
                    file: relative_to(&root, &io.cwd, f)
                        .ok_or_else(|| format!("{f} is outside the project."))?,
                    contract: opt("--contract").map(str::to_string),
                    name: test_name(n),
                }),
                (None, None) => None,
                _ => return Err(format!("A test needs both --file and --test.\n{usage}")),
            };
            let mut watch = Vec::new();
            for w in all("--watch") {
                let dir = w.ends_with('/');
                let r = relative_to(&root, &io.cwd, &w)
                    .ok_or_else(|| format!("{w} is outside the project."))?;
                watch.push(if dir { format!("{r}/") } else { r });
            }
            // A tested node with nothing to watch would never go stale: it
            // watches the sources and the tests unless told otherwise.
            if watch.is_empty() && test.is_some() {
                watch.extend(project_plan(&root, None).src);
                if !watch.contains(&map.tests) {
                    watch.push(map.tests.clone());
                }
            }
            let id = opt("--id").map_or_else(|| fresh_id(&map, kind, title), str::to_string);
            let node = RootNode {
                id: id.clone(),
                kind,
                title: (*title).to_string(),
                detail: opt("--detail").map(str::to_string),
                stance: if set.contains(&"--hypothetical") {
                    Stance::Hypothetical
                } else {
                    Stance::Adopted
                },
                test,
                watch,
                depends_on: all("--on"),
                protected: kind == Kind::Invariant && !set.contains(&"--unprotected"),
            };
            let next = with_node(&map, node)
                .map_err(|e| format!("The node cannot be added:\n- {}", e.join("\n- ")))?;
            write_atomic(&root.join(MAP_PATH), &serialize_map(&next))?;
            (io.out)(&format!("Added {id}."));
            Ok(0)
        }
        "install-hook" => {
            (io.out)(&install_hook(&root)?);
            Ok(0)
        }
        "setup" => {
            verifier(io.role, "changes what is guarded")?;
            let agent = words.first().copied().unwrap_or_default();
            let (notes, guard) = setup_agent(&root, agent)?;
            let mut map = load_map(&root)?;
            let before = map.protect.len();
            for g in guard {
                if !crate::hooks::is_guarded(&map, &g) {
                    map.protect.push(g);
                }
            }
            if map.protect.len() != before {
                write_atomic(&root.join(MAP_PATH), &serialize_map(&map))?;
            }
            for n in notes {
                (io.out)(&n);
            }
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
            if as_json {
                let nodes: Vec<Value> = vs
                    .iter()
                    .map(|v| {
                        let mut j = serde_json::to_value(v).unwrap_or(Value::Null);
                        j["state"] = json!(label(v));
                        j["needs_attention"] = json!(troubled(v));
                        j
                    })
                    .collect();
                (io.out)(&json!({ "nodes": nodes, "log_problems": problems }).to_string());
            } else {
                (io.out)(&table(&vs));
            }
            Ok(i32::from(vs.iter().any(troubled) || !problems.is_empty()))
        }
        "sync" => {
            let b = base
                .as_deref()
                .ok_or("Usage: vibloom sync --base <commit>, for example --base origin/main")?;
            // A branch whose log no longer extends the base's (the base moved
            // on, or a merge left both histories in the file) takes the
            // base's log and records the tests again on top of it.
            if check_base(&root, b).is_empty() {
                (io.out)(&format!("The run log already extends the one on {b}."));
            } else {
                let shown = git(&root, &["show", &format!("{b}:./{LOG_PATH}")]).unwrap_or_default();
                let base_log = read_log(&shown);
                if !base_log.problems.is_empty() {
                    return Err(format!(
                        "The run log on {b} does not verify:\n- {}",
                        base_log.problems.join("\n- ")
                    ));
                }
                locked(&root, || write_atomic(&root.join(LOG_PATH), &shown))?;
                (io.out)(&format!(
                    "Took the {} runs on {b}; this branch's own runs are replaced by the one recorded now.",
                    base_log.entries.len()
                ));
            }
            let report = run(&root, &[])?;
            (io.out)(&format!(
                "Run {}: {} test results recorded.",
                report.entry.seq,
                report.entry.outcomes.len()
            ));
            (io.out)(&table(&report.views));
            Ok(i32::from(
                report.views.iter().any(troubled) || report.entry.error.is_some(),
            ))
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
        "repair" => repair(&root, io),
        "gaps" => {
            (io.out)(&gaps(&root)?);
            Ok(0)
        }
        "context" => {
            let file = words.first().and_then(|f| relative_to(&root, &io.cwd, f));
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
        "proposals" => proposals(&root, &words, io),
        other => Err(format!("Unknown command {other}.\n\n{USAGE}")),
    }
}

const HOOK_LINE: &str = "vibloom precommit";

// The commit check in this clone's git hooks. Says what it did; an existing
// hook of another tool is never overwritten.
fn install_hook(root: &Path) -> Fallible<String> {
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
    fs::write(
        &path,
        format!(
            "#!/bin/sh\n# VIBloom: refuse a commit that breaks the map.\nif ! command -v vibloom >/dev/null 2>&1; then\n  echo \"VIBloom: vibloom is not on PATH, so the commit check cannot run.\" >&2\n  exit 1\nfi\nexec {HOOK_LINE}\n"
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

fn read_json(path: &Path) -> Fallible<Value> {
    match fs::read_to_string(path) {
        Err(_) => Ok(json!({})),
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str::<Value>(&text)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| format!("{} is not a JSON object; fix it first.", path.display())),
    }
}

fn write_json(path: &Path, v: &Value) -> Fallible<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(
        path,
        &format!("{}\n", serde_json::to_string_pretty(v).unwrap_or_default()),
    )
}

const AGENTS_START: &str = "<!-- vibloom:start -->";
const AGENTS_SECTION: &str = "<!-- vibloom:start -->
## VIBloom

This project keeps its assumptions, invariants and intentions in
`.vibloom/roots.json`. Their states come from recorded test runs, not from
anyone's say-so.

- Before changing a file: `vibloom context <file>`.
- After changing code: `vibloom run`. It runs the tests and records them.
- The task is not done while `vibloom status` exits 1.
- Never edit a protected test, its handler, the test configuration or
  `.vibloom/` to make a check pass. If an invariant looks wrong, stop and say
  why.
- To suggest an assumption, invariant or intention, use the `propose` tool of
  the vibloom MCP server. A person decides.
<!-- vibloom:end -->
";

// Connects an agent to the guard, changing only the guard's own entries in
// the agent's files. Returns what it did and which files to guard, so the
// agent cannot switch the guard off by editing them.
fn setup_agent(root: &Path, agent: &str) -> Fallible<(Vec<String>, Vec<String>)> {
    match agent {
        "claude" => {
            let settings = root.join(".claude/settings.json");
            let mut v = read_json(&settings)?;
            let ours = hooks_config();
            let mut added = 0;
            for (event, entries) in ours["hooks"].as_object().into_iter().flatten() {
                let list = &mut v["hooks"][event];
                if !list.is_array() {
                    *list = json!([]);
                }
                if !list.to_string().contains("vibloom hook") {
                    for e in entries.as_array().into_iter().flatten() {
                        list.as_array_mut()
                            .into_iter()
                            .for_each(|l| l.push(e.clone()));
                        added += 1;
                    }
                }
            }
            if added > 0 {
                write_json(&settings, &v)?;
            }
            let mcp = root.join(".mcp.json");
            let mut m = read_json(&mcp)?;
            let had = m.pointer("/mcpServers/vibloom").is_some();
            if !had {
                m["mcpServers"]["vibloom"] = json!({ "command": "vibloom", "args": ["mcp"] });
                write_json(&mcp, &m)?;
            }
            Ok((
                vec![
                    if added > 0 {
                        "Claude Code: hooks added to .claude/settings.json.".into()
                    } else {
                        "Claude Code: the hooks were already in .claude/settings.json.".into()
                    },
                    if had {
                        "Claude Code: the vibloom tools were already in .mcp.json.".into()
                    } else {
                        "Claude Code: vibloom tools added to .mcp.json. Approve the server when Claude Code asks.".into()
                    },
                ],
                // The local settings file can switch every hook off.
                vec![
                    ".claude/settings.json".into(),
                    ".claude/settings.local.json".into(),
                    ".mcp.json".into(),
                ],
            ))
        }
        "codex" => {
            let path = root.join("AGENTS.md");
            let text = fs::read_to_string(&path).unwrap_or_default();
            let wrote = !text.contains(AGENTS_START);
            if wrote {
                let sep = if text.is_empty() || text.ends_with("\n\n") {
                    ""
                } else if text.ends_with('\n') {
                    "\n"
                } else {
                    "\n\n"
                };
                write_atomic(&path, &format!("{text}{sep}{AGENTS_SECTION}"))?;
            }
            Ok((
                vec![
                    if wrote {
                        "Codex: instructions added to AGENTS.md.".into()
                    } else {
                        "Codex: AGENTS.md already has the instructions.".into()
                    },
                    "Codex: register the tools once with: codex mcp add vibloom -- vibloom mcp".into(),
                    "Codex has no hooks to stop an edit while it works: the commit check and `vibloom check` in CI are what hold.".into(),
                ],
                vec![],
            ))
        }
        other => Err(format!(
            "Unknown agent {other:?}: use `vibloom setup claude` or `vibloom setup codex`."
        )),
    }
}

fn verifier(role: Role, what: &str) -> Fallible<()> {
    if role == Role::Verifier {
        Ok(())
    } else {
        Err(format!(
            "This {what}: only the verifier does it. Run it as VIBLOOM_ROLE=verifier."
        ))
    }
}

// Sets aside everything from the first broken link on. The runs before it
// still verify; the rest was never trusted and is kept apart, not deleted.
fn repair(root: &Path, io: &mut Io) -> Fallible<i32> {
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

fn proposals(root: &Path, rest: &[&str], io: &mut Io) -> Fallible<i32> {
    let book = load_book(root);
    match (rest.first().copied(), rest.get(1)) {
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
            // Deciding changes the map: the same role that may edit it by hand.
            if io.role != Role::Verifier {
                return Err(format!(
                    "Only the verifier decides proposals: VIBLOOM_ROLE=verifier vibloom proposals {action} {id}"
                ));
            }
            let Some(p) = book.pending().into_iter().find(|p| p.id == *id).cloned() else {
                return Err(format!("No pending proposal {id}."));
            };
            let mut node = None;
            if action == "accept" {
                let (map, new_id) = accept(&load_map(root)?, &p)
                    .map_err(|e| format!("{id} cannot be accepted:\n- {}", e.join("\n- ")))?;
                write_atomic(&root.join(MAP_PATH), &serialize_map(&map))?;
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
