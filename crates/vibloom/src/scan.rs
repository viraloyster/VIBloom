//! Finds Foundry invariant tests that the map does not list yet. They are added
//! as protected invariants for a person to title and connect.

use crate::map::{Kind, RootNode, RootsMap, Stance, TestRef};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub file: String,
    pub contract: String,
    pub name: String,
}

static CONTRACT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bcontract\s+([A-Za-z_]\w*)").expect("static regex"));
static INVARIANT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bfunction\s+(invariant_?\w*)\s*\(").expect("static regex"));
static CAMEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").expect("static regex"));

pub fn find_invariants(file: &str, source: &str) -> Vec<Found> {
    let contracts: Vec<(usize, &str)> = CONTRACT
        .captures_iter(source)
        .filter_map(|c| Some((c.get(0)?.start(), c.get(1)?.as_str())))
        .collect();
    INVARIANT
        .captures_iter(source)
        .filter_map(|c| {
            let at = c.get(0)?.start();
            let owner = contracts.iter().rev().find(|(pos, _)| *pos < at)?;
            Some(Found {
                file: file.into(),
                contract: owner.1.into(),
                name: c.get(1)?.as_str().into(),
            })
        })
        .collect()
}

fn id_for(name: &str) -> String {
    let base = name
        .strip_prefix("invariant_")
        .or_else(|| name.strip_prefix("invariant"))
        .unwrap_or(name);
    format!(
        "inv.{}",
        CAMEL
            .replace_all(base, "$1-$2")
            .replace('_', "-")
            .to_lowercase()
    )
}

pub fn add_found(map: &RootsMap, found: &[Found]) -> (RootsMap, Vec<String>) {
    let known: HashSet<String> = map
        .nodes
        .iter()
        .filter_map(|n| n.test.as_ref().map(|t| format!("{}:{}", t.file, t.name)))
        .collect();
    let mut ids: HashSet<String> = map.nodes.iter().map(|n| n.id.clone()).collect();
    let mut out = map.clone();
    let mut added = Vec::new();
    for f in found {
        if known.contains(&format!("{}:{}", f.file, f.name)) {
            continue;
        }
        let base = id_for(&f.name);
        let mut id = base.clone();
        let mut i = 2;
        while ids.contains(&id) {
            id = format!("{base}-{i}");
            i += 1;
        }
        ids.insert(id.clone());
        out.nodes.push(RootNode {
            id: id.clone(),
            kind: Kind::Invariant,
            title: f.name.clone(),
            detail: None,
            stance: Stance::Adopted,
            test: Some(TestRef {
                file: f.file.clone(),
                contract: Some(f.contract.clone()),
                name: f.name.clone(),
            }),
            watch: vec![],
            depends_on: vec![],
            protected: true,
        });
        added.push(id);
    }
    (out, added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::parse_map;
    use serde_json::json;

    const SOURCE: &str = "
contract Handler { function invariant_notHere() public {} }
contract CounterTest is Test {
    function setUp() public {}
    function invariant_totalMatchesAdded() public view {}
    function invariantBounded() external view {}
    function test_add() public {}
}";

    #[test]
    fn finds_invariants_and_their_contracts() {
        let f = find_invariants("test/C.t.sol", SOURCE);
        let got: Vec<(&str, &str)> = f
            .iter()
            .map(|x| (x.contract.as_str(), x.name.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Handler", "invariant_notHere"),
                ("CounterTest", "invariant_totalMatchesAdded"),
                ("CounterTest", "invariantBounded")
            ]
        );
    }

    #[test]
    fn adds_only_what_is_missing_with_unique_ids() {
        let start = parse_map(&json!({
            "version": 1,
            "nodes": [{ "id": "inv.total-matches-added", "kind": "invariant", "title": "here",
                        "test": { "file": "test/C.t.sol", "name": "invariant_totalMatchesAdded" } }]
        }))
        .expect("valid");
        let mut found = find_invariants("test/C.t.sol", SOURCE);
        found.push(Found {
            file: "test/D.t.sol".into(),
            contract: "D".into(),
            name: "invariant_totalMatchesAdded".into(),
        });
        let (map, added) = add_found(&start, &found);
        assert_eq!(
            added,
            vec!["inv.not-here", "inv.bounded", "inv.total-matches-added-2"]
        );
        let last = map.nodes.last().expect("node");
        assert!(last.protected);
        assert_eq!(
            last.test.as_ref().map(|t| t.file.as_str()),
            Some("test/D.t.sol")
        );
    }
}
