//! What a branch changed in the guard itself, compared with its base: the
//! map, and the files the base's map guards. Adding to the map is not a
//! change of the guard; taking anything away, or editing what guards it, is.
//! No IO: the command reads git and the disk, this decides.

use crate::map::{MAP_PATH, RootNode, RootsMap, Stance, covers};
use crate::setup::helpers;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GuardChange {
    /// A stable code: `file_changed`, `node_removed`, `runner_changed`...
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    pub path: String,
    pub message: String,
}

fn on_map(kind: &'static str, node: Option<&str>, message: String) -> GuardChange {
    GuardChange {
        kind,
        node: node.map(str::to_string),
        path: MAP_PATH.to_string(),
        message,
    }
}

fn node_changes(b: &RootNode, h: &RootNode, out: &mut Vec<GuardChange>) {
    let id = b.id.as_str();
    let test = |t: &crate::map::TestRef| {
        format!(
            "{}:{}{}",
            t.file,
            t.contract
                .as_deref()
                .map(|c| format!("{c}."))
                .unwrap_or_default(),
            t.name
        )
    };
    match (&b.test, &h.test) {
        (Some(bt), None) => out.push(on_map(
            "test_removed",
            Some(id),
            format!("{id}: its test {} was taken away", test(bt)),
        )),
        (Some(bt), Some(ht)) if bt != ht => out.push(on_map(
            "test_changed",
            Some(id),
            format!("{id}: its test changed from {} to {}", test(bt), test(ht)),
        )),
        _ => {}
    }
    if b.protected && !h.protected {
        out.push(on_map(
            "unprotected",
            Some(id),
            format!("{id}: its test is no longer protected"),
        ));
    }
    if b.stance != Stance::Off && h.stance == Stance::Off {
        out.push(on_map(
            "switched_off",
            Some(id),
            format!("{id}: switched off (was {})", b.stance.as_str()),
        ));
    }
    for a in h
        .accepts
        .iter()
        .filter(|a| !b.accepts.iter().any(|x| x.id == a.id))
    {
        out.push(on_map(
            "accepts_added",
            Some(id),
            format!("{id}: now accepts {} being off: {}", a.id, a.reason),
        ));
    }
    for d in b.depends_on.iter().filter(|d| !h.depends_on.contains(d)) {
        out.push(on_map(
            "dependency_removed",
            Some(id),
            format!("{id}: no longer rests on {d}"),
        ));
    }
}

/// Every way the map on the branch weakens the map on the base.
pub fn map_changes(base: &RootsMap, head: &RootsMap) -> Vec<GuardChange> {
    let mut out = Vec::new();
    let same = |kind: &'static str, what: &str, b: String, h: String, out: &mut Vec<_>| {
        if b != h {
            out.push(on_map(
                kind,
                None,
                format!("{what} changed from {b} to {h}"),
            ));
        }
    };
    same(
        "runner_changed",
        "the runner",
        format!("`{}`", base.runner.join(" ")),
        format!("`{}`", head.runner.join(" ")),
        &mut out,
    );
    let report = |m: &RootsMap| m.report.clone().unwrap_or_else(|| "none".into());
    same(
        "report_changed",
        "the report",
        report(base),
        report(head),
        &mut out,
    );
    same(
        "timeout_changed",
        "the timeout",
        format!("{} s", base.timeout),
        format!("{} s", head.timeout),
        &mut out,
    );
    same(
        "tests_changed",
        "the tests folder",
        base.tests.clone(),
        head.tests.clone(),
        &mut out,
    );
    for p in base.protect.iter().filter(|p| !head.protect.contains(p)) {
        out.push(on_map(
            "protect_removed",
            None,
            format!("{p} is no longer in protect"),
        ));
    }
    if base.strict && !head.strict {
        out.push(on_map("strict_off", None, "strict was turned off".into()));
    }
    for b in &base.nodes {
        match head.nodes.iter().find(|h| h.id == b.id) {
            None => out.push(on_map(
                "node_removed",
                Some(&b.id),
                format!("{}: the node was removed", b.id),
            )),
            Some(h) => node_changes(b, h, &mut out),
        }
    }
    out
}

