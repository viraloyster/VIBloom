use crate::cli::{Args, Fallible, Io};
use crate::commands::verifier;
use crate::foundry::project_plan;
use crate::map::{
    Accept, Kind, MAP_PATH, RootNode, Stance, TestRef, parse_map, serialize_map, test_name,
};
use crate::paths::{relative_to, watch_path};
use crate::proposals::{fresh_id, with_node};
use crate::store::{load_map, write_atomic};
use serde_json::Value;
use std::path::Path;

pub(crate) fn add(root: &Path, io: &mut Io, args: &Args) -> Fallible<i32> {
    verifier(io.role, "changes the map")?;
    let usage = "Usage: vibloom add <assumption|invariant|intention> \"<title>\" [--file F --test N [--contract C]] [--watch P]... [--on ID]... [--detail D] [--id ID] [--hypothetical | --adopted] [--unprotected]";
    let (Some(kind), Some(title), None) = (
        args.words.first().and_then(|k| Kind::parse(k)),
        args.words.get(1),
        args.words.get(2),
    ) else {
        return Err(usage.into());
    };
    let map = load_map(root)?;
    let test = match (args.opt("--file"), args.opt("--test")) {
        (Some(f), Some(n)) => Some(TestRef {
            file: relative_to(root, &io.cwd, f)
                .ok_or_else(|| format!("{f} is outside the project."))?,
            contract: args.opt("--contract").map(str::to_string),
            name: test_name(n),
        }),
        (None, None) => None,
        _ => return Err(format!("A test needs both --file and --test.\n{usage}")),
    };
    let mut watch = Vec::new();
    for w in args.all("--watch") {
        watch.push(watch_path(root, &io.cwd, &w)?);
    }
    // A tested node with nothing to watch would never go stale: it
    // watches the sources and the tests unless told otherwise.
    if watch.is_empty() && test.is_some() {
        watch.extend(project_plan(root, None).src);
        if !watch.contains(&map.tests) {
            watch.push(map.tests.clone());
        }
    }
    let id = args
        .opt("--id")
        .map_or_else(|| fresh_id(&map, kind, title), str::to_string);
    let node = RootNode {
        id: id.clone(),
        kind,
        title: (*title).to_string(),
        detail: args.opt("--detail").map(str::to_string),
        stance: stance_for(
            kind,
            args.set.contains(&"--hypothetical"),
            args.set.contains(&"--adopted"),
        )?,
        test,
        watch,
        depends_on: args.all("--on"),
        protected: kind == Kind::Invariant && !args.set.contains(&"--unprotected"),
        evidence: args.all("--evidence"),
        accepts: vec![],
    };
    let next = with_node(&map, node)
        .map_err(|e| format!("The node cannot be added:\n- {}", e.join("\n- ")))?;
    write_atomic(&root.join(MAP_PATH), &serialize_map(&next))?;
    let stance = next
        .nodes
        .iter()
        .find(|n| n.id == id)
        .map_or("", |n| n.stance.as_str());
    (io.out)(&format!("Added {id} ({stance})."));
    Ok(0)
}

