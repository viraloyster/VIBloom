//! The map over MCP (stdio, JSON-RPC 2.0, one message per line), for any client
//! that speaks it. Agents can read the map, run the tests and propose; they
//! cannot accept a proposal, change a state or touch the record.

use crate::cli::{
    append, find_root, iso_now, load_log, load_map, locked, relative_to, run, table, views,
};
use crate::context::context;
use crate::forge::FILTER_FLAGS;
use crate::map::{PROPOSALS_PATH, TestRef};
use crate::proposals::{Book, Draft, propose};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::Path;

const PROTOCOL: &str = "2025-06-18";

const INSTRUCTIONS: &str = "VIBloom keeps this project's assumptions, invariants and intentions, and \
derives from recorded test runs whether each still stands. Call `context` with a file before changing \
it. Call `run` after changing code. A task is not done while any node is BROKEN, UNSUPPORTED, AT RISK \
or pending review. To add an assumption, invariant or intention, call `propose`: a person decides \
whether it enters the map. Never edit protected tests or .vibloom/ to make a check pass.";

fn tools() -> Value {
    let strings = json!({ "type": "array", "items": { "type": "string" } });
    json!([
        { "name": "status", "description": "The derived state of every node in the map.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "context", "description": "What to know before touching a file: full detail for the nodes it touches, one line for the rest.",
          "inputSchema": { "type": "object", "properties": { "file": { "type": "string", "description": "Path of the file, relative to the project or absolute." } } } },
        { "name": "run", "description": "Run the tests, record the run in the log and return the new states. Filters are accepted for forge only.",
          "inputSchema": { "type": "object", "properties": { "filters": {
              "type": "array", "items": { "type": "string" },
              "description": "Flag and value pairs, for example [\"--match-path\", \"test/A.t.sol\"]." } } } },
        { "name": "research", "description": "Start here when asked to find a project's assumptions and invariants: the person's notes, a summary of what the code says, and how to propose with evidence.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "survey", "description": "Foundry projects: the full survey of the named contracts (who may call each function, state, upgrades, calls) and the candidates each leads to, with the lines they come from. Ask for a contract's detail before proposing anything about it.",
          "inputSchema": { "type": "object", "required": ["contracts"], "properties": { "contracts": {
              "type": "array", "items": { "type": "string" }, "minItems": 1,
              "description": "Contract names, as the research summary lists them." } } } },
        { "name": "gaps", "description": "Foundry projects: state-changing functions no test names, and handler functions whose every call reverted.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "verify", "description": "Check the run log's hash chain.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "propose", "description": "Propose an assumption, invariant or intention, with where it comes from. It is kept apart until the verifier accepts it.",
          "inputSchema": { "type": "object", "required": ["kind", "title", "evidence"], "properties": {
              "kind": { "type": "string", "enum": ["assumption", "invariant", "intention"] },
              "title": { "type": "string" },
              "detail": { "type": "string", "description": "Why it matters, or what would show it false." },
              "depends_on": strings.clone(),
              "watch": strings.clone(),
              "evidence": { "type": "array", "items": { "type": "string" },
                  "description": "Where it comes from, one entry each: src/File.sol:120, a document's URL and section, or a chain read with its block." },
              "test": { "type": "object", "required": ["file", "name"], "properties": {
                  "file": { "type": "string" }, "contract": { "type": "string" }, "name": { "type": "string" } } },
              "id": { "type": "string", "description": "Optional short id for the node, like asm.oracle-is-fresh." },
              "by": { "type": "string", "description": "Which agent is proposing." } } } },
        { "name": "proposals", "description": "Proposals nobody has decided on yet.",
          "inputSchema": { "type": "object", "properties": {} } }
    ])
}

// A list of strings, or an error naming the argument: an argument of the
// wrong shape is refused, never read as empty.
fn strings(args: &Value, key: &str) -> Result<Vec<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("{key} must be a list of strings")),
        Some(_) => Err(format!("{key} must be a list of strings")),
    }
}

