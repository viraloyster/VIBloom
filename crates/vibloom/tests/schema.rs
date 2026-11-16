//! Keeps the published JSON Schemas (schema/) and the code from drifting: the
//! keys and enums of the map schema are the ones map.rs accepts, the example
//! maps and every map the code writes validate, both reject the same broken
//! maps, and what `status --json` and `diff --json` print validates.
//!
//! The validator covers the subset of JSON Schema 2020-12 the files use, and
//! panics on any other keyword, so the schemas cannot quietly grow past it.

use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use vibloom::map::{
    ACCEPT_KEYS, CHECK_KEYS, KINDS, MAP_KEYS, NODE_KEYS, STANCES, TEST_KEYS, TOOLS, parse_map,
    serialize_map,
};

const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

fn schema(name: &str) -> Value {
    let text = fs::read_to_string(format!("{REPO}/schema/{name}.v1.schema.json")).expect("schema");
    serde_json::from_str(&text).expect("json")
}

const KEYWORDS: [&str; 20] = [
    "$schema",
    "$id",
    "$defs",
    "$ref",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "pattern",
    "minItems",
    "minLength",
    "minimum",
    "exclusiveMinimum",
    "if",
    "then",
];

fn type_ok(t: &str, v: &Value) -> bool {
    match t {
        "object" => v.is_object(),
        "array" => v.is_array(),
        "string" => v.is_string(),
        "boolean" => v.is_boolean(),
        "null" => v.is_null(),
        "integer" => v.is_i64() || v.is_u64(),
        "number" => v.is_number(),
        other => panic!("unknown type {other}"),
    }
}

/// `strict` also refuses keys a schema does not declare where it leaves
/// objects open, so the output's every key is documented.
fn check(s: &Value, v: &Value, root: &Value, strict: bool, at: &str, errors: &mut Vec<String>) {
    let Some(s) = s.as_object() else {
        panic!("{at}: a schema must be an object")
    };
    for k in s.keys() {
        assert!(
            KEYWORDS.contains(&k.as_str()),
            "{at}: unsupported keyword {k}"
        );
    }
    if let Some(r) = s.get("$ref").and_then(Value::as_str) {
        let name = r.strip_prefix("#/$defs/").expect("local $ref");
        check(&root["$defs"][name], v, root, strict, at, errors);
    }
    if let Some(t) = s.get("type") {
        let ok = match t {
            Value::String(t) => type_ok(t, v),
            Value::Array(ts) => ts.iter().any(|t| type_ok(t.as_str().expect("type"), v)),
            _ => panic!("{at}: bad type"),
        };
        if !ok {
            errors.push(format!("{at}: not of type {t}"));
            return;
        }
    }
    if let Some(c) = s.get("const")
        && c != v
    {
        errors.push(format!("{at}: must be {c}"));
    }
    if let Some(e) = s.get("enum").and_then(Value::as_array)
        && !e.contains(v)
    {
        errors.push(format!(
            "{at}: {v} is not one of {}",
            Value::from(e.clone())
        ));
    }
    if let Some(text) = v.as_str() {
        if let Some(p) = s.get("pattern").and_then(Value::as_str)
            && !regex::Regex::new(p).expect("pattern").is_match(text)
        {
            errors.push(format!("{at}: {text:?} does not match {p}"));
        }
        if let Some(n) = s.get("minLength").and_then(Value::as_u64)
            && (text.chars().count() as u64) < n
        {
            errors.push(format!("{at}: shorter than {n}"));
        }
    }
    if let Some(n) = v.as_f64() {
        if let Some(m) = s.get("minimum").and_then(Value::as_f64)
            && n < m
        {
            errors.push(format!("{at}: below {m}"));
        }
        if let Some(m) = s.get("exclusiveMinimum").and_then(Value::as_f64)
            && n <= m
        {
            errors.push(format!("{at}: not above {m}"));
        }
    }
    if let Some(items) = v.as_array() {
        if let Some(n) = s.get("minItems").and_then(Value::as_u64)
            && (items.len() as u64) < n
        {
            errors.push(format!("{at}: fewer than {n} items"));
        }
        if let Some(each) = s.get("items") {
            for (i, x) in items.iter().enumerate() {
                check(each, x, root, strict, &format!("{at}[{i}]"), errors);
            }
        }
    }
    if let Some(o) = v.as_object() {
        let props = s.get("properties").and_then(Value::as_object);
        for r in s
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let r = r.as_str().expect("required");
            if !o.contains_key(r) {
                errors.push(format!("{at}: {r} is required"));
            }
        }
        let closed = strict || s.get("additionalProperties") == Some(&Value::Bool(false));
        for (k, x) in o {
            match props.and_then(|p| p.get(k)) {
                Some(ps) => check(ps, x, root, strict, &format!("{at}.{k}"), errors),
                None if closed && props.is_some() => errors.push(format!("{at}: unknown key {k}")),
                None => {}
            }
        }
    }
    if let Some(cond) = s.get("if") {
        let mut probe = vec![];
        check(cond, v, root, strict, at, &mut probe);
        if probe.is_empty()
            && let Some(then) = s.get("then")
        {
            check(then, v, root, strict, at, errors);
        }
    }
}

