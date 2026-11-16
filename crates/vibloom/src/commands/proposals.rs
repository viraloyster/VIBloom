use crate::cli::{Args, Fallible, Io};
use crate::commands::nodes::known_ids;
use crate::commands::verifier;
use crate::map::{MAP_PATH, PROPOSALS_PATH, serialize_map};
use crate::proposals::{Decision, Proposal, accept};
use crate::store::{append, iso_now, load_book, load_map, locked, write_atomic};
use crate::suggest::unknown;
use std::collections::BTreeMap;
use std::path::Path;

const USAGE: &str = "Usage: vibloom proposals [<id> | --full] [--contract C]\n       vibloom proposals accept <id>... | --all [--contract C] [--on ID]...\n       vibloom proposals reject <id>... | --all [--contract C]";

/// The contract a survey proposal is about: the `Contract:` its title starts
/// with. Anything else is grouped apart.
fn contract_of(p: &Proposal) -> Option<&str> {
    let (head, _) = p.title.split_once(": ")?;
    (!head.is_empty() && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .then_some(head)
}

fn short_title(p: &Proposal) -> &str {
    match contract_of(p) {
        Some(c) => &p.title[c.len() + 2..],
        None => &p.title,
    }
}

// What a listing shows, so `--all` decides exactly that.
fn shown<'a>(pending: Vec<&'a Proposal>, contract: Option<&str>) -> Fallible<Vec<&'a Proposal>> {
    let Some(c) = contract else {
        return Ok(pending);
    };
    let mut names: Vec<&str> = pending.iter().filter_map(|p| contract_of(p)).collect();
    names.sort_unstable();
    names.dedup();
    if !names.contains(&c) {
        return Err(unknown("pending proposals about", c, names));
    }
    Ok(pending
        .into_iter()
        .filter(|p| contract_of(p) == Some(c))
        .collect())
}

fn full(p: &Proposal) -> Vec<String> {
    let mut out = vec![format!("{}  {}  {}", p.id, p.kind, p.title)];
    if !p.depends_on.is_empty() {
        out.push(format!("    rests on: {}", p.depends_on.join(", ")));
    }
    if let Some(by) = &p.by {
        out.push(format!("    by: {by}"));
    }
    if let Some(d) = &p.detail {
        // Indented on every line, so a detail cannot pass for a proposal.
        out.push(format!(
            "    {}",
            d.lines().collect::<Vec<_>>().join("\n    ")
        ));
    }
    if let Some(t) = &p.test {
        out.push(format!("    test: {} {}", t.file, t.name));
    }
    if !p.evidence.is_empty() {
        out.push(format!("    from: {}", p.evidence.join("; ")));
    }
    out
}

fn list(ps: &[&Proposal], with_evidence: bool) -> Vec<String> {
    let mut groups: BTreeMap<(bool, &str), BTreeMap<&str, Vec<&Proposal>>> = BTreeMap::new();
    for p in ps {
        let c = contract_of(p);
        groups
            .entry((c.is_none(), c.unwrap_or("Not about one contract")))
            .or_default()
            .entry(p.kind.as_str())
            .or_default()
            .push(p);
    }
    let w = ps.iter().map(|p| p.id.len()).max().unwrap_or(0);
    let mut out = vec![];
    for ((_, name), kinds) in groups {
        let n: usize = kinds.values().map(Vec::len).sum();
        out.push(String::new());
        out.push(format!("{name} ({n})"));
        for (kind, items) in kinds {
            out.push(format!("  {kind}"));
            for p in items {
                if with_evidence {
                    out.extend(full(p).into_iter().map(|l| format!("    {l}")));
                } else {
                    out.push(format!("    {:w$}  {}", p.id, short_title(p)));
                }
            }
        }
    }
    out
}