pub(crate) fn edit(root: &Path, io: &mut Io, args: &Args) -> Fallible<i32> {
    verifier(io.role, "changes the map")?;
    let usage = "Usage: vibloom edit <id> [--title T] [--detail D] [--stance adopted|hypothetical|off] [--on ID] [--not-on ID] [--watch P] [--unwatch P] [--evidence E] [--drop-evidence E] [--accept ID --reason R] [--unaccept ID]";
    let (Some(id), None) = (args.words.first(), args.words.get(1)) else {
        return Err(usage.into());
    };
    let mut map = load_map(root)?;
    let accept = match (args.all("--accept").as_slice(), args.opt("--reason")) {
        ([], None) => None,
        ([dep], Some(reason)) => {
            // An acceptance covers a dependency switched off on
            // purpose; for one that is on it would mean nothing.
            let off = map
                .nodes
                .iter()
                .find(|n| n.id == *dep)
                .map(|n| n.stance == Stance::Off);
            match off {
                Some(true) => {}
                Some(false) => {
                    return Err(format!(
                        "{dep} is not off. Only a dependency switched off (`vibloom edit {dep} --stance off`) can be accepted as a risk."
                    ));
                }
                None => return Err(format!("No node {dep} in the map.")),
            }
            Some(Accept {
                id: dep.clone(),
                reason: reason.to_string(),
            })
        }
        ([_], None) => {
            return Err("--accept needs --reason \"why this risk is acceptable\".".into());
        }
        ([], Some(_)) => return Err("--reason goes with --accept <id>.".into()),
        _ => {
            return Err("Accept one dependency at a time: --accept <id> --reason \"...\".".into());
        }
    };
    let Some(n) = map.nodes.iter_mut().find(|n| n.id == *id) else {
        return Err(format!("No node {id} in the map."));
    };
    if args.opts.is_empty() {
        return Err(format!("Nothing to change.\n{usage}"));
    }
    if let Some(t) = args.opt("--title") {
        n.title = t.to_string();
    }
    if let Some(d) = args.opt("--detail") {
        n.detail = (!d.is_empty()).then(|| d.to_string());
    }
    if let Some(st) = args.opt("--stance") {
        n.stance = Stance::parse(st).ok_or("stance must be one of adopted, hypothetical, off")?;
    }
    // Lists are added to and taken from, so linking one more node
    // never needs the others repeated.
    let change = |list: &mut Vec<String>, add: &str, drop: &str| {
        for x in args.all(add) {
            if !list.contains(&x) {
                list.push(x);
            }
        }
        let gone = args.all(drop);
        list.retain(|x| !gone.contains(x));
    };
    // Paths are written as the map writes them, so `--watch ./src`
    // and `--unwatch src/` name the same folder.
    let mut watch_args = Vec::new();
    for (k, v) in &args.opts {
        if *k == "--watch" || *k == "--unwatch" {
            watch_args.push((*k, watch_path(root, &io.cwd, v)?));
        }
    }
    for (k, w) in &watch_args {
        if *k == "--watch" && !n.watch.contains(w) {
            n.watch.push(w.clone());
        }
    }
    n.watch.retain(|x| {
        !watch_args.iter().any(|(k, w)| {
            *k == "--unwatch" && (w == x || w.trim_end_matches('/') == x.trim_end_matches('/'))
        })
    });
    change(&mut n.depends_on, "--on", "--not-on");
    change(&mut n.evidence, "--evidence", "--drop-evidence");
    for dep in args.all("--unaccept") {
        if !n.accepts.iter().any(|a| a.id == dep) {
            return Err(format!("{id} accepts no risk from {dep}."));
        }
        n.accepts.retain(|a| a.id != dep);
    }
    if let Some(a) = accept {
        n.accepts.retain(|x| x.id != a.id);
        n.accepts.push(a);
    }
    let checked: Value = serde_json::from_str(&serialize_map(&map)).map_err(|e| e.to_string())?;
    let map = parse_map(&checked).map_err(|e| {
        format!(
            "That change does not give a valid map:\n- {}",
            e.join("\n- ")
        )
    })?;
    write_atomic(&root.join(MAP_PATH), &serialize_map(&map))?;
    (io.out)(&format!("Changed {id}."));
    Ok(0)
}

pub(crate) fn remove(root: &Path, io: &mut Io, args: &Args) -> Fallible<i32> {
    verifier(io.role, "changes the map")?;
    let (Some(id), None) = (args.words.first(), args.words.get(1)) else {
        return Err("Usage: vibloom remove <id>".into());
    };
    let mut map = load_map(root)?;
    if !map.nodes.iter().any(|n| n.id == *id) {
        return Err(format!("No node {id} in the map."));
    }
    let resting: Vec<&str> = map
        .nodes
        .iter()
        .filter(|n| n.depends_on.iter().any(|d| d == id))
        .map(|n| n.id.as_str())
        .collect();
    if !resting.is_empty() {
        return Err(format!(
            "{} rest on {id}. Remove them first, or point them elsewhere with `vibloom edit <id> --on ...`. To keep the node but stop counting it: `vibloom edit {id} --stance off`.",
            resting.join(", ")
        ));
    }
    map.nodes.retain(|n| n.id != *id);
    write_atomic(&root.join(MAP_PATH), &serialize_map(&map))?;
    (io.out)(&format!("Removed {id}. Its recorded runs stay in the log."));
    Ok(0)
}

// One rule for every node added by hand: an assumption is hypothetical until
// someone adopts it; invariants and intentions are adopted.
pub(crate) fn stance_for(kind: Kind, hypothetical: bool, adopted: bool) -> Fallible<Stance> {
    match (hypothetical, adopted) {
        (true, true) => Err("Give --hypothetical or --adopted, not both.".into()),
        (true, false) => Ok(Stance::Hypothetical),
        (false, true) => Ok(Stance::Adopted),
        (false, false) if kind == Kind::Assumption => Ok(Stance::Hypothetical),
        (false, false) => Ok(Stance::Adopted),
    }
}