fn validate(name: &str, v: &Value, strict: bool) -> Vec<String> {
    let s = schema(name);
    let mut errors = vec![];
    check(&s, v, &s, strict, "$", &mut errors);
    errors
}

fn keys(s: &Value) -> BTreeSet<String> {
    s["properties"]
        .as_object()
        .expect("properties")
        .keys()
        .cloned()
        .collect()
}

fn set(v: &[&str]) -> BTreeSet<String> {
    v.iter().map(|s| (*s).to_string()).collect()
}

fn enum_of(s: &Value) -> BTreeSet<String> {
    s["enum"]
        .as_array()
        .expect("enum")
        .iter()
        .map(|x| x.as_str().expect("text").to_string())
        .collect()
}

#[test]
fn the_map_schema_names_exactly_what_map_rs_accepts() {
    let s = schema("roots");
    let defs = &s["$defs"];
    assert_eq!(keys(&s), set(&MAP_KEYS));
    assert_eq!(keys(&defs["node"]), set(&NODE_KEYS));
    assert_eq!(keys(&defs["test"]), set(&TEST_KEYS));
    assert_eq!(keys(&defs["accept"]), set(&ACCEPT_KEYS));
    assert_eq!(keys(&defs["check"]), set(&CHECK_KEYS));
    for closed in [
        &s,
        &defs["node"],
        &defs["test"],
        &defs["accept"],
        &defs["check"],
    ] {
        assert_eq!(closed["additionalProperties"], json!(false));
    }
    assert_eq!(enum_of(&defs["node"]["properties"]["kind"]), set(&KINDS));
    assert_eq!(
        enum_of(&defs["node"]["properties"]["stance"]),
        set(&STANCES)
    );
    assert_eq!(enum_of(&defs["test"]["properties"]["tool"]), set(&TOOLS));
    assert_eq!(enum_of(&defs["check"]["properties"]["tool"]), set(&TOOLS));
}

#[test]
fn the_example_maps_validate() {
    for ex in ["foundry-vault", "pytest-ledger"] {
        let text =
            fs::read_to_string(format!("{REPO}/examples/{ex}/.vibloom/roots.json")).expect("map");
        let v: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(validate("roots", &v, false), Vec::<String>::new(), "{ex}");
        assert!(parse_map(&v).is_ok(), "{ex}");
    }
}

fn full_map() -> Value {
    json!({
        "$schema": "https://raw.githubusercontent.com/viraloyster/VIBloom/main/schema/roots.v1.schema.json",
        "version": 1,
        "runner": ["forge", "test", "--json"],
        "report": "out/junit.xml",
        "timeout": 600,
        "tests": "test/",
        "protect": ["foundry.toml", "test/handlers/"],
        "strict": true,
        "ignore_failures": ["Legacy*"],
        "checks": [
            { "tool": "halmos", "report": "out/halmos.json", "command": ["halmos", "--json-output", "out/halmos.json"] },
            { "tool": "echidna", "report": "out/echidna.json" },
            { "tool": "junit", "report": ".pytest_cache/j.xml", "command": ["pytest", "--junitxml=.pytest_cache/j.xml"] }
        ],
        "nodes": [
            { "id": "inv.sum", "kind": "invariant", "title": "sum", "detail": "why", "stance": "adopted",
              "test": { "tool": "halmos", "file": "test/S.t.sol", "contract": "S", "name": "check_sum" },
              "watch": ["src/", "...odd/name.sol"], "depends_on": ["asm.off"], "protected": true,
              "evidence": ["src/S.sol:3"], "accepts": [{ "id": "asm.off", "reason": "known" }] },
            { "id": "asm.off", "kind": "assumption", "title": "off", "stance": "off" }
        ]
    })
}

#[test]
fn every_map_the_code_writes_validates() {
    let m = parse_map(&full_map()).expect("valid");
    let written: Value = serde_json::from_str(&serialize_map(&m)).expect("json");
    assert_eq!(validate("roots", &written, false), Vec::<String>::new());
    assert_eq!(validate("roots", &full_map(), false), Vec::<String>::new());
}

