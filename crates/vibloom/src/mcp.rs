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
        { "name": "verify", "description": "Check the run log's hash chain.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "propose", "description": "Propose an assumption, invariant or intention. It is kept apart as hypothetical until a person accepts it.",
          "inputSchema": { "type": "object", "required": ["kind", "title"], "properties": {
              "kind": { "type": "string", "enum": ["assumption", "invariant", "intention"] },
              "title": { "type": "string" },
              "detail": { "type": "string", "description": "Why it matters, or what would show it false." },
              "depends_on": strings.clone(),
              "watch": strings,
              "test": { "type": "object", "required": ["file", "name"], "properties": {
                  "file": { "type": "string" }, "contract": { "type": "string" }, "name": { "type": "string" } } },
              "by": { "type": "string", "description": "Which agent is proposing." } } } },
        { "name": "proposals", "description": "Proposals nobody has decided on yet.",
          "inputSchema": { "type": "object", "properties": {} } }
    ])
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
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
        "status" => Ok(table(&views(&root)?)),
        "context" => {
            let file = args
                .get("file")
                .and_then(Value::as_str)
                .and_then(|f| relative_to(&root, cwd, f));
            Ok(context(&views(&root)?, file.as_deref()))
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
            let filters = checked_filters(&strings(args.get("filters")))?;
            // Filters are forge's; with another runner only the whole suite runs.
            if !filters.is_empty() && load_map(&root)?.report.is_some() {
                return Err(
                    "filters only apply to forge; this project's runner runs the whole suite"
                        .into(),
                );
            }
            let report = run(&root, &filters)?;
            let mut text = format!(
                "Run {}: {} test results recorded.\n",
                report.entry.seq,
                report.entry.outcomes.len()
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
            let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
            let test = args
                .get("test")
                .and_then(|t| serde_json::from_value::<TestRef>(t.clone()).ok());
            let draft = Draft {
                kind: s("kind").unwrap_or_default(),
                title: s("title").unwrap_or_default(),
                detail: s("detail"),
                depends_on: strings(args.get("depends_on")),
                watch: strings(args.get("watch")),
                test,
                by: s("by"),
            };
            // Read and appended under the lock, so two agents never get one id.
            let p = locked(&root, || {
                let book = Book::read(
                    &std::fs::read_to_string(root.join(PROPOSALS_PATH)).unwrap_or_default(),
                );
                let p = propose(&map, &book, draft, iso_now()).map_err(|e| e.join("\n"))?;
                append(
                    &root,
                    PROPOSALS_PATH,
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
            vec!["status", "context", "run", "verify", "propose", "proposals"]
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
