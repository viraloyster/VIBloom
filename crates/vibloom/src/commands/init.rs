use crate::cli::{Args, Fallible, Io};
use crate::commands::agents::setup_agent;
use crate::commands::verifier;
use crate::foundry::{Closure, forge_invariants, forge_list, import_closures, project_plan};
use crate::git::{git, install_hook};
use crate::map::{MAP_PATH, RootsMap, serialize_map};
use crate::scan::{Found, add_found, find_invariants};
use crate::setup::{Stack, helpers, tests_dir};
use crate::store::{ignore_local, load_map, walk, write_atomic};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub(crate) fn init(io: &mut Io, args: &Args) -> Fallible<i32> {
    if io.cwd.join(MAP_PATH).exists() {
        return Err(format!(
            "{MAP_PATH} already exists here. To connect an agent to it: vibloom setup claude (or codex)."
        ));
    }
    let stack =
        match args.opt("--stack") {
            None => None,
            Some(s) => Some(Stack::parse(s).ok_or_else(|| {
                format!("Unknown stack {s}: use foundry, hardhat, cargo or pytest.")
            })?),
        };
    let p = project_plan(&io.cwd, stack);
    let mut agent_notes = Vec::new();
    let mut protect = p.protect.clone();
    for agent in args.all("--agent") {
        let (notes, guard) = setup_agent(&io.cwd, &agent)?;
        agent_notes.extend(notes);
        protect.extend(guard);
    }
    let mut start = RootsMap {
        schema: Some(crate::map::SCHEMA_URL.to_string()),
        runner: p.runner.clone(),
        report: p.report.clone(),
        tests: p.tests.clone(),
        protect,
        ..RootsMap::empty()
    };
    let listed = forge_list(&io.cwd, &start);
    // Forge finds tests wherever they are; a dapptools project keeps
    // them in src/test/, not in the folder the config defaults to.
    let files: Vec<String> = listed
        .as_ref()
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    if let Some(t) = tests_dir(&start.tests, &files) {
        start.tests = t;
    }
    let found = scan(&io.cwd, &start, p.src.as_deref(), listed.as_ref(), true);
    fs::create_dir_all(io.cwd.join(".vibloom")).map_err(|e| e.to_string())?;
    write_atomic(&io.cwd.join(MAP_PATH), &serialize_map(&found.map))?;
    ignore_local(&io.cwd);
    (io.out)(&format!(
        "Created {MAP_PATH}: runner `{}`, {} invariant tests found.",
        p.runner.join(" "),
        found.added.len()
    ));
    if !found.added.is_empty() {
        (io.out)(found.graph);
    }
    if !found.map.protect.is_empty() {
        (io.out)(&format!(
            "Guarded besides the tests: {}.",
            found.map.protect.join(", ")
        ));
    }
    for n in p.notes.iter().chain(&agent_notes) {
        (io.out)(n);
    }
    // Most often run from the wrong folder: say so rather than leave a
    // map that watches nothing.
    let src = p.src.as_deref().unwrap_or("src/");
    if !io.cwd.join(src).is_dir() && !io.cwd.join(&start.tests).is_dir() && files.is_empty() {
        (io.out)(&format!(
            "Found no source folder ({src}) and no tests ({}) here, so there is nothing to watch yet. Run `vibloom init` at the root of the project, where its foundry.toml or other project file is (remove {MAP_PATH} here first).",
            start.tests
        ));
    }
    // The commit check comes with the map when the project is the
    // repository itself. A folder inside a larger repository does not
    // take over that repository's hooks unasked.
    let prefix = git(&io.cwd, &["rev-parse", "--show-prefix"]);
    match prefix.as_deref().map(str::trim) {
        Ok("") => match install_hook(&io.cwd) {
            Ok(done) => (io.out)(&done),
            Err(why) => (io.out)(&format!("Commit check not installed: {why}")),
        },
        Ok(_) => (io.out)(
            "This folder is inside a larger repository: `vibloom install-hook` adds the commit check to it when you want it.",
        ),
        Err(_) => (io.out)("Not a git repository yet: run `vibloom install-hook` once it is."),
    }
    let root = io.cwd.clone();
    let vs = crate::store::views(&root)?;
    for line in crate::commands::guide::next(
        &root,
        &found.map,
        &vs,
        crate::store::load_log(&root).entries.len(),
    ) {
        (io.out)(&line);
    }
    Ok(0)
}