pub(crate) fn proposals(root: &Path, args: &Args, io: &mut Io) -> Fallible<i32> {
    let words = &args.words;
    let all = args.set.contains(&"--all");
    let contract = args.opt("--contract");
    let on = args.all("--on");
    match words.first().copied() {
        None | Some("list") if words.len() <= 1 && !all && on.is_empty() => {
            let book = load_book(root);
            let ps = shown(book.pending(), contract)?;
            if ps.is_empty() {
                (io.out)("No pending proposals.");
                return Ok(0);
            }
            let filed_by: usize = ps
                .iter()
                .filter(|p| p.by.as_deref() == Some("vibloom survey"))
                .count();
            (io.out)(&format!(
                "{} pending {}{}. Nothing in them counts until you accept it.",
                ps.len(),
                if ps.len() == 1 {
                    "proposal"
                } else {
                    "proposals"
                },
                if filed_by > 0 {
                    format!(" ({filed_by} filed by `vibloom survey`)")
                } else {
                    String::new()
                }
            ));
            for l in list(&ps, args.set.contains(&"--full")) {
                (io.out)(&l);
            }
            let scope = contract
                .map(|c| format!(" --contract {c}"))
                .unwrap_or_default();
            (io.out)(&format!(
                "\n`vibloom proposals <id>` shows one with where it comes from{}.\nDecide: `vibloom proposals accept <id>...` or `reject <id>...`; `accept --all{scope}` takes everything listed.",
                if args.set.contains(&"--full") {
                    ""
                } else {
                    " (`--full` shows all)"
                }
            ));
            Ok(0)
        }
        Some(action @ ("accept" | "reject")) => {
            // Deciding changes the map: the same role that may edit it by hand.
            verifier(io, "decides what enters the map")?;
            if action == "reject" && !on.is_empty() {
                return Err(format!("--on goes with accept.\n{USAGE}"));
            }
            let book = load_book(root);
            let pending = book.pending();
            let mut ids: Vec<String> = Vec::new();
            if all {
                if words.len() > 1 {
                    return Err(format!("Give ids or --all, not both.\n{USAGE}"));
                }
                ids.extend(shown(pending, contract)?.iter().map(|p| p.id.clone()));
                if ids.is_empty() {
                    (io.out)("No pending proposals.");
                    return Ok(0);
                }
            } else {
                if words.len() < 2 {
                    return Err(USAGE.into());
                }
                if contract.is_some() {
                    return Err(format!("--contract goes with --all.\n{USAGE}"));
                }
                // Named twice, a proposal is still decided once.
                for id in &words[1..] {
                    if !pending.iter().any(|p| p.id == *id) {
                        return Err(unknown(
                            "pending proposal",
                            id,
                            pending.iter().map(|p| p.id.as_str()),
                        ));
                    }
                    if !ids.iter().any(|x| x == id) {
                        ids.push((*id).to_string());
                    }
                }
            }
            known_ids(&load_map(root)?, &on)?;
            decide(root, io, action, &ids, &on)
        }
        Some(id) if words.len() == 1 => {
            let book = load_book(root);
            let pending = book.pending();
            let Some(p) = pending.iter().find(|p| p.id == id) else {
                return Err(unknown(
                    "pending proposal",
                    id,
                    pending.iter().map(|p| p.id.as_str()),
                ));
            };
            for l in full(p) {
                (io.out)(&l);
            }
            Ok(0)
        }
        _ => Err(USAGE.into()),
    }
}

fn decide(root: &Path, io: &mut Io, action: &str, ids: &[String], on: &[String]) -> Fallible<i32> {
    let quiet = ids.len() > 10;
    let mut created: Vec<(String, String)> = vec![];
    locked(root, || {
        for id in ids {
            let book = load_book(root);
            let Some(p) = book.pending().into_iter().find(|p| p.id == *id).cloned() else {
                return Err(format!("No pending proposal {id}."));
            };
            let mut node = None;
            let mut stance = String::new();
            if action == "accept" {
                // What the person links it to counts with what the
                // proposal itself rests on.
                let mut p = p.clone();
                for d in on {
                    if !p.depends_on.contains(d) {
                        p.depends_on.push(d.clone());
                    }
                }
                let (map, new_id) = accept(&load_map(root)?, &p)
                    .map_err(|e| format!("{id} cannot be accepted:\n- {}", e.join("\n- ")))?;
                write_atomic(&root.join(MAP_PATH), &serialize_map(&map))?;
                stance = map
                    .nodes
                    .iter()
                    .find(|n| n.id == new_id)
                    .map_or("", |n| n.stance.as_str())
                    .to_string();
                created.push((new_id.clone(), stance.clone()));
                node = Some(new_id);
            }
            let d = Decision {
                decide: p.id.clone(),
                decision: action.into(),
                at: iso_now(),
                node: node.clone(),
            };
            append(
                &root.join(PROPOSALS_PATH),
                &format!("{}\n", serde_json::to_string(&d).unwrap_or_default()),
            )?;
            if quiet {
                continue;
            }
            (io.out)(&match node {
                Some(n) => match p.node_id.as_deref().filter(|asked| *asked != n) {
                    Some(asked) => {
                        format!("Accepted {id} as {n} ({stance}; {asked} is already in use).")
                    }
                    None => format!("Accepted {id} as {n} ({stance})."),
                },
                None => format!("Rejected {id}."),
            });
        }
        Ok(())
    })?;
    if action == "reject" {
        if quiet {
            (io.out)(&format!("Rejected {} proposals.", ids.len()));
        }
        return Ok(0);
    }
    let hypothetical = created.iter().filter(|(_, s)| s == "hypothetical").count();
    let n = created.len();
    let mut line = format!(
        "Created {n} {} in the map",
        if n == 1 { "node" } else { "nodes" }
    );
    if hypothetical > 0 {
        line.push_str(&format!(
            "; {hypothetical} {} hypothetical (not yet reviewed) until you adopt {} with `vibloom edit <id> --stance adopted` or switch {} off",
            if hypothetical == 1 { "starts" } else { "start" },
            if hypothetical == 1 { "it" } else { "each" },
            if hypothetical == 1 { "it" } else { "them" },
        ));
    }
    line.push('.');
    (io.out)(&line);
    if quiet {
        (io.out)("`vibloom status` lists them.");
    }
    if let Some(l) = crate::commands::nodes::rests_on("each", on) {
        (io.out)(&l.replacen("each rests on", "Each rests on", 1));
    }
    Ok(0)
}
