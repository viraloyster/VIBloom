//! Every state shown to a person or an agent is derived here, from the map, the
//! verified log and the files as they are now. Nothing else can set one.

use crate::forge::{Outcome, Status};
use crate::log::RunEntry;
use crate::map::{Kind, RootNode, RootsMap, Stance, covers, watched_by};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub type Files = BTreeMap<String, Option<String>>;

/// What the node's own test says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Evidence {
    Holds,
    Broken,
    Skipped,
    Untested,
    Stale,
    None,
}

/// What follows from the nodes it depends on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    Ok,
    Pending,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NodeView {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub stance: Stance,
    pub protected: bool,
    pub evidence: Evidence,
    pub support: Support,
    /// The dependencies that made support pending or unsupported.
    pub because: Vec<String>,
    /// Watched files that changed since the run the evidence comes from.
    pub changed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<u64>,
    pub depends_on: Vec<String>,
    pub watch: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_file: Option<String>,
}

fn matches(n: &RootNode, o: &Outcome) -> bool {
    n.test.as_ref().is_some_and(|t| {
        o.file == t.file && o.name == t.name && t.contract.as_ref().is_none_or(|c| &o.contract == c)
    })
}

// Files a node watches, as found in a hash table (the current tree or a run).
fn files_of(n: &RootNode, table: &Files) -> BTreeMap<String, Option<String>> {
    let mut out = BTreeMap::new();
    for w in watched_by(n) {
        if w.ends_with('/') {
            for (f, h) in table {
                if covers(&w, f) {
                    out.insert(f.clone(), h.clone());
                }
            }
        } else {
            out.insert(w.clone(), table.get(&w).cloned().flatten());
        }
    }
    out
}

fn changed_since(n: &RootNode, run: &RunEntry, current: &Files) -> Vec<String> {
    let then = files_of(n, &run.files);
    let now = files_of(n, current);
    let mut out = BTreeSet::new();
    for (f, h) in &now {
        // A file the run did not record is treated as changed: its state then is unknown.
        if !run.files.contains_key(f) || then.get(f) != Some(h) {
            out.insert(f.clone());
        }
    }
    for f in then.keys() {
        if !now.contains_key(f) {
            out.insert(f.clone());
        }
    }
    out.into_iter().collect()
}

struct Own {
    evidence: Evidence,
    changed: Vec<String>,
    reason: Option<String>,
    run: Option<u64>,
}