pub(crate) fn rescan(root: &Path, io: &mut Io, tighten: bool) -> Fallible<i32> {
    verifier(io, "changes the map")?;
    let map = load_map(root)?;
    let src = project_plan(root, None).src;
    let mut found = scan(
        root,
        &map,
        src.as_deref(),
        forge_list(root, &map).as_ref(),
        tighten,
    );
    let write = !found.added.is_empty()
        || !found.guarded.is_empty()
        || (tighten && !found.tightened.is_empty());
    if write {
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
    (io.out)(found.graph);
    if !found.tightened.is_empty() {
        let lines: Vec<String> = found
            .tightened
            .drain(..)
            .map(|(id, from, to)| format!("- {id}: {} -> {}", from.join(", "), to.join(", ")))
            .collect();
        (io.out)(&if tighten {
            format!("Tightened what these watch:\n{}", lines.join("\n"))
        } else {
            format!(
                "Would tighten what these watch, to the files their tests import:\n{}\nRun `vibloom scan --tighten` to do it.",
                lines.join("\n")
            )
        });
    }
    Ok(0)
}

pub(crate) struct Scanned {
    map: RootsMap,
    added: Vec<String>,
    /// Handlers and base contracts now guarded with the tests that use them.
    guarded: Vec<String>,
    /// Existing nodes whose watch narrows to their import closure: id, from, to.
    tightened: Vec<(String, Vec<String>, Vec<String>)>,
    /// Which import graph was read, said to the person.
    graph: &'static str,
}

const FROM_TREES: &str = "Imports read from forge's syntax trees (remappings included): each invariant watches the files its test imports.";
const FROM_TEXT: &str = "Imports read from the source text (relative imports only; forge's syntax trees were not available): each invariant watches the source and test folders.";

// `listed` is forge's list of tests, when it answered. Existing nodes are
// narrowed to their import closure only when `tighten` says so; the result
// says what would change either way.
pub(crate) fn scan(
    root: &Path,
    map: &RootsMap,
    src: Option<&str>,
    listed: Option<&Value>,
    tighten: bool,
) -> Scanned {
    let found = listed.and_then(forge_invariants).unwrap_or_else(|| {
        let mut files = Vec::new();
        walk(root, map.tests.trim_end_matches('/'), &mut files);
        files
            .iter()
            .filter(|f| f.ends_with(".t.sol"))
            .flat_map(|f| find_invariants(f, &fs::read_to_string(root.join(f)).unwrap_or_default()))
            .collect()
    });
    let mut test_files: Vec<String> = found.iter().map(|f| f.file.clone()).collect();
    test_files.extend(
        map.nodes
            .iter()
            .filter_map(|n| n.test.as_ref().map(|t| t.file.clone())),
    );
    test_files.retain(|f| f.ends_with(".sol"));
    test_files.sort();
    test_files.dedup();
    let closures: Option<BTreeMap<String, Closure>> = import_closures(root, map, &test_files);
    // Without the trees, a change to the sources or to any test file puts a
    // found invariant up for review: its handler lives among the tests.
    let mut broad: Vec<String> = src.map(str::to_string).into_iter().collect();
    if !broad.contains(&map.tests) {
        broad.push(map.tests.clone());
    }
    let watch = |f: &Found| match closures.as_ref().and_then(|c| c.get(&f.file)) {
        Some(c) => c.watch.clone(),
        None => broad.clone(),
    };
    let (mut out, added) = add_found(map, &found, &watch);
    let mut tightened = Vec::new();
    for n in out.nodes.iter_mut().filter(|n| !added.contains(&n.id)) {
        let Some(c) = n
            .test
            .as_ref()
            .and_then(|t| closures.as_ref().and_then(|cs| cs.get(&t.file)))
        else {
            continue;
        };
        // Only a watch that holds whole folders is narrowed; files someone
        // listed by hand stay.
        if !n.watch.iter().any(|w| w.ends_with('/')) {
            continue;
        }
        let mut to: Vec<String> = c.watch.clone();
        to.extend(n.watch.iter().filter(|w| !w.ends_with('/')).cloned());
        to.sort();
        to.dedup();
        if to != n.watch {
            tightened.push((n.id.clone(), n.watch.clone(), to.clone()));
            if tighten {
                n.watch = to;
            }
        }
    }
    let tests: Vec<String> = out
        .nodes
        .iter()
        .filter(|n| n.protected)
        .filter_map(|n| n.test.as_ref().map(|t| t.file.clone()))
        .collect();
    let read = |f: &str| fs::read_to_string(root.join(f)).ok();
    let mut helper_files = helpers(&tests, &map.tests, &read);
    for t in &tests {
        if let Some(c) = closures.as_ref().and_then(|cs| cs.get(t)) {
            helper_files.extend(c.helpers.iter().cloned());
        }
    }
    let has = |f: &str| root.join(f).is_file();
    helper_files.extend(crate::setup::check_configs(&map.checks, &has));
    helper_files.extend(crate::setup::runner_configs(&map.runner, &has));
    helper_files.sort();
    helper_files.dedup();
    let mut guarded = Vec::new();
    for h in helper_files {
        if !crate::hooks::is_guarded(&out, &h) {
            out.protect.push(h.clone());
            guarded.push(h);
        }
    }
    Scanned {
        map: out,
        added,
        guarded,
        tightened,
        graph: if closures.is_some() {
            FROM_TREES
        } else {
            FROM_TEXT
        },
    }
}
