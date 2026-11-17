//! What an agent reads before touching code. Detail is spent where it helps:
//! everything about the nodes that name the file at hand, one line for the
//! nodes connected to them, the reason for anything in trouble elsewhere, and
//! a count of the rest. On a large map that is a small part of it.

use crate::derive::{NodeView, label, shown, summary_line, troubled};
use crate::map::covers;
use std::collections::{BTreeMap, HashMap, HashSet};

fn line(v: &NodeView) -> String {
    format!("- {} [{}] {}", v.id, shown(v), v.title)
}

// A troubled node away from the file at hand: its line and the reason.
fn why(v: &NodeView) -> String {
    let mut out = vec![line(v)];
    if let Some(r) = &v.reason {
        out.push(format!("  why: {r}"));
    }
    if !v.because.is_empty() {
        out.push(format!("  because of: {}", v.because.join(", ")));
    }
    if !v.changed.is_empty() {
        out.push(format!("  changed: {}", v.changed.join(", ")));
    }
    out.join("\n")
}

// What a node watches, without files a watched folder already covers.
fn watched(v: &NodeView) -> Vec<&str> {
    v.watch
        .iter()
        .filter(|w| {
            !v.watch
                .iter()
                .any(|d| d.ends_with('/') && *w != d && covers(d, w))
        })
        .map(String::as_str)
        .collect()
}

// Past this many, a watch list is the file at hand and a count: an import
// closure repeats the same dozens of files under every node.
const WATCH_IN_FULL: usize = 4;

fn watch_line(v: &NodeView, path: &str) -> Option<String> {
    let watch = watched(v);
    if watch.is_empty() {
        return None;
    }
    if watch.len() <= WATCH_IN_FULL {
        return Some(format!("  watches: {}", watch.join(", ")));
    }
    let what = if v.test_file.is_some() {
        "files its test imports"
    } else {
        "files"
    };
    Some(if watch.contains(&path) {
        format!("  watches: {path}, and {} other {what}", watch.len() - 1)
    } else {
        format!("  watches: {} {what}", watch.len())
    })
}

// Nodes of one group that watch the same long list, said once after it.
fn same_watch(vs: &[&NodeView]) -> Vec<String> {
    let mut sets: Vec<(Vec<&str>, Vec<&str>)> = Vec::new();
    for v in vs {
        let mut w = watched(v);
        if w.len() <= WATCH_IN_FULL {
            continue;
        }
        w.sort_unstable();
        match sets.iter_mut().find(|(s, _)| *s == w) {
            Some((_, ids)) => ids.push(&v.id),
            None => sets.push((w, vec![&v.id])),
        }
    }
    let mut out: Vec<String> = sets
        .iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(w, ids)| {
            if ids.len() == vs.len() {
                format!("All {} above watch the same {} files.", ids.len(), w.len())
            } else {
                format!("{} watch the same {} files.", ids.join(", "), w.len())
            }
        })
        .collect();
    if !sets.is_empty() {
        out.push("`vibloom status --json` lists every file each one watches.".into());
    }
    out
}

fn full(v: &NodeView, by_id: &HashMap<&str, &NodeView>, path: &str) -> String {
    let mut out = vec![line(v)];
    if let Some(d) = &v.detail {
        out.push(format!("  {d}"));
    }
    if let Some(t) = &v.test_file {
        out.push(format!(
            "  test: {t}{}",
            if v.protected { " (protected)" } else { "" }
        ));
    }
    out.extend(watch_line(v, path));
    if !v.sources.is_empty() {
        out.push(format!("  from: {}", v.sources.join("; ")));
    }
    if !v.depends_on.is_empty() {
        let deps: Vec<String> = v
            .depends_on
            .iter()
            .map(|d| format!("{d} [{}]", by_id.get(d.as_str()).map_or("?", |x| label(x))))
            .collect();
        out.push(format!("  rests on: {}", deps.join(", ")));
    }
    for a in &v.accepts {
        out.push(if a.in_effect {
            format!("  accepts {} being off: {}", a.id, a.reason)
        } else {
            format!(
                "  accepted {} being off, but it is on again: the acceptance can be removed",
                a.id
            )
        });
    }
    if !v.because.is_empty() {
        out.push(format!("  because of: {}", v.because.join(", ")));
    }
    if !v.changed.is_empty() {
        let run = v.run.map_or_else(|| "?".to_string(), |r| r.to_string());
        out.push(format!(
            "  changed since run {run}: {}",
            v.changed.join(", ")
        ));
    }
    if let Some(f) = &v.fuzz {
        out.push(format!(
            "  fuzzed: {} runs, {} calls, {} reverted",
            f.runs, f.calls, f.reverts
        ));
        if !f.dead.is_empty() {
            out.push(format!(
                "  never got a call through (every call reverted): {}",
                f.dead.join(", ")
            ));
        }
    }
    if let Some(r) = &v.reason {
        out.push(format!("  why: {r}"));
    }
    out.join("\n")
}

