use crate::cli::Fallible;
use crate::foundry::compiled;
use crate::map::PROPOSALS_PATH;
use crate::proposals::{Draft, propose};
use crate::store::{append, iso_now, load_book, load_map, locked};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// What the code itself says, for a Foundry project: who may call what, what
/// can be upgraded or paused, what it calls. With `propose`, the assumptions
/// that follow are filed as proposals, each with the lines it comes from.
/// Only the contracts named in `only`, when it names any.
pub fn survey(root: &Path, file_proposals: bool, only: &[String]) -> Fallible<String> {
    let map = load_map(root)?;
    let (mut contracts, _) = compiled(root, &map, "survey")?;
    if !only.is_empty() {
        let unknown: Vec<&String> = only
            .iter()
            .filter(|n| !contracts.iter().any(|c| &c.name == *n))
            .collect();
        if !unknown.is_empty() {
            let names: BTreeSet<&str> = contracts.iter().map(|c| c.name.as_str()).collect();
            let near: Vec<&str> = unknown
                .iter()
                .flat_map(|u| crate::suggest::nearest(u, names.iter().copied()))
                .collect();
            return Err(format!(
                "No contract {} in the survey.{} The contracts are: {}.",
                unknown
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                if near.is_empty() {
                    String::new()
                } else {
                    format!(" Did you mean {}?", near.join(", "))
                },
                names.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
        contracts.retain(|c| only.contains(&c.name));
    }
    let mut out = vec!["What the code says (file:line function - who may call it):".to_string()];
    out.extend(contracts.iter().map(crate::survey::Contract::report));
    let cands: Vec<_> = contracts.iter().flat_map(|c| c.candidates()).collect();
    let list = |invariant: bool| -> Vec<String> {
        cands
            .iter()
            .filter(|c| c.invariant == invariant)
            .map(|c| format!("- {} [{}]", c.title, c.evidence.join(", ")))
            .collect()
    };
    out.push(String::new());
    let none = |l: Vec<String>| {
        if l.is_empty() {
            vec!["(none found)".to_string()]
        } else {
            l
        }
    };
    out.push("Assumptions the code leans on:".into());
    out.extend(none(list(false)));
    out.push(String::new());
    out.push("Invariants worth a test (each needs one before it can enter the map):".into());
    out.extend(none(list(true)));
    if file_proposals {
        let mut filed: BTreeMap<&str, usize> = BTreeMap::new();
        locked(root, || {
            for c in cands.iter().filter(|c| !c.invariant) {
                let book = load_book(root);
                let draft = Draft {
                    kind: "assumption".into(),
                    title: c.title.clone(),
                    detail: Some(c.detail.clone()),
                    depends_on: vec![],
                    watch: vec![],
                    test: None,
                    evidence: c.evidence.clone(),
                    node_id: Some(c.id.clone()),
                    by: Some("vibloom survey".into()),
                };
                // One already pending or in the map is not filed twice, and
                // one the verifier turned down is not filed again.
                let rejected = book.decisions.iter().any(|d| {
                    d.decision == "reject"
                        && book
                            .proposals
                            .iter()
                            .any(|p| p.id == d.decide && p.title == c.title)
                });
                if rejected {
                    continue;
                }
                if let Ok(p) = propose(&map, &book, draft, iso_now()) {
                    append(
                        &root.join(PROPOSALS_PATH),
                        &format!("{}\n", serde_json::to_string(&p).unwrap_or_default()),
                    )?;
                    *filed
                        .entry(c.title.split_once(": ").map_or("other", |(h, _)| h))
                        .or_default() += 1;
                }
            }
            Ok(())
        })?;
        // Filing is the step before deciding: the full report is one
        // `vibloom survey` away, and here would bury what to do next.
        let total: usize = filed.values().sum();
        let invariants = cands.iter().filter(|c| c.invariant).count();
        let mut out = vec![if !cands.iter().any(|c| !c.invariant) {
            "Found no assumptions to file.".to_string()
        } else if total == 0 {
            "Filed no new proposals: each candidate is already pending, in the map or rejected."
                .to_string()
        } else {
            format!(
                "Filed {total} {}, all assumptions: {}.",
                if total == 1 { "proposal" } else { "proposals" },
                filed
                    .iter()
                    .map(|(c, n)| format!("{c} {n}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }];
        if invariants > 0 {
            out.push(format!(
                "{invariants} invariant {} a test before {} can enter the map; `vibloom survey` lists them.",
                if invariants == 1 { "candidate needs" } else { "candidates need" },
                if invariants == 1 { "it" } else { "they" }
            ));
        }
        if total > 0 {
            out.push("See them: `vibloom proposals` (grouped by contract). Decide: `vibloom proposals accept <id>...` or `reject <id>...`, or a whole contract with `accept --all --contract <Name>`.".into());
        }
        return Ok(out.join("\n"));
    }
    out.push(String::new());
    out.push(format!(
        "Next: `vibloom survey --propose` files these assumptions as proposals for you to decide. An invariant needs a test first (template: {}).",
        crate::commands::guide::TEMPLATE
    ));
    Ok(out.join("\n"))
}