fn text(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

// What a person reviews should fit on a screen; an agent cannot bury the
// list under one proposal.
const MAX_TITLE: usize = 200;
const MAX_TEXT: usize = 2000;
const MAX_ITEMS: usize = 50;

fn bounded(d: &Draft) -> Result<(), String> {
    let lists = [&d.evidence, &d.depends_on, &d.watch];
    if d.title.chars().count() > MAX_TITLE {
        return Err(format!("title is longer than {MAX_TITLE} characters"));
    }
    if d.detail
        .as_ref()
        .is_some_and(|x| x.chars().count() > MAX_TEXT)
        || lists
            .iter()
            .any(|l| l.iter().any(|x| x.chars().count() > MAX_TEXT / 4))
    {
        return Err(format!(
            "detail is limited to {MAX_TEXT} characters and each list entry to {}",
            MAX_TEXT / 4
        ));
    }
    if lists.iter().any(|l| l.len() > MAX_ITEMS) {
        return Err(format!("each list takes at most {MAX_ITEMS} entries"));
    }
    Ok(())
}

// Only flag/value pairs from forge's test filters: an agent must not be able to
// pass arbitrary arguments to the runner.
fn checked_filters(raw: &[String]) -> Result<Vec<String>, String> {
    if !raw.len().is_multiple_of(2) {
        return Err("filters must be flag and value pairs".into());
    }
    for pair in raw.chunks(2) {
        if !FILTER_FLAGS.contains(&pair[0].as_str()) || pair[1].starts_with('-') {
            return Err(format!(
                "{} is not an allowed filter; use one of {}",
                pair[0],
                FILTER_FLAGS.join(", ")
            ));
        }
    }
    Ok(raw.to_vec())
}

fn call(cwd: &Path, name: &str, args: &Value) -> Result<String, String> {
    let root = find_root(cwd)
        .ok_or("No .vibloom/roots.json in this project. A person runs `vibloom init` first.")?;
    match name {
        "status" => Ok(table(&views(&root)?, load_map(&root)?.strict)),
        "context" => {
            let file = match text(args, "file")? {
                None => None,
                Some(f) => Some(
                    relative_to(&root, cwd, &f)
                        .ok_or_else(|| format!("{f} is outside the project."))?,
                ),
            };
            Ok(context(&views(&root)?, file.as_deref()))
        }
        "gaps" => crate::cli::gaps(&root),
        "research" => crate::cli::research(&root),
        "survey" => {
            let names = strings(args, "contracts")?;
            if names.is_empty() {
                return Err(
                    "contracts must name at least one contract; `research` lists them".into(),
                );
            }
            crate::cli::survey(&root, false, &names)
        }
        "verify" => {
            let log = load_log(&root);
            if log.problems.is_empty() {
                Ok(format!("{} runs, chain intact.", log.entries.len()))
            } else {
                Err(log.problems.join("\n"))
            }
        }
        "run" => {
            let filters = checked_filters(&strings(args, "filters")?)?;
            // Filters are forge's; with another runner only the whole suite runs.
            if !filters.is_empty() && load_map(&root)?.report.is_some() {
                return Err(
                    "filters only apply to forge; this project's runner runs the whole suite"
                        .into(),
                );
            }
            let report = run(&root, &filters)?;
            let mut text = format!(
                "{}\n",
                crate::cli::recorded(&report.entry, &load_map(&root)?)
            );
            if let Some(e) = &report.entry.error {
                text.push_str(&format!("The runner failed: {e}\n"));
            }
            // Only what needs attention: the whole table is one `status` away.
            let bad = crate::hooks::summary(&report.views);
            if bad.is_empty() {
                text.push_str(&format!("All {} nodes are sound.", report.views.len()));
            } else {
                text.push_str(&format!("Needs attention:\n{bad}"));
            }
            Ok(text)
        }
        "propose" => {
            let map = load_map(&root)?;
            if !args.is_object() {
                return Err("the arguments must be an object with kind, title and evidence".into());
            }
            // Living with a known weakness is the verifier's decision, made
            // in the map; no proposal can carry it in.
            if args.get("accepts").is_some() {
                return Err(
                    "accepts cannot be proposed: only the verifier accepts a risk, with `vibloom edit <id> --accept <dep> --reason ...`"
                        .into(),
                );
            }
            let test = match args.get("test") {
                None | Some(Value::Null) => None,
                Some(t) => Some(serde_json::from_value::<TestRef>(t.clone()).map_err(|_| {
                    "test must be an object with a file and a name (and optionally a contract)"
                        .to_string()
                })?),
            };
            let draft = Draft {
                kind: text(args, "kind")?.unwrap_or_default(),
                title: text(args, "title")?.unwrap_or_default(),
                detail: text(args, "detail")?,
                depends_on: strings(args, "depends_on")?,
                watch: strings(args, "watch")?,
                evidence: strings(args, "evidence")?,
                node_id: text(args, "id")?,
                test,
                by: text(args, "by")?,
            };
            bounded(&draft)?;
            // Read and appended under the lock, so two agents never get one id.
            let p = locked(&root, || {
                let book = Book::read(
                    &std::fs::read_to_string(root.join(PROPOSALS_PATH)).unwrap_or_default(),
                );
                let p = propose(&map, &book, draft, iso_now()).map_err(|e| e.join("\n"))?;
                append(
                    &root.join(PROPOSALS_PATH),
                    &format!("{}\n", serde_json::to_string(&p).unwrap_or_default()),
                )?;
                Ok(p)
            })?;
            Ok(format!(
                "Proposed {} ({}): {}. It is hypothetical until the verifier accepts it with `vibloom proposals accept {}`.",
                p.id, p.kind, p.title, p.id
            ))
        }
        "proposals" => {
            let book =
                Book::read(&std::fs::read_to_string(root.join(PROPOSALS_PATH)).unwrap_or_default());
            let pending = book.pending();
            if pending.is_empty() {
                return Ok("No pending proposals.".into());
            }
            Ok(pending
                .iter()
                .map(|p| format!("{}  {}  {}", p.id, p.kind, p.title))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        other => Err(format!("unknown tool {other}")),
    }
}

/// One JSON-RPC message in, at most one out. Notifications get no reply.
pub fn handle(cwd: &Path, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reply = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    let error = |code: i64, message: &str| {
        Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
    };
    id.as_ref()?;
    match method {
        "initialize" => {
            let version = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL);
            reply(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "vibloom", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tools() })),
        "tools/call" => {
            let name = msg
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = msg
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let (text, is_error) = match call(cwd, name, &args) {
                Ok(t) => (t, false),
                Err(e) => (e, true),
            };
            reply(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
        }
        _ => error(-32601, "method not found"),
    }
}

pub fn serve(cwd: &Path) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(cwd, &msg),
            Err(_) => Some(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }),
            ),
        };
        if let Some(r) = response {
            writeln!(stdout, "{r}").map_err(|e| e.to_string())?;
            stdout.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_handshake_and_lists_tools() {
        let dir = std::env::temp_dir();
        let init = handle(&dir, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }))
        .expect("reply");
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "vibloom");
        assert!(
            handle(
                &dir,
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
            )
            .is_none()
        );
        let list = handle(
            &dir,
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .expect("reply");
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "status",
                "context",
                "run",
                "research",
                "survey",
                "gaps",
                "verify",
                "propose",
                "proposals"
            ]
        );
        let unknown = handle(
            &dir,
            &json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" }),
        )
        .expect("reply");
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn accepts_only_test_filters_for_runs() {
        let ok =
            |v: &[&str]| checked_filters(&v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
        assert!(ok(&["--match-path", "test/A.t.sol"]).is_ok());
        assert!(ok(&["--fork-url", "http://x"]).is_err());
        assert!(ok(&["--mt", "--ffi"]).is_err());
        assert!(ok(&["--mt"]).is_err());
    }
}
