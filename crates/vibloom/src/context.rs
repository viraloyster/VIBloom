//! What an agent reads before touching code: full detail for the nodes the file
//! at hand touches and the nodes they rest on, one line for everything else.

use crate::derive::{NodeView, label, troubled};
use crate::map::covers;
use std::collections::{HashMap, HashSet};

fn line(v: &NodeView) -> String {
    format!("- {} [{}] {}", v.id, label(v), v.title)
}

fn full(v: &NodeView, by_id: &HashMap<&str, &NodeView>) -> String {
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
    if !v.watch.is_empty() {
        out.push(format!("  watches: {}", v.watch.join(", ")));
    }
    if !v.depends_on.is_empty() {
        let deps: Vec<String> = v
            .depends_on
            .iter()
            .map(|d| format!("{d} [{}]", by_id.get(d.as_str()).map_or("?", |x| label(x))))
            .collect();
        out.push(format!("  rests on: {}", deps.join(", ")));
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
    if let Some(r) = &v.reason {
        out.push(format!("  last failure: {r}"));
    }
    out.join("\n")
}

pub fn context(views: &[NodeView], path: Option<&str>) -> String {
    let by_id: HashMap<&str, &NodeView> = views.iter().map(|v| (v.id.as_str(), v)).collect();
    let mut near: HashSet<&str> = HashSet::new();
    if let Some(p) = path {
        for v in views {
            if v.watch.iter().any(|w| covers(w, p)) {
                near.insert(&v.id);
            }
        }
        // What the touched nodes rest on, and what rests on them.
        let mut queue: Vec<&str> = near.iter().copied().collect();
        while let Some(id) = queue.pop() {
            for d in by_id
                .get(id)
                .map(|v| v.depends_on.as_slice())
                .unwrap_or_default()
            {
                if near.insert(d) {
                    queue.push(d);
                }
            }
        }
        let above: Vec<&str> = views
            .iter()
            .filter(|v| v.depends_on.iter().any(|d| near.contains(d.as_str())))
            .map(|v| v.id.as_str())
            .collect();
        near.extend(above);
    }
    let trouble = views.iter().filter(|v| troubled(v)).count();
    let mut out = vec![
        "VIBloom roots. States are derived from test runs; an agent cannot set them.".to_string(),
        format!("{} nodes, {trouble} need attention.", views.len()),
    ];
    if let Some(p) = path {
        out.push(String::new());
        out.push(format!("Touching {p}:"));
        let close: Vec<String> = views
            .iter()
            .filter(|v| near.contains(v.id.as_str()))
            .map(|v| full(v, &by_id))
            .collect();
        if close.is_empty() {
            out.push("- nothing in the map watches it".into());
        } else {
            out.extend(close);
        }
    }
    let rest: Vec<&NodeView> = views
        .iter()
        .filter(|v| !near.contains(v.id.as_str()))
        .collect();
    if !rest.is_empty() {
        out.push(String::new());
        out.push(
            if path.is_some() {
                "Elsewhere:"
            } else {
                "All nodes:"
            }
            .into(),
        );
        out.extend(rest.iter().filter(|v| troubled(v)).map(|v| line(v)));
        out.extend(rest.iter().filter(|v| !troubled(v)).map(|v| line(v)));
    }
    out.push(String::new());
    out.push(
        "Rules: propose new assumptions as hypothetical; do not weaken or edit protected tests;"
            .into(),
    );
    out.push(
        "a task is not done while any node is BROKEN, UNSUPPORTED, AT RISK or pending review."
            .into(),
    );
    out.join("\n")
}
