use crate::cli::{Fallible, Io};
use crate::hooks::Role;
use crate::map::{MAP_PATH, PROPOSALS_PATH, serialize_map};
use crate::proposals::{Decision, accept};
use crate::store::{append, iso_now, load_book, load_map, locked, write_atomic};
use std::path::Path;

pub(crate) fn proposals(root: &Path, rest: &[&str], on: &[String], io: &mut Io) -> Fallible<i32> {
    match rest.first().copied() {
        None | Some("list") => {
            let book = load_book(root);
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
                    // Indented on every line, so a detail cannot pass for a proposal.
                    (io.out)(&format!(
                        "    {}",
                        d.lines().collect::<Vec<_>>().join("\n    ")
                    ));
                }
                if let Some(t) = &p.test {
                    (io.out)(&format!("    test: {} {}", t.file, t.name));
                }
                if !p.evidence.is_empty() {
                    (io.out)(&format!("    from: {}", p.evidence.join("; ")));
                }
            }
            Ok(0)
        }
        Some(action @ ("accept" | "reject")) if rest.len() > 1 => {
            // Deciding changes the map: the same role that may edit it by hand.
            if io.role != Role::Verifier {
                return Err(format!(
                    "Only the verifier decides proposals: VIBLOOM_ROLE=verifier vibloom proposals {action} {}",
                    rest[1..].join(" ")
                ));
            }
            // Named twice, a proposal is still decided once.
            let mut ids: Vec<&str> = Vec::new();
            for id in &rest[1..] {
                if !ids.contains(id) {
                    ids.push(id);
                }
            }
            locked(root, || {
                for id in &ids {
                    let book = load_book(root);
                    let Some(p) = book.pending().into_iter().find(|p| p.id == *id).cloned() else {
                        return Err(format!("No pending proposal {id}."));
                    };
                    let mut node = None;
                    let mut stance = "";
                    if action == "accept" {
                        // What the person links it to counts with what the
                        // proposal itself rests on.
                        let mut p = p.clone();
                        for d in on {
                            if !p.depends_on.contains(d) {
                                p.depends_on.push(d.clone());
                            }
                        }
                        let (map, new_id) = accept(&load_map(root)?, &p).map_err(|e| {
                            format!("{id} cannot be accepted:\n- {}", e.join("\n- "))
                        })?;
                        write_atomic(&root.join(MAP_PATH), &serialize_map(&map))?;
                        stance = map
                            .nodes
                            .iter()
                            .find(|n| n.id == new_id)
                            .map_or("", |n| n.stance.as_str());
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
                    (io.out)(&match node {
                        Some(n) => match p.node_id.as_deref().filter(|asked| *asked != n) {
                            Some(asked) => format!(
                                "Accepted {id} as {n} ({stance}; {asked} is already in use)."
                            ),
                            None => format!("Accepted {id} as {n} ({stance})."),
                        },
                        None => format!("Rejected {id}."),
                    });
                }
                Ok(0)
            })
        }
        _ => Err(
            "Usage: vibloom proposals [list | accept <id>... [--on ID]... | reject <id>...]".into(),
        ),
    }
}