pub fn derive(map: &RootsMap, entries: &[RunEntry], current: &Files) -> Vec<NodeView> {
    let mut own: HashMap<&str, Own> = HashMap::new();
    for n in &map.nodes {
        if n.test.is_none() {
            own.insert(
                &n.id,
                Own {
                    evidence: Evidence::None,
                    changed: vec![],
                    reason: None,
                    run: None,
                },
            );
            continue;
        }
        let found = entries
            .iter()
            .rev()
            .find_map(|e| e.outcomes.iter().find(|o| matches(n, o)).map(|o| (e, o)));
        let Some((entry, outcome)) = found else {
            own.insert(
                &n.id,
                Own {
                    evidence: Evidence::Untested,
                    changed: vec![],
                    reason: None,
                    run: None,
                },
            );
            continue;
        };
        let changed = changed_since(n, entry, current);
        // A failure stays a failure until a new run says otherwise; a pass only
        // counts while the files it ran against are unchanged.
        let evidence = match outcome.status {
            Status::Fail => Evidence::Broken,
            Status::Skip => Evidence::Skipped,
            Status::Pass if !changed.is_empty() => Evidence::Stale,
            Status::Pass => Evidence::Holds,
        };
        own.insert(
            &n.id,
            Own {
                evidence,
                changed,
                reason: outcome.reason.clone(),
                run: Some(entry.seq),
            },
        );
    }

    let by_id: HashMap<&str, &RootNode> = map.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut memo: HashMap<String, (Support, Vec<String>)> = HashMap::new();
    // Weakest link wins: off or broken anywhere below makes a node unsupported;
    // stale evidence below makes it pending review. The map is a DAG.
    fn resolve(
        id: &str,
        by_id: &HashMap<&str, &RootNode>,
        own: &HashMap<&str, Own>,
        memo: &mut HashMap<String, (Support, Vec<String>)>,
    ) -> (Support, Vec<String>) {
        if let Some(r) = memo.get(id) {
            return r.clone();
        }
        let mut support = Support::Ok;
        let mut because = Vec::new();
        for d in by_id
            .get(id)
            .map(|n| n.depends_on.as_slice())
            .unwrap_or_default()
        {
            let ev = own.get(d.as_str()).map(|o| o.evidence);
            let below = resolve(d, by_id, own, memo).0;
            let off = by_id
                .get(d.as_str())
                .is_some_and(|n| n.stance == Stance::Off);
            if off || ev == Some(Evidence::Broken) || below == Support::Unsupported {
                support = Support::Unsupported;
                because.push(d.clone());
            } else if ev == Some(Evidence::Stale) || below == Support::Pending {
                if support == Support::Ok {
                    support = Support::Pending;
                }
                because.push(d.clone());
            }
        }
        memo.insert(id.to_string(), (support, because.clone()));
        (support, because)
    }

    map.nodes
        .iter()
        .map(|n| {
            let o = own.get(n.id.as_str());
            let (support, because) = resolve(&n.id, &by_id, &own, &mut memo);
            NodeView {
                id: n.id.clone(),
                kind: n.kind,
                title: n.title.clone(),
                detail: n.detail.clone(),
                stance: n.stance,
                protected: n.protected,
                evidence: o.map_or(Evidence::None, |o| o.evidence),
                support,
                because,
                changed: o.map(|o| o.changed.clone()).unwrap_or_default(),
                reason: o.and_then(|o| o.reason.clone()),
                run: o.and_then(|o| o.run),
                depends_on: n.depends_on.clone(),
                watch: watched_by(n),
                test_file: n.test.as_ref().map(|t| t.file.clone()),
            }
        })
        .collect()
}

/// A node needs attention when its own evidence or its support is not sound.
/// Off nodes are a choice, not a problem.
pub fn troubled(v: &NodeView) -> bool {
    v.stance != Stance::Off
        && (matches!(v.evidence, Evidence::Broken | Evidence::Stale) || v.support != Support::Ok)
}