// A node is about a file when it names it: as something it watches, as its
// test, or in where it comes from ("src/Vault.sol:120").
fn names(v: &NodeView, path: &str) -> bool {
    v.watch.iter().any(|w| w == path)
        || v.test_file.as_deref() == Some(path)
        || v.sources.iter().any(|s| s.contains(path))
}

pub fn context(views: &[NodeView], path: Option<&str>) -> String {
    let by_id: HashMap<&str, &NodeView> = views.iter().map(|v| (v.id.as_str(), v)).collect();
    let mut about: HashSet<&str> = HashSet::new();
    let mut connected: HashSet<&str> = HashSet::new();
    if let Some(p) = path {
        for v in views {
            if names(v, p) {
                about.insert(&v.id);
            } else if v.watch.iter().any(|w| covers(w, p)) {
                // It only watches the folder the file is in.
                connected.insert(&v.id);
            }
        }
        // What those rest on, however deep, and what rests on them.
        let mut queue: Vec<&str> = about.iter().chain(&connected).copied().collect();
        while let Some(id) = queue.pop() {
            for d in by_id
                .get(id)
                .map(|v| v.depends_on.as_slice())
                .unwrap_or_default()
            {
                if !about.contains(d.as_str()) && connected.insert(d) {
                    queue.push(d);
                }
            }
        }
        let above: Vec<&str> = views
            .iter()
            .filter(|v| {
                v.depends_on
                    .iter()
                    .any(|d| about.contains(d.as_str()) || connected.contains(d.as_str()))
            })
            .map(|v| v.id.as_str())
            .filter(|id| !about.contains(id))
            .collect();
        connected.extend(above);
    }
    let mut out = vec![
        "VIBloom roots. States are derived from test runs; an agent cannot set them.".to_string(),
        summary_line(views, false),
    ];
    // Within a group, what needs attention comes first.
    let pick = |set: &HashSet<&str>| -> Vec<&NodeView> {
        let mut vs: Vec<&NodeView> = views
            .iter()
            .filter(|v| set.contains(v.id.as_str()))
            .collect();
        vs.sort_by_key(|v| !troubled(v));
        vs
    };
    if let Some(p) = path {
        out.push(String::new());
        if about.is_empty() && connected.is_empty() {
            out.push(format!("Nothing in the map watches {p}."));
        } else {
            if !about.is_empty() {
                out.push(format!("About {p}:"));
                let vs = pick(&about);
                out.extend(vs.iter().map(|v| full(v, &by_id, p)));
                out.extend(same_watch(&vs));
            }
            if !connected.is_empty() {
                out.push(format!(
                    "{} its folder, or connected to the above:",
                    if about.is_empty() {
                        "Watching"
                    } else {
                        "Also watching"
                    }
                ));
                out.extend(
                    pick(&connected).into_iter().map(
                        |v| {
                            if troubled(v) { why(v) } else { line(v) }
                        },
                    ),
                );
            }
            // No run stands behind these, so a change to the file never moves
            // their state: only a person reading them again can.
            let by_hand: Vec<&str> = views
                .iter()
                .filter(|v| v.test_file.is_none() && v.watch.iter().any(|w| covers(w, p)))
                .map(|v| v.id.as_str())
                .collect();
            if !by_hand.is_empty() {
                out.push(format!(
                    "Watching {p} with no test to check {}: {}. A change here never changes {} state; a person should re-read {} after one.",
                    if by_hand.len() == 1 { "it" } else { "them" },
                    by_hand.join(", "),
                    if by_hand.len() == 1 { "its" } else { "their" },
                    if by_hand.len() == 1 { "it" } else { "them" },
                ));
            }
        }
    }
    let listed = |v: &NodeView| about.contains(v.id.as_str()) || connected.contains(v.id.as_str());
    let elsewhere: Vec<&NodeView> = views.iter().filter(|v| !listed(v)).collect();
    let bad: Vec<&&NodeView> = elsewhere.iter().filter(|v| troubled(v)).collect();
    if !bad.is_empty() {
        out.push(String::new());
        out.push(
            if path.is_some() {
                "Needs attention elsewhere:"
            } else {
                "Needs attention:"
            }
            .into(),
        );
        out.extend(bad.iter().map(|v| why(v)));
    }
    // The rest is only counted: `vibloom status` lists it when it is wanted.
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for v in elsewhere.iter().filter(|v| !troubled(v)) {
        *counts.entry(shown(v)).or_default() += 1;
    }
    if !counts.is_empty() {
        let parts: Vec<String> = counts.iter().map(|(l, n)| format!("{n} {l}")).collect();
        out.push(String::new());
        out.push(format!(
            "{}: {} (`vibloom status` lists them).",
            if path.is_some() || !bad.is_empty() {
                "The rest"
            } else {
                "All sound"
            },
            parts.join(", ")
        ));
    }
    out.push(String::new());
    out.push(
        "Rules: fix the code, not the test; never edit protected tests, their handlers or .vibloom/."
            .into(),
    );
    out.push("The task is not done while `vibloom status` exits 1.".into());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::{Evidence, Support};
    use crate::map::{Kind, Stance};

    fn node(id: &str, kind: Kind, evidence: Evidence) -> NodeView {
        NodeView {
            id: id.into(),
            kind,
            title: format!("title of {id}"),
            detail: Some(format!("detail of {id}")),
            stance: Stance::Adopted,
            protected: kind == Kind::Invariant,
            evidence,
            support: Support::Ok,
            because: vec![],
            changed: vec![],
            reason: None,
            run: None,
            fuzz: None,
            how: None,
            depends_on: vec![],
            watch: vec![],
            test_file: None,
            sources: vec![],
            accepts: vec![],
            unreviewed: vec![],
        }
    }

    fn map() -> Vec<NodeView> {
        // About the vault by evidence; watches the whole folder.
        let mut cap = node("inv.cap", Kind::Invariant, Evidence::Holds);
        cap.watch = vec!["src/".into(), "test/Vault.t.sol".into()];
        cap.test_file = Some("test/Vault.t.sol".into());
        cap.sources = vec!["src/Vault.sol:120".into()];
        cap.depends_on = vec!["asm.oracle".into()];
        // Only watches the folder the vault is in.
        let mut supply = node("inv.supply", Kind::Invariant, Evidence::Holds);
        supply.watch = vec!["src/".into()];
        let oracle = node("asm.oracle", Kind::Assumption, Evidence::None);
        let mut promise = node("int.promise", Kind::Intention, Evidence::None);
        promise.depends_on = vec!["inv.cap".into()];
        // Nothing to do with the vault: one broken, two fine.
        let mut broken = node("inv.other", Kind::Invariant, Evidence::Broken);
        broken.reason = Some("drift".into());
        let far = node("asm.far", Kind::Assumption, Evidence::None);
        let far2 = node("asm.far2", Kind::Assumption, Evidence::None);
        vec![cap, supply, oracle, promise, broken, far, far2]
    }

    #[test]
    fn spends_detail_on_what_names_the_file_and_counts_the_rest() {
        let text = context(&map(), Some("src/Vault.sol"));
        let about = text.find("About src/Vault.sol:").expect("about");
        let also = text.find("Also watching its folder").expect("also");
        let elsewhere = text.find("Needs attention elsewhere:").expect("elsewhere");
        let rest = text.find("The rest: 2 adopted").expect("rest");
        assert!(
            about < also && also < elsewhere && elsewhere < rest,
            "{text}"
        );
        // Full detail only for the node that names the file.
        assert!(text[about..also].contains("detail of inv.cap"));
        assert!(text[about..also].contains("rests on: asm.oracle [adopted]"));
        // One line each for the folder watcher, what it rests on and what rests on it.
        let middle = &text[also..elsewhere];
        for id in ["inv.supply", "asm.oracle", "int.promise"] {
            assert!(middle.contains(&format!("- {id} [")), "{id} in {middle}");
        }
        assert!(!middle.contains("detail of"));
        // Trouble elsewhere says why; the rest is a count, not a list.
        assert!(text[elsewhere..rest].contains("- inv.other [BROKEN]"));
        assert!(text[elsewhere..rest].contains("why: drift"));
        assert!(!text.contains("asm.far"));
    }

    #[test]
    fn a_long_watch_list_is_the_file_and_a_count_and_shared_ones_are_said_once() {
        let closure: Vec<String> = [
            "src/Vault.sol",
            "src/A.sol",
            "src/B.sol",
            "src/C.sol",
            "test/H.sol",
        ]
        .iter()
        .map(|f| (*f).to_string())
        .collect();
        let inv = |id: &str, watch: &[String]| {
            let mut v = node(id, Kind::Invariant, Evidence::Holds);
            v.watch = watch.to_vec();
            v.test_file = Some("test/Vault.t.sol".into());
            v
        };
        let mut wider = closure.clone();
        wider.push("src/D.sol".into());
        let short = vec!["src/Vault.sol".to_string(), "src/A.sol".to_string()];
        let mut vs = vec![inv("inv.a", &closure), inv("inv.b", &closure)];
        let text = context(&vs, Some("src/Vault.sol"));
        assert!(
            text.contains("  watches: src/Vault.sol, and 4 other files its test imports\n"),
            "{text}"
        );
        assert!(!text.contains("src/B.sol"), "{text}");
        assert!(
            text.contains("All 2 above watch the same 5 files.\n`vibloom status --json` lists every file each one watches."),
            "{text}"
        );
        vs.push(inv("inv.c", &wider));
        vs.push(inv("inv.d", &short));
        let text = context(&vs, Some("src/Vault.sol"));
        assert!(
            text.contains("inv.a, inv.b watch the same 5 files."),
            "{text}"
        );
        assert!(
            text.contains("and 5 other files its test imports"),
            "{text}"
        );
        assert!(
            text.contains("  watches: src/Vault.sol, src/A.sol\n"),
            "{text}"
        );
        assert!(!text.contains("All "), "{text}");
    }

    #[test]
    fn the_overview_is_what_is_wrong_and_a_count() {
        let text = context(&map(), None);
        assert!(text.contains("7 nodes, 1 needs attention, 0 not yet reviewed."));
        assert!(text.contains("Needs attention:\n- inv.other [BROKEN]"));
        assert!(text.contains("The rest: 4 adopted, 2 holds"));
        assert!(!text.contains("inv.supply"));
        let sound: Vec<NodeView> = map().into_iter().filter(|v| v.id != "inv.other").collect();
        assert!(context(&sound, None).contains("All sound: 4 adopted, 2 holds"));
        assert!(
            context(&sound, Some("README.md")).contains("Nothing in the map watches README.md.")
        );
    }

    #[test]
    fn names_watchers_no_test_checks_and_shows_accepted_risks() {
        use crate::derive::AcceptedRisk;
        let mut vs = map();
        vs[2].watch = vec!["src/Vault.sol".into()];
        vs[3].accepts = vec![AcceptedRisk {
            id: "asm.far".into(),
            reason: "the cap bounds the loss".into(),
            in_effect: true,
        }];
        vs[3].sources = vec!["src/Vault.sol:9".into()];
        let text = context(&vs, Some("src/Vault.sol"));
        assert!(
            text.contains("Watching src/Vault.sol with no test to check them: inv.supply, asm.oracle. A change here never changes their state; a person should re-read them after one."),
            "{text}"
        );
        assert!(
            text.contains("- int.promise [adopted (accepts 1 risk)] title of int.promise"),
            "{text}"
        );
        assert!(
            text.contains("  accepts asm.far being off: the cap bounds the loss"),
            "{text}"
        );
    }
}
