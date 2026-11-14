//! The check before a commit. It works with any agent, any editor and no AI at
//! all: whoever commits goes through it.

use crate::derive::{NodeView, label, troubled};
use crate::hooks::{Role, guarded_for_commit};
use crate::map::RootsMap;

pub fn precommit(
    map: &RootsMap,
    views: &[NodeView],
    staged: &[String],
    role: Role,
    log_problems: &[String],
) -> Vec<String> {
    let mut problems = Vec::new();
    if role != Role::Verifier {
        for f in staged {
            if guarded_for_commit(map, f) {
                problems.push(format!(
                    "{f} is guarded: only VIBLOOM_ROLE=verifier may commit changes to it"
                ));
            }
        }
    }
    problems.extend(log_problems.iter().map(|p| format!("run log: {p}")));
    for v in views.iter().filter(|v| troubled(v)) {
        let why = if !v.changed.is_empty() {
            let run = v.run.map_or_else(|| "?".to_string(), |r| r.to_string());
            format!("; changed since run {run}: {}", v.changed.join(", "))
        } else if let Some(r) = &v.reason {
            format!("; failure: {r}")
        } else if !v.because.is_empty() {
            format!("; because of {}", v.because.join(", "))
        } else {
            String::new()
        };
        problems.push(format!("{} [{}] {}{why}", v.id, label(v), v.title));
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::Evidence;
    use crate::hooks::tests::view;
    use crate::map::parse_map;
    use serde_json::json;

    fn map() -> RootsMap {
        parse_map(&json!({
            "version": 1,
            "nodes": [{ "id": "inv.sum", "kind": "invariant", "title": "sum",
                        "test": { "file": "test/C.t.sol", "name": "invariant_sum" }, "watch": ["src/C.sol"] }]
        }))
        .expect("valid")
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_string()).collect()
    }

    #[test]
    fn passes_tested_code_with_its_log_and_proposals() {
        let staged = s(&[
            "src/C.sol",
            ".vibloom/log.jsonl",
            ".vibloom/proposals.jsonl",
        ]);
        assert!(
            precommit(
                &map(),
                &[view(Evidence::Holds)],
                &staged,
                Role::Builder,
                &[]
            )
            .is_empty()
        );
    }

    #[test]
    fn refuses_guarded_files_from_anyone_but_the_verifier() {
        let staged = s(&["test/C.t.sol", ".vibloom/roots.json"]);
        assert_eq!(
            precommit(
                &map(),
                &[view(Evidence::Holds)],
                &staged,
                Role::Builder,
                &[]
            ),
            vec![
                "test/C.t.sol is guarded: only VIBLOOM_ROLE=verifier may commit changes to it",
                ".vibloom/roots.json is guarded: only VIBLOOM_ROLE=verifier may commit changes to it"
            ]
        );
        assert!(
            precommit(
                &map(),
                &[view(Evidence::Holds)],
                &staged,
                Role::Verifier,
                &[]
            )
            .is_empty()
        );
    }

    #[test]
    fn refuses_untested_changed_or_broken_code_and_a_tampered_log() {
        let mut stale = view(Evidence::Stale);
        stale.changed = vec!["src/C.sol".into()];
        assert_eq!(
            precommit(&map(), &[stale], &[], Role::Builder, &[]),
            vec!["inv.sum [pending review] sum; changed since run 3: src/C.sol"]
        );
        let mut broken = view(Evidence::Broken);
        broken.reason = Some("drift".into());
        assert_eq!(
            precommit(&map(), &[broken], &[], Role::Verifier, &[]),
            vec!["inv.sum [BROKEN] sum; failure: drift"]
        );
        assert_eq!(
            precommit(&map(), &[view(Evidence::Untested)], &[], Role::Builder, &[]),
            vec!["inv.sum [untested] sum"]
        );
        assert_eq!(
            precommit(
                &map(),
                &[view(Evidence::Holds)],
                &[],
                Role::Verifier,
                &["entry 2 was changed".into()]
            ),
            vec!["run log: entry 2 was changed"]
        );
    }
}
