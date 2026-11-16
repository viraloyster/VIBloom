use crate::cli::{Args, Fallible, Io};
use crate::derive::{NodeView, label, shown, troubled};
use crate::paths::relative_to;
use crate::store::{load_log, views};
use serde_json::{Value, json};
use std::path::Path;

pub fn table(vs: &[NodeView]) -> String {
    if vs.is_empty() {
        return "The map has no nodes yet. Run `vibloom scan` or edit .vibloom/roots.json.".into();
    }
    let w = vs.iter().map(|v| shown(v).len()).max().unwrap_or(0);
    let iw = vs.iter().map(|v| v.id.len()).max().unwrap_or(0);
    // What needs attention first; on a long map it must not be looked for.
    let mut rows: Vec<&NodeView> = vs.iter().collect();
    rows.sort_by_key(|v| !troubled(v));
    let bad = vs.iter().filter(|v| troubled(v)).count();
    let mut out = vec![format!(
        "{} nodes, {bad} {} attention.",
        vs.len(),
        if bad == 1 { "needs" } else { "need" }
    )];
    out.extend(
        rows.iter()
            .map(|v| format!("{:w$}  {:iw$}  {}", shown(v), v.id, v.title)),
    );
    let risks = accepted_risks(vs);
    if !risks.is_empty() {
        out.push(String::new());
        out.push("Accepted risks:".into());
        out.extend(risks);
    }
    out.join("\n")
}

// Each risk a node accepts, with its reason, so an accepted weakness is never
// out of sight; one no longer in effect is pointed out for removal.
fn accepted_risks(vs: &[NodeView]) -> Vec<String> {
    vs.iter()
        .flat_map(|v| {
            v.accepts.iter().map(|a| {
                if a.in_effect {
                    format!("- {} accepts {} being off: {}", v.id, a.id, a.reason)
                } else {
                    format!(
                        "- {} accepts {} being off, but it is on again: remove it with `vibloom edit {} --unaccept {}`",
                        v.id, a.id, v.id, a.id
                    )
                }
            })
        })
        .collect()
}

pub(crate) fn status(root: &Path, io: &mut Io, as_json: bool) -> Fallible<i32> {
    let vs = views(root)?;
    let problems = load_log(root).problems;
    if !problems.is_empty() {
        (io.err)(&format!(
            "The run log failed verification; only runs before the break count:\n- {}",
            problems.join("\n- ")
        ));
    }
    if as_json {
        let nodes: Vec<Value> = vs
            .iter()
            .map(|v| {
                let mut j = serde_json::to_value(v).unwrap_or(Value::Null);
                j["state"] = json!(label(v));
                j["needs_attention"] = json!(troubled(v));
                j
            })
            .collect();
        let risks: Vec<Value> = vs
            .iter()
            .flat_map(|v| {
                v.accepts.iter().map(|a| {
                    json!({ "node": v.id, "dependency": a.id, "reason": a.reason, "in_effect": a.in_effect })
                })
            })
            .collect();
        (io.out)(
            &json!({ "nodes": nodes, "accepted_risks": risks, "log_problems": problems })
                .to_string(),
        );
    } else {
        (io.out)(&table(&vs));
    }
    Ok(i32::from(vs.iter().any(troubled) || !problems.is_empty()))
}

pub(crate) fn context(root: &Path, io: &mut Io, args: &Args) -> Fallible<i32> {
    let file = match args.words.first() {
        None => None,
        Some(f) => Some(
            relative_to(root, &io.cwd, f).ok_or_else(|| format!("{f} is outside the project."))?,
        ),
    };
    (io.out)(&crate::context::context(&views(root)?, file.as_deref()));
    Ok(0)
}

pub(crate) fn verify(root: &Path, io: &mut Io) -> Fallible<i32> {
    let log = load_log(root);
    if !log.problems.is_empty() {
        (io.err)(&log.problems.join("\n"));
        return Ok(1);
    }
    (io.out)(&format!("{} runs, chain intact.", log.entries.len()));
    Ok(0)
}
