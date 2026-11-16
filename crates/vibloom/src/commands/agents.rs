use crate::cli::{Args, Fallible, Io};
use crate::commands::verifier;
use crate::map::{MAP_PATH, serialize_map};
use crate::store::{load_map, read_json, write_atomic, write_json};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

pub fn hooks_config() -> Value {
    json!({ "hooks": {
        "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
                         "hooks": [{ "type": "command", "command": "vibloom hook pre-tool" }] }],
        "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
                          "hooks": [{ "type": "command", "command": "vibloom hook post-tool" }] }],
        "Stop": [{ "hooks": [{ "type": "command", "command": "vibloom hook stop" }] }]
    }})
}

pub(crate) fn setup(root: &Path, io: &mut Io, args: &Args) -> Fallible<i32> {
    verifier(io.role, "changes what is guarded")?;
    let agent = args.words.first().copied().unwrap_or_default();
    let (notes, guard) = setup_agent(root, agent)?;
    let mut map = load_map(root)?;
    let before = map.protect.len();
    for g in guard {
        if !crate::hooks::is_guarded(&map, &g) {
            map.protect.push(g);
        }
    }
    if map.protect.len() != before {
        write_atomic(&root.join(MAP_PATH), &serialize_map(&map))?;
    }
    for n in notes {
        (io.out)(&n);
    }
    Ok(0)
}

const AGENTS_START: &str = "<!-- vibloom:start -->";
const AGENTS_SECTION: &str = "<!-- vibloom:start -->
## VIBloom

This project keeps its assumptions, invariants and intentions in
`.vibloom/roots.json`. Their states come from recorded test runs, not from
anyone's say-so.

- Before changing a file: `vibloom context <file>`.
- After changing code: `vibloom run`. It runs the tests and records them.
- The task is not done while `vibloom status` exits 1.
- Never edit a protected test, its handler, the test configuration or
  `.vibloom/` to make a check pass. If an invariant looks wrong, stop and say
  why.
- To suggest an assumption, invariant or intention, use the `propose` tool of
  the vibloom MCP server. A person decides.
<!-- vibloom:end -->
";

// Connects an agent to the guard, changing only the guard's own entries in
// the agent's files. Returns what it did and which files to guard, so the
// agent cannot switch the guard off by editing them.
pub(crate) fn setup_agent(root: &Path, agent: &str) -> Fallible<(Vec<String>, Vec<String>)> {
    match agent {
        "claude" => {
            let settings = root.join(".claude/settings.json");
            let mut v = read_json(&settings)?;
            let ours = hooks_config();
            let mut added = 0;
            for (event, entries) in ours["hooks"].as_object().into_iter().flatten() {
                let list = &mut v["hooks"][event];
                if !list.is_array() {
                    *list = json!([]);
                }
                if !list.to_string().contains("vibloom hook") {
                    for e in entries.as_array().into_iter().flatten() {
                        list.as_array_mut()
                            .into_iter()
                            .for_each(|l| l.push(e.clone()));
                        added += 1;
                    }
                }
            }
            if added > 0 {
                write_json(&settings, &v)?;
            }
            let mcp = root.join(".mcp.json");
            let mut m = read_json(&mcp)?;
            let had = m.pointer("/mcpServers/vibloom").is_some();
            if !had {
                m["mcpServers"]["vibloom"] = json!({ "command": "vibloom", "args": ["mcp"] });
                write_json(&mcp, &m)?;
            }
            Ok((
                vec![
                    if added > 0 {
                        "Claude Code: hooks added to .claude/settings.json.".into()
                    } else {
                        "Claude Code: the hooks were already in .claude/settings.json.".into()
                    },
                    if had {
                        "Claude Code: the vibloom tools were already in .mcp.json.".into()
                    } else {
                        "Claude Code: vibloom tools added to .mcp.json. Approve the server when Claude Code asks.".into()
                    },
                ],
                // The local settings file can switch every hook off.
                vec![
                    ".claude/settings.json".into(),
                    ".claude/settings.local.json".into(),
                    ".mcp.json".into(),
                ],
            ))
        }
        "codex" => {
            let path = root.join("AGENTS.md");
            let text = fs::read_to_string(&path).unwrap_or_default();
            let wrote = !text.contains(AGENTS_START);
            if wrote {
                let sep = if text.is_empty() || text.ends_with("\n\n") {
                    ""
                } else if text.ends_with('\n') {
                    "\n"
                } else {
                    "\n\n"
                };
                write_atomic(&path, &format!("{text}{sep}{AGENTS_SECTION}"))?;
            }
            Ok((
                vec![
                    if wrote {
                        "Codex: instructions added to AGENTS.md.".into()
                    } else {
                        "Codex: AGENTS.md already has the instructions.".into()
                    },
                    "Codex: register the tools once with: codex mcp add vibloom -- vibloom mcp".into(),
                    "Codex has no hooks to stop an edit while it works: the commit check and `vibloom check` in CI are what hold.".into(),
                ],
                // Rewriting the instructions would tell the agent the guard is gone.
                vec!["AGENTS.md".into()],
            ))
        }
        other => Err(format!(
            "Unknown agent {other:?}: use `vibloom setup claude` or `vibloom setup codex`."
        )),
    }
}