/// What the base's map guards, besides the map itself: its protected tests,
/// the helpers they import and its protect list. Folders end in "/".
pub fn guarded_at_base(base: &RootsMap, read: &dyn Fn(&str) -> Option<String>) -> Vec<String> {
    let tests: Vec<String> = base
        .nodes
        .iter()
        .filter(|n| n.protected)
        .filter_map(|n| n.test.as_ref().map(|t| t.file.clone()))
        .collect();
    let mut out: BTreeSet<String> = tests.iter().cloned().collect();
    out.extend(helpers(&tests, &base.tests, read));
    out.extend(base.protect.iter().cloned());
    // The map is compared by what it says, not by its text.
    out.into_iter()
        .filter(|f| !covers(".vibloom/", f))
        .collect()
}

pub struct Reader<'a> {
    pub base: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    pub now: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    pub base_dir: &'a dyn Fn(&str) -> Vec<String>,
}

/// Each guarded file that differs from the base. A file new in a guarded
/// folder is new code, not a change; a guarded file that did not exist on
/// the base and does now (a `foundry.toml` added) changes how tests run.
pub fn file_changes(entries: &[String], r: &Reader) -> Vec<GuardChange> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for e in entries {
        let (files, folder) = if e.ends_with('/') {
            ((r.base_dir)(e), true)
        } else {
            (vec![e.clone()], false)
        };
        for f in files {
            if !seen.insert(f.clone()) {
                continue;
            }
            let (b, n) = ((r.base)(&f), (r.now)(&f));
            let (kind, what) = match (&b, &n) {
                (Some(b), Some(n)) if b == n => continue,
                (None, None) => continue,
                (Some(_), Some(_)) => ("file_changed", "changed"),
                (Some(_), None) => ("file_removed", "removed"),
                (None, Some(_)) if folder => continue,
                (None, Some(_)) => ("file_added", "added"),
            };
            out.push(GuardChange {
                kind,
                node: None,
                message: format!("{f}: guarded file {what}"),
                path: f,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::parse_map;
    use serde_json::{Value, json};
    use std::collections::HashMap;

    fn base() -> Value {
        json!({
            "version": 1,
            "protect": ["foundry.toml", "test/handlers/"],
            "nodes": [
                { "id": "inv.sum", "kind": "invariant", "title": "sum",
                  "test": { "file": "test/C.t.sol", "contract": "CT", "name": "invariant_sum" } },
                { "id": "asm.only-add", "kind": "assumption", "title": "only add",
                  "stance": "adopted", "depends_on": ["inv.sum"] },
                { "id": "asm.off", "kind": "assumption", "title": "off", "stance": "off" },
                { "id": "int.exact", "kind": "intention", "title": "exact",
                  "depends_on": ["asm.only-add", "asm.off"] }
            ]
        })
    }

    fn changes(edit: impl FnOnce(&mut Value)) -> Vec<String> {
        let mut head = base();
        edit(&mut head);
        let (b, h) = (
            parse_map(&base()).expect("base"),
            parse_map(&head).expect("head"),
        );
        map_changes(&b, &h).into_iter().map(|c| c.message).collect()
    }

    #[test]
    fn adding_to_the_map_is_no_guard_change() {
        assert!(
            changes(|m| {
                m["nodes"].as_array_mut().expect("nodes").push(json!({
                    "id": "inv.new", "kind": "invariant", "title": "new",
                    "test": { "file": "test/New.t.sol", "name": "invariant_new" } }));
                m["nodes"][1]["evidence"] = json!(["src/C.sol:3"]);
                m["nodes"][3]["depends_on"] = json!(["asm.only-add", "asm.off", "inv.new"]);
                m["protect"] = json!(["foundry.toml", "test/handlers/", "remappings.txt"]);
                m["strict"] = json!(true);
            })
            .is_empty()
        );
    }

    #[test]
    fn names_every_way_the_map_was_weakened() {
        let got = changes(|m| {
            m["runner"] = json!(["forge", "test", "--json", "--fuzz-runs", "1"]);
            m["timeout"] = json!(5);
            m["protect"] = json!(["test/handlers/"]);
            m["nodes"][0]["test"]["name"] = json!("invariant_true");
            m["nodes"][0]["protected"] = json!(false);
            m["nodes"][1]["stance"] = json!("off");
            m["nodes"][3]["depends_on"] = json!(["asm.off"]);
            m["nodes"][3]["accepts"] = json!([{ "id": "asm.off", "reason": "fine" }]);
            m["nodes"].as_array_mut().expect("nodes").remove(2);
            m["nodes"][2]["depends_on"] = json!(["asm.only-add"]);
            m["nodes"][2]["accepts"] = json!([]);
        });
        assert_eq!(
            got,
            vec![
                "the runner changed from `forge test --json` to `forge test --json --fuzz-runs 1`",
                "the timeout changed from 3600 s to 5 s",
                "foundry.toml is no longer in protect",
                "inv.sum: its test changed from test/C.t.sol:CT.invariant_sum to test/C.t.sol:CT.invariant_true",
                "inv.sum: its test is no longer protected",
                "asm.only-add: switched off (was adopted)",
                "asm.off: the node was removed",
                "int.exact: no longer rests on asm.off",
            ]
        );
        let accepts = changes(|m| {
            m["nodes"][3]["accepts"] = json!([{ "id": "asm.off", "reason": "capped" }]);
        });
        assert_eq!(
            accepts,
            vec!["int.exact: now accepts asm.off being off: capped"]
        );
        let strict = |on: bool| {
            let mut b = parse_map(&base()).expect("base");
            b.strict = on;
            map_changes(&b, &parse_map(&base()).expect("head"))
        };
        assert_eq!(strict(true)[0].kind, "strict_off");
        assert!(strict(false).is_empty());
    }

    #[test]
    fn compares_what_the_base_guards_with_the_tree() {
        let b = parse_map(&base()).expect("base");
        let read = |f: &str| {
            (f == "test/C.t.sol").then(|| "import \"./Base.sol\";\ncontract CT {}".to_string())
        };
        let entries = guarded_at_base(&b, &read);
        assert_eq!(
            entries,
            vec![
                "foundry.toml",
                "test/Base.sol",
                "test/C.t.sol",
                "test/handlers/"
            ]
        );
        let at_base: HashMap<&str, &str> = HashMap::from([
            ("test/C.t.sol", "assert(sum == total);"),
            ("test/Base.sol", "base"),
            ("test/handlers/H.sol", "handler"),
            ("test/handlers/Gone.sol", "gone"),
        ]);
        let now: HashMap<&str, &str> = HashMap::from([
            ("test/C.t.sol", "assert(true);"),
            ("test/Base.sol", "base"),
            ("test/handlers/H.sol", "handler"),
            ("test/handlers/New.sol", "new"),
            ("foundry.toml", "[invariant]\nruns = 1"),
        ]);
        let get = |m: &HashMap<&str, &str>, f: &str| m.get(f).map(|s| s.as_bytes().to_vec());
        let base_dir = |d: &str| {
            let mut v: Vec<String> = at_base
                .keys()
                .filter(|f| f.starts_with(d))
                .map(|f| (*f).to_string())
                .collect();
            v.sort();
            v
        };
        let r = Reader {
            base: &|f| get(&at_base, f),
            now: &|f| get(&now, f),
            base_dir: &base_dir,
        };
        let got: Vec<String> = file_changes(&entries, &r)
            .into_iter()
            .map(|c| c.message)
            .collect();
        assert_eq!(
            got,
            vec![
                "foundry.toml: guarded file added",
                "test/C.t.sol: guarded file changed",
                "test/handlers/Gone.sol: guarded file removed",
            ]
        );
    }
}