#[test]
fn the_schema_and_the_code_reject_the_same_broken_maps() {
    type Edit = Box<dyn Fn(&mut Value)>;
    let broken: Vec<(&str, Edit)> = vec![
        ("unknown key", Box::new(|m| m["wtach"] = json!([]))),
        (
            "unknown node key",
            Box::new(|m| m["nodes"][1]["wtach"] = json!([])),
        ),
        (
            "unknown test key",
            Box::new(|m| m["nodes"][0]["test"]["args"] = json!(1)),
        ),
        (
            "unknown check key",
            Box::new(|m| m["checks"][0]["args"] = json!([])),
        ),
        ("version 2", Box::new(|m| m["version"] = json!(2))),
        (
            "no nodes",
            Box::new(|m| {
                m.as_object_mut().expect("o").remove("nodes");
            }),
        ),
        ("empty runner", Box::new(|m| m["runner"] = json!([]))),
        ("zero timeout", Box::new(|m| m["timeout"] = json!(0))),
        (
            "absolute report",
            Box::new(|m| m["report"] = json!("/tmp/j.xml")),
        ),
        (
            "dot segment",
            Box::new(|m| m["protect"] = json!(["./foundry.toml"])),
        ),
        (
            "climbing path",
            Box::new(|m| m["nodes"][0]["watch"] = json!(["../x"])),
        ),
        ("double slash", Box::new(|m| m["tests"] = json!("test//"))),
        (
            "backslash",
            Box::new(|m| m["nodes"][0]["test"]["file"] = json!("test\\S.t.sol")),
        ),
        (
            "bad id",
            Box::new(|m| m["nodes"][1]["id"] = json!("Asm.Off")),
        ),
        (
            "bad kind",
            Box::new(|m| m["nodes"][1]["kind"] = json!("goal")),
        ),
        (
            "bad stance",
            Box::new(|m| m["nodes"][1]["stance"] = json!("maybe")),
        ),
        (
            "two-line title",
            Box::new(|m| m["nodes"][1]["title"] = json!("a\nb")),
        ),
        (
            "blank title",
            Box::new(|m| m["nodes"][1]["title"] = json!("  ")),
        ),
        (
            "invariant without test",
            Box::new(|m| {
                m["nodes"][0].as_object_mut().expect("o").remove("test");
            }),
        ),
        (
            "unknown tool",
            Box::new(|m| m["checks"][0]["tool"] = json!("medusa")),
        ),
        (
            "empty command",
            Box::new(|m| m["checks"][0]["command"] = json!([])),
        ),
        (
            "reason without text",
            Box::new(|m| m["nodes"][0]["accepts"][0]["reason"] = json!(" ")),
        ),
        (
            "protected as text",
            Box::new(|m| m["nodes"][0]["protected"] = json!("yes")),
        ),
        (
            "blank ignore pattern",
            Box::new(|m| m["ignore_failures"] = json!([" "])),
        ),
    ];
    for (what, edit) in broken {
        let mut m = full_map();
        edit(&mut m);
        assert!(
            !validate("roots", &m, false).is_empty(),
            "the schema accepts: {what}"
        );
        assert!(parse_map(&m).is_err(), "the code accepts: {what}");
    }
}

// The real binary, as a person, on a throwaway project with a fake runner.
fn run(dir: &Path, args: &[&str]) -> (i32, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_vibloom"));
    for v in [
        "VIBLOOM_ROLE",
        "CLAUDECODE",
        "CODEX_THREAD_ID",
        "CODEX_SANDBOX",
        "CURSOR_AGENT",
        "GEMINI_CLI",
    ] {
        cmd.env_remove(v);
    }
    let o = cmd.args(args).current_dir(dir).output().expect("run");
    (
        o.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&o.stdout).trim().to_string(),
    )
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git")
        .status
        .success();
    assert!(ok, "git {args:?}");
}

