use crate::cli::Fallible;
use crate::foundry::compiled;
use crate::store::load_map;
use std::fs;
use std::path::Path;

pub const NOTES_PATH: &str = ".vibloom/notes.md";

/// The brief an agent works from when asked to find what a project assumes
/// and what must always hold: the facts from the code, the person's notes,
/// and how to propose, with evidence.
pub fn research(root: &Path) -> Fallible<String> {
    let map = load_map(root)?;
    let mut out = vec![
        "Research brief. Goal: find what this project assumes and what must always hold, and propose each with where it comes from. You propose; the verifier decides.".to_string(),
        String::new(),
    ];
    match fs::read_to_string(root.join(NOTES_PATH)) {
        Ok(notes) if !notes.trim().is_empty() => {
            out.push(format!("The person's notes on what this is meant to do ({NOTES_PATH}):"));
            out.push(notes.trim().to_string());
        }
        _ => out.push(format!(
            "No notes yet: ask the person what the protocol is meant to guarantee, or have them write it in {NOTES_PATH}."
        )),
    }
    out.push(String::new());
    match compiled(root, &map, "research") {
        Ok((contracts, _)) => out.push(survey_summary(&contracts)),
        Err(e) => out.push(format!("The code could not be surveyed: {e}")),
    }
    out.push(String::new());
    out.push(
        "How to work:
1. Read the notes and the summary above. Before proposing anything about a contract, ask for its detail with the `survey` tool (`contracts`: its name): who may call each function, its state, its calls, and the lines each candidate comes from. Then read the code it points at.
2. Look for what the code does not say: the project's docs and README, audits and write-ups of it and of protocols like it, the standards it implements (EIPs), and known failures of the same design.
3. For deployed contracts, read the chain, never write to it. With ETH_RPC_URL set: `cast code`, `cast call`, `cast storage`, `cast implementation`, `cast admin`, `cast logs`, at a fixed block (`--block`). Record the block.
4. For each thing found, call the `propose` tool once:
   - an assumption for what the code takes on trust (a role holder, another contract, a token's behaviour, an off-chain process);
   - an invariant for what must hold after any sequence of calls, with the test that checks it (write the test first; a handler must reach every function that can break it);
   - an intention for what the protocol promises its users, resting on the invariants and assumptions that make it true (`depends_on`).
   `evidence` is required: `src/File.sol:120`, a URL with its section, or the chain read with its block. Quote, do not paraphrase from memory. If you cannot point at a source, do not propose it.
5. Say what you could not establish. A gap stated is worth more than a guess."
            .into(),
    );
    Ok(out.join("\n"))
}

// The survey in a few lines for an agent: one per contract, then each
// candidate's title once, with the contracts it applies to.
fn survey_summary(contracts: &[crate::survey::Contract]) -> String {
    let mut out = vec![
        "The survey, one line per contract (entry points: gated by a modifier, open, open but checking the caller in their body):".to_string(),
    ];
    out.extend(contracts.iter().map(crate::survey::Contract::summary));
    let mut groups: Vec<(bool, String, Vec<&str>)> = Vec::new();
    for c in contracts {
        for cand in c.candidates() {
            let prefix = format!("{}: ", c.name);
            let title = cand
                .title
                .strip_prefix(&prefix)
                .unwrap_or(&cand.title)
                .to_string();
            match groups
                .iter_mut()
                .find(|(inv, t, _)| *inv == cand.invariant && *t == title)
            {
                Some((_, _, names)) => {
                    if !names.contains(&c.name.as_str()) {
                        names.push(&c.name);
                    }
                }
                None => groups.push((cand.invariant, title, vec![&c.name])),
            }
        }
    }
    for (invariant, heading) in [
        (false, "Assumption candidates (title: contracts):"),
        (
            true,
            "Invariant candidates, each needing a test before it can enter the map (title: contracts):",
        ),
    ] {
        out.push(String::new());
        out.push(heading.into());
        let lines: Vec<String> = groups
            .iter()
            .filter(|(inv, _, _)| *inv == invariant)
            .map(|(_, t, names)| format!("- {t}: {}", names.join(", ")))
            .collect();
        if lines.is_empty() {
            out.push("(none found)".into());
        }
        out.extend(lines);
    }
    out.join("\n")
}