pub fn label(v: &NodeView) -> &'static str {
    if v.stance == Stance::Off {
        return "off";
    }
    match (v.evidence, v.support) {
        (Evidence::Broken, _) => "BROKEN",
        (_, Support::Unsupported) if v.kind == Kind::Intention => "AT RISK",
        (_, Support::Unsupported) => "UNSUPPORTED",
        (Evidence::Stale, _) | (_, Support::Pending) => "pending review",
        (Evidence::Holds, _) => "holds",
        (Evidence::Untested, _) => "untested",
        (Evidence::Skipped, _) => "skipped",
        (Evidence::None, _) => v.stance.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::{RunBody, next_entry};
    use crate::map::parse_map;
    use serde_json::json;

    fn map() -> RootsMap {
        parse_map(&json!({
            "version": 1,
            "nodes": [
                { "id": "inv.sum", "kind": "invariant", "title": "sum",
                  "test": { "file": "test/C.t.sol", "contract": "CT", "name": "invariant_sum" }, "watch": ["src/"] },
                { "id": "inv.bound", "kind": "invariant", "title": "bound",
                  "test": { "file": "test/C.t.sol", "name": "invariant_bound" } },
                { "id": "asm.only-add", "kind": "assumption", "title": "only add", "depends_on": ["inv.sum"] },
                { "id": "int.exact", "kind": "intention", "title": "exact", "depends_on": ["asm.only-add", "inv.bound"] },
                { "id": "asm.off", "kind": "assumption", "title": "off", "stance": "off" },
                { "id": "int.uses-off", "kind": "intention", "title": "uses off", "depends_on": ["asm.off"] }
            ]
        }))
        .expect("valid")
    }

    fn files() -> Files {
        Files::from([
            ("src/C.sol".into(), Some("h1".into())),
            ("src/Lib.sol".into(), Some("h2".into())),
            ("test/C.t.sol".into(), Some("t1".into())),
        ])
    }

    fn outcome(name: &str, status: Status) -> Outcome {
        Outcome {
            file: "test/C.t.sol".into(),
            contract: "CT".into(),
            name: name.into(),
            status,
            reason: (status == Status::Fail).then(|| "drift".into()),
        }
    }

    fn entry(last: Option<&RunEntry>, sum: Status, bound: Status, recorded: Files) -> RunEntry {
        next_entry(
            last,
            RunBody {
                at: "2026-11-13T00:00:00.000Z".into(),
                command: vec!["forge".into()],
                outcomes: vec![
                    outcome("invariant_sum", sum),
                    outcome("invariant_bound", bound),
                ],
                files: recorded,
                error: None,
            },
        )
    }

    fn by_id(vs: Vec<NodeView>) -> HashMap<String, NodeView> {
        vs.into_iter().map(|v| (v.id.clone(), v)).collect()
    }

    #[test]
    fn starts_untested_with_off_as_a_choice() {
        let v = by_id(derive(&map(), &[], &files()));
        assert_eq!(label(&v["inv.sum"]), "untested");
        assert_eq!(label(&v["asm.only-add"]), "hypothetical");
        assert_eq!(label(&v["asm.off"]), "off");
        assert_eq!(label(&v["int.uses-off"]), "AT RISK");
        assert!(!troubled(&v["asm.off"]));
    }

    #[test]
    fn propagates_a_broken_invariant_to_intentions() {
        let v = by_id(derive(
            &map(),
            &[entry(None, Status::Fail, Status::Pass, files())],
            &files(),
        ));
        assert_eq!(v["inv.sum"].evidence, Evidence::Broken);
        assert_eq!(v["inv.sum"].reason.as_deref(), Some("drift"));
        assert_eq!(v["asm.only-add"].support, Support::Unsupported);
        assert_eq!(v["asm.only-add"].because, vec!["inv.sum"]);
        assert_eq!(label(&v["int.exact"]), "AT RISK");
        assert_eq!(v["inv.bound"].evidence, Evidence::Holds);
    }

    #[test]
    fn puts_a_pass_up_for_review_when_watched_files_change() {
        let e = entry(None, Status::Pass, Status::Pass, files());
        let mut edited = files();
        edited.insert("src/C.sol".into(), Some("edited".into()));
        let v = by_id(derive(&map(), std::slice::from_ref(&e), &edited));
        assert_eq!(v["inv.sum"].evidence, Evidence::Stale);
        assert_eq!(v["inv.sum"].changed, vec!["src/C.sol"]);
        assert_eq!(v["asm.only-add"].support, Support::Pending);
        assert_eq!(v["inv.bound"].evidence, Evidence::Holds);

        let mut added = files();
        added.insert("src/New.sol".into(), Some("n".into()));
        assert_eq!(
            by_id(derive(&map(), std::slice::from_ref(&e), &added))["inv.sum"].changed,
            vec!["src/New.sol"]
        );

        let mut removed = files();
        removed.remove("src/Lib.sol");
        assert_eq!(
            by_id(derive(&map(), &[e], &removed))["inv.sum"].changed,
            vec!["src/Lib.sol"]
        );
    }

    #[test]
    fn keeps_a_failure_until_a_newer_run_passes() {
        let a = entry(None, Status::Fail, Status::Pass, files());
        let mut fixed = files();
        fixed.insert("src/C.sol".into(), Some("fixed".into()));
        assert_eq!(
            by_id(derive(&map(), std::slice::from_ref(&a), &fixed))["inv.sum"].evidence,
            Evidence::Broken
        );
        let b = entry(Some(&a), Status::Pass, Status::Pass, fixed.clone());
        let v = by_id(derive(&map(), &[a, b], &fixed));
        assert_eq!(v["inv.sum"].evidence, Evidence::Holds);
        assert_eq!(v["inv.sum"].run, Some(2));
        assert_eq!(v["int.exact"].support, Support::Ok);
    }

    #[test]
    fn ignores_a_result_from_another_contract() {
        let mut e = entry(None, Status::Pass, Status::Pass, files());
        e.outcomes[0].contract = "Other".into();
        assert_eq!(
            by_id(derive(&map(), &[e], &files()))["inv.sum"].evidence,
            Evidence::Untested
        );
    }
}