fn project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vibloom-schema-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).expect("dir");
    fs::create_dir_all(dir.join("test")).expect("dir");
    fs::create_dir_all(dir.join(".vibloom")).expect("dir");
    fs::write(dir.join("src/C.sol"), "contract C {}").expect("write");
    fs::write(dir.join("test/C.t.sol"), "contract CT {}").expect("write");
    fs::write(
        dir.join("runner.sh"),
        "printf '{\"test/C.t.sol:CT\":{\"test_results\":{\"invariant_sum()\":{\"status\":\"Success\",\"reason\":null,\"kind\":{\"Invariant\":{\"runs\":64,\"calls\":2048,\"reverts\":3,\"metrics\":{}}}},\"test_x()\":{\"status\":\"Failure\",\"reason\":\"no\"}}}}\\n'\n",
    )
    .expect("write");
    fs::create_dir_all(dir.join("out")).expect("dir");
    fs::write(
        dir.join("halmos.saved"),
        r#"{"test_results":{"test/C.t.sol:CT":[{"name":"check_sym()","exitcode":2}]}}"#,
    )
    .expect("write");
    let map = json!({
        "version": 1,
        "runner": ["sh", "runner.sh"],
        "checks": [{ "tool": "halmos", "report": "out/halmos.json", "command": ["cp", "halmos.saved", "out/halmos.json"] }],
        "nodes": [
            { "id": "inv.sum", "kind": "invariant", "title": "sum",
              "test": { "file": "test/C.t.sol", "contract": "CT", "name": "invariant_sum" }, "watch": ["src/"] },
            { "id": "inv.sym", "kind": "invariant", "title": "sym",
              "test": { "tool": "halmos", "file": "test/C.t.sol", "contract": "CT", "name": "check_sym" } },
            { "id": "asm.a", "kind": "assumption", "title": "a" },
            { "id": "asm.off", "kind": "assumption", "title": "off", "stance": "off" },
            { "id": "int.i", "kind": "intention", "title": "i", "depends_on": ["inv.sum", "asm.a", "asm.off"],
              "accepts": [{ "id": "asm.off", "reason": "known" }] }
        ]
    });
    fs::write(dir.join(".vibloom/roots.json"), map.to_string()).expect("write");
    dir
}

#[test]
fn status_and_check_output_validates() {
    let dir = project("status");
    git(&dir, &["init", "-q"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "base"]);
    for args in [
        &["check", "--json", "--base", "HEAD"][..],
        &["status", "--json"][..],
        &["status", "--json", "--strict"][..],
    ] {
        let (_, out) = run(&dir, args);
        let v: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(
            validate("status", &v, true),
            Vec::<String>::new(),
            "{args:?}: {out}"
        );
        assert!(v["nodes"].as_array().is_some_and(|n| n.len() == 5), "{out}");
    }
    let (_, out) = run(&dir, &["status", "--json"]);
    assert!(out.contains(r#""shown":"fuzzed 64x32""#), "{out}");
    // A run that fails, and no map at all: the JSON keeps its shape.
    fs::write(dir.join("runner.sh"), "exit 3\n").expect("write");
    let (code, out) = run(&dir, &["check", "--json"]);
    assert_eq!(code, 2);
    let v: Value = serde_json::from_str(&out).expect("json");
    assert_eq!(validate("status", &v, true), Vec::<String>::new());
    let empty = std::env::temp_dir().join(format!("vibloom-schema-{}-none", std::process::id()));
    fs::create_dir_all(&empty).expect("dir");
    let (code, out) = run(&empty, &["status", "--json"]);
    assert_eq!(code, 2);
    let v: Value = serde_json::from_str(&out).expect("json");
    assert_eq!(validate("status", &v, true), Vec::<String>::new());
}

#[test]
fn diff_output_validates() {
    let dir = project("diff");
    git(&dir, &["init", "-q"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "audited"]);
    let (code, out) = run(&dir, &["diff", "HEAD", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(
        validate("diff", &serde_json::from_str(&out).expect("json"), true),
        Vec::<String>::new()
    );
    fs::write(dir.join("src/C.sol"), "contract C { uint x; }").expect("write");
    fs::write(dir.join("test/C.t.sol"), "contract CT { }").expect("write");
    let map = dir.join(".vibloom/roots.json");
    let mut m: Value = serde_json::from_str(&fs::read_to_string(&map).expect("map")).expect("json");
    m["nodes"][0]["protected"] = json!(false);
    m["nodes"][2]["stance"] = json!("off");
    m["nodes"]
        .as_array_mut()
        .expect("nodes")
        .push(json!({ "id": "asm.new", "kind": "assumption", "title": "new" }));
    m["checks"] = json!([]);
    m["nodes"].as_array_mut().expect("nodes").remove(1);
    fs::write(&map, m.to_string()).expect("write");
    let (code, out) = run(&dir, &["diff", "HEAD", "--json"]);
    assert_eq!(code, 1, "{out}");
    let v: Value = serde_json::from_str(&out).expect("json");
    assert_eq!(validate("diff", &v, true), Vec::<String>::new(), "{out}");
    assert_eq!(
        v["summary"],
        json!({ "removed": 1, "weakened": 2, "guard": 2, "changed": 0, "added": 1 }),
        "{out}"
    );
}
