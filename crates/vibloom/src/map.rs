//! The roots of a code project: what it assumes, what must always hold and what
//! each change intends. People and verifier agents write this file; the guard
//! only reads it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const MAP_PATH: &str = ".vibloom/roots.json";
pub const LOG_PATH: &str = ".vibloom/log.jsonl";
pub const PROPOSALS_PATH: &str = ".vibloom/proposals.jsonl";
pub const DEFAULT_RUNNER: [&str; 3] = ["forge", "test", "--json"];
pub const DEFAULT_TIMEOUT: u64 = 3600;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Assumption,
    Invariant,
    Intention,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "assumption" => Some(Self::Assumption),
            "invariant" => Some(Self::Invariant),
            "intention" => Some(Self::Intention),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Assumption => "assumption",
            Self::Invariant => "invariant",
            Self::Intention => "intention",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stance {
    Adopted,
    Hypothetical,
    Off,
}

impl Stance {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "adopted" => Some(Self::Adopted),
            "hypothetical" => Some(Self::Hypothetical),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Adopted => "adopted",
            Self::Hypothetical => "hypothetical",
            Self::Off => "off",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestRef {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootNode {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub detail: Option<String>,
    pub stance: Stance,
    pub test: Option<TestRef>,
    /// Files, or directories ending in "/", whose change puts the node's
    /// evidence up for review.
    pub watch: Vec<String>,
    pub depends_on: Vec<String>,
    /// A protected node's test may only be edited by the verifier role.
    pub protected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootsMap {
    pub runner: Vec<String>,
    /// Where the runner writes a JUnit XML report; without it, the runner's
    /// output is read as `forge test --json`.
    pub report: Option<String>,
    /// Seconds a run may take before it is stopped and recorded as an error.
    pub timeout: u64,
    pub tests: String,
    /// Paths only the verifier may edit, besides protected tests and .vibloom/.
    pub protect: Vec<String>,
    pub nodes: Vec<RootNode>,
}

impl RootsMap {
    pub fn empty() -> Self {
        Self {
            runner: DEFAULT_RUNNER.iter().map(|s| (*s).to_string()).collect(),
            report: None,
            timeout: DEFAULT_TIMEOUT,
            tests: "test/".into(),
            protect: vec![],
            nodes: vec![],
        }
    }
}

const ID_PATTERN: &str = "/^[a-z0-9][a-z0-9._-]*$/";

pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// A repository-relative path that cannot climb out of the repository.
/// A Solidity signature loses its parameters ("invariant_a()" -> "invariant_a");
/// any other name, such as a Jest description with parentheses, is kept whole.
pub fn test_name(name: &str) -> String {
    match name.split_once('(') {
        Some((head, _))
            if name.ends_with(')')
                && head
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') =>
        {
            head.to_string()
        }
        _ => name.to_string(),
    }
}

pub fn safe_path(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.split('/').any(|s| s == "..") && !p.contains('\\')
}

// A key the guard does not know is a mistake to report, not to ignore: a
// mistyped "watch" would leave a node watching nothing.
fn unknown_keys(
    obj: &serde_json::Map<String, Value>,
    known: &[&str],
    at: &str,
    errors: &mut Vec<String>,
) {
    for k in obj.keys() {
        if !known.contains(&k.as_str()) {
            errors.push(format!(
                "{at}: unknown key \"{k}\" (known: {})",
                known.join(", ")
            ));
        }
    }
}

fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array()?
        .iter()
        .map(|x| x.as_str().map(str::to_string))
        .collect()
}

fn paths(v: Option<&Value>) -> Option<Vec<String>> {
    match v {
        None => Some(vec![]),
        Some(v) => strings(v).filter(|ps| ps.iter().all(|p| safe_path(p))),
    }
}

pub fn parse_map(raw: &Value) -> Result<RootsMap, Vec<String>> {
    let mut errors = Vec::new();
    let Some(obj) = raw.as_object() else {
        return Err(vec!["the map must be a JSON object".into()]);
    };
    unknown_keys(
        obj,
        &[
            "version", "runner", "report", "timeout", "tests", "protect", "nodes",
        ],
        "the map",
        &mut errors,
    );
    if obj.get("version") != Some(&Value::from(1)) {
        errors.push("version must be 1".into());
    }
    let runner = match obj.get("runner") {
        None => Some(DEFAULT_RUNNER.iter().map(|s| (*s).to_string()).collect()),
        Some(v) => strings(v).filter(|r| !r.is_empty()),
    };
    if runner.is_none() {
        errors.push("runner must be a non-empty string list".into());
    }
    let report = match obj.get("report") {
        None => Some(None),
        Some(v) => v
            .as_str()
            .filter(|s| safe_path(s))
            .map(|s| Some(s.to_string())),
    };
    if report.is_none() {
        errors.push("report must be a relative path".into());
    }
    let timeout = match obj.get("timeout") {
        None => Some(DEFAULT_TIMEOUT),
        Some(v) => v.as_u64().filter(|t| *t > 0),
    };
    if timeout.is_none() {
        errors.push("timeout must be a number of seconds above 0".into());
    }
    let tests = match obj.get("tests") {
        None => Some("test/".to_string()),
        Some(v) => v.as_str().filter(|s| safe_path(s)).map(str::to_string),
    };
    if tests.is_none() {
        errors.push("tests must be a relative path".into());
    }
    let protect = paths(obj.get("protect"));
    if protect.is_none() {
        errors.push("protect must list relative paths".into());
    }
    let raw_nodes = obj.get("nodes").and_then(Value::as_array);
    if raw_nodes.is_none() {
        errors.push("nodes must be a list".into());
    }

    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (i, n) in raw_nodes.into_iter().flatten().enumerate() {
        let at = format!("nodes[{i}]");
        let Some(n) = n.as_object() else {
            errors.push(format!("{at} must be an object"));
            continue;
        };
        let Some(id) = n
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
        else {
            errors.push(format!("{at}.id must match {ID_PATTERN}"));
            continue;
        };
        if !seen.insert(id.to_string()) {
            errors.push(format!("{id}: duplicate id"));
        }
        unknown_keys(
            n,
            &[
                "id",
                "kind",
                "title",
                "detail",
                "stance",
                "test",
                "watch",
                "depends_on",
                "protected",
            ],
            id,
            &mut errors,
        );
        if let Some(t) = n.get("test").and_then(Value::as_object) {
            unknown_keys(
                t,
                &["file", "contract", "name"],
                &format!("{id}.test"),
                &mut errors,
            );
        }
        let Some(kind) = n.get("kind").and_then(Value::as_str).and_then(Kind::parse) else {
            errors.push(format!(
                "{id}: kind must be one of assumption, invariant, intention"
            ));
            continue;
        };
        let title = n.get("title").and_then(Value::as_str).unwrap_or_default();
        if title.trim().is_empty() {
            errors.push(format!("{id}: title is required"));
        }
        let detail = match n.get("detail") {
            None => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                errors.push(format!("{id}: detail must be text"));
                None
            }
        };
        let stance = match n.get("stance") {
            None if kind == Kind::Assumption => Some(Stance::Hypothetical),
            None => Some(Stance::Adopted),
            Some(v) => v.as_str().and_then(Stance::parse),
        };
        if stance.is_none() {
            errors.push(format!(
                "{id}: stance must be one of adopted, hypothetical, off"
            ));
        }
        let watch = paths(n.get("watch"));
        if watch.is_none() {
            errors.push(format!("{id}: watch must list relative paths"));
        }
        let depends_on = match n.get("depends_on") {
            None => Some(vec![]),
            Some(v) => strings(v),
        };
        if depends_on.is_none() {
            errors.push(format!("{id}: depends_on must list ids"));
        }
        let test = match n.get("test") {
            None => None,
            Some(t) => {
                let file = t
                    .get("file")
                    .and_then(Value::as_str)
                    .filter(|f| safe_path(f));
                let name = t.get("name").and_then(Value::as_str);
                let contract = t.get("contract");
                let contract_ok = contract.is_none_or(Value::is_string);
                match (file, name, t.is_object() && contract_ok) {
                    (Some(file), Some(name), true) => Some(TestRef {
                        file: file.into(),
                        contract: contract.and_then(Value::as_str).map(str::to_string),
                        name: test_name(name),
                    }),
                    _ => {
                        errors.push(format!("{id}: test needs a relative file and a name"));
                        None
                    }
                }
            }
        };
        if kind == Kind::Invariant && test.is_none() {
            errors.push(format!("{id}: an invariant needs a test"));
        }
        let protected = match n.get("protected") {
            None => kind == Kind::Invariant,
            Some(Value::Bool(b)) => *b,
            Some(_) => {
                errors.push(format!("{id}: protected must be true or false"));
                false
            }
        };
        nodes.push(RootNode {
            id: id.into(),
            kind,
            title: title.into(),
            detail,
            stance: stance.unwrap_or(Stance::Adopted),
            test,
            watch: watch.unwrap_or_default(),
            depends_on: depends_on.unwrap_or_default(),
            protected,
        });
    }

    for n in &nodes {
        for d in &n.depends_on {
            if !seen.contains(d) {
                errors.push(format!("{}: depends on unknown {d}", n.id));
            }
            if d == &n.id {
                errors.push(format!("{}: depends on itself", n.id));
            }
        }
    }
    if let Some(cycle) = find_cycle(&nodes) {
        errors.push(format!("dependency cycle: {}", cycle.join(" -> ")));
    }

    match (errors.is_empty(), runner, report, tests, protect) {
        (true, Some(runner), Some(report), Some(tests), Some(protect)) => Ok(RootsMap {
            runner,
            report,
            timeout: timeout.unwrap_or(DEFAULT_TIMEOUT),
            tests,
            protect,
            nodes,
        }),
        _ => Err(errors),
    }
}

fn find_cycle(nodes: &[RootNode]) -> Option<Vec<String>> {
    let deps: HashMap<&str, &[String]> = nodes
        .iter()
        .map(|n| (n.id.as_str(), n.depends_on.as_slice()))
        .collect();
    #[derive(PartialEq)]
    enum Mark {
        Open,
        Done,
    }
    fn visit<'a>(
        id: &'a str,
        deps: &HashMap<&'a str, &'a [String]>,
        state: &mut HashMap<&'a str, Mark>,
        path: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        match state.get(id) {
            Some(Mark::Done) => return None,
            Some(Mark::Open) => {
                let start = path.iter().position(|p| *p == id).unwrap_or(0);
                let mut c: Vec<String> = path[start..].iter().map(|s| (*s).to_string()).collect();
                c.push(id.to_string());
                return Some(c);
            }
            None => {}
        }
        state.insert(id, Mark::Open);
        path.push(id);
        for d in deps.get(id).copied().unwrap_or_default() {
            if let Some(c) = visit(d, deps, state, path) {
                return Some(c);
            }
        }
        path.pop();
        state.insert(id, Mark::Done);
        None
    }
    let mut state = HashMap::new();
    let mut path = Vec::new();
    nodes
        .iter()
        .find_map(|n| visit(&n.id, &deps, &mut state, &mut path))
}

#[derive(Serialize)]
struct NodeOut<'a> {
    id: &'a str,
    kind: Kind,
    title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    stance: Stance,
    #[serde(skip_serializing_if = "Option::is_none")]
    test: Option<&'a TestRef>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    watch: &'a [String],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    depends_on: &'a [String],
    protected: bool,
}

#[derive(Serialize)]
struct MapOut<'a> {
    version: u8,
    runner: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timeout: Option<u64>,
    tests: &'a str,
    protect: &'a [String],
    nodes: Vec<NodeOut<'a>>,
}

/// The map as written to disk: snake_case keys, defaults left out.
pub fn serialize_map(map: &RootsMap) -> String {
    let out = MapOut {
        version: 1,
        runner: &map.runner,
        report: map.report.as_deref(),
        timeout: (map.timeout != DEFAULT_TIMEOUT).then_some(map.timeout),
        tests: &map.tests,
        protect: &map.protect,
        nodes: map
            .nodes
            .iter()
            .map(|n| NodeOut {
                id: &n.id,
                kind: n.kind,
                title: &n.title,
                detail: n.detail.as_deref().filter(|d| !d.is_empty()),
                stance: n.stance,
                test: n.test.as_ref(),
                watch: &n.watch,
                depends_on: &n.depends_on,
                protected: n.protected,
            })
            .collect(),
    };
    let mut s = serde_json::to_string_pretty(&out).unwrap_or_default();
    s.push('\n');
    s
}

/// Every path a node's evidence depends on: what it watches and its test file.
pub fn watched_by(n: &RootNode) -> Vec<String> {
    let mut w = n.watch.clone();
    if let Some(t) = &n.test
        && !w.contains(&t.file)
    {
        w.push(t.file.clone());
    }
    w
}

pub fn covers(watch: &str, file: &str) -> bool {
    if watch.ends_with('/') {
        file.starts_with(watch)
    } else {
        file == watch
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inv(id: &str, extra: Value) -> Value {
        let mut v = json!({
            "id": id,
            "kind": "invariant",
            "title": id,
            "test": { "file": "test/A.t.sol", "name": format!("invariant_{}()", id.replace(['.', '-'], "_")) },
        });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in e {
                o.insert(k.clone(), x.clone());
            }
        }
        v
    }

    #[test]
    fn fills_defaults() {
        let m = parse_map(&json!({
            "version": 1,
            "nodes": [inv("inv.a", json!({})), { "id": "asm.b", "kind": "assumption", "title": "b", "depends_on": ["inv.a"] }]
        }))
        .expect("valid");
        assert_eq!(m.nodes[0].stance, Stance::Adopted);
        assert!(m.nodes[0].protected);
        assert_eq!(
            m.nodes[0].test.as_ref().map(|t| t.name.as_str()),
            Some("invariant_inv_a")
        );
        assert_eq!(m.nodes[1].stance, Stance::Hypothetical);
        assert!(!m.nodes[1].protected);
        assert_eq!(m.runner, vec!["forge", "test", "--json"]);
    }

    #[test]
    fn rejects_unknown_dependencies_and_duplicate_ids() {
        let e = parse_map(&json!({
            "version": 1,
            "nodes": [inv("inv.a", json!({})), inv("inv.a", json!({})), { "id": "asm.d", "kind": "assumption", "title": "d", "depends_on": ["nope"] }]
        }))
        .expect_err("invalid");
        assert_eq!(
            e,
            vec!["inv.a: duplicate id", "asm.d: depends on unknown nope"]
        );
    }

    #[test]
    fn rejects_a_cycle() {
        let e = parse_map(&json!({
            "version": 1,
            "nodes": [inv("inv.a", json!({ "depends_on": ["asm.c"] })), { "id": "asm.c", "kind": "assumption", "title": "c", "depends_on": ["inv.a"] }]
        }))
        .expect_err("invalid");
        assert_eq!(e, vec!["dependency cycle: inv.a -> asm.c -> inv.a"]);
    }

    #[test]
    fn rejects_escaping_paths_and_invariants_without_a_test() {
        let e = parse_map(&json!({
            "version": 1,
            "nodes": [
                { "id": "inv.x", "kind": "invariant", "title": "x" },
                { "id": "asm.y", "kind": "assumption", "title": "y", "watch": ["../secret"] },
                { "id": "asm.z", "kind": "assumption", "title": "z", "watch": ["/etc/passwd"] }
            ]
        }))
        .expect_err("invalid");
        for want in [
            "inv.x: an invariant needs a test",
            "asm.y: watch must list relative paths",
            "asm.z: watch must list relative paths",
        ] {
            assert!(e.iter().any(|x| x == want), "missing {want}: {e:?}");
        }
    }

    #[test]
    fn round_trips() {
        let first = parse_map(&json!({
            "version": 1,
            "protect": ["foundry.toml"],
            "report": "target/nextest/ci/junit.xml",
            "nodes": [inv("inv.a", json!({ "watch": ["src/"], "detail": "why" }))]
        }))
        .expect("valid");
        let again: Value = serde_json::from_str(&serialize_map(&first)).expect("json");
        assert_eq!(parse_map(&again).expect("valid"), first);
    }

    #[test]
    fn keeps_the_report_inside_the_project() {
        let e = parse_map(&json!({ "version": 1, "report": "/tmp/junit.xml", "nodes": [] }))
            .expect_err("outside the project");
        assert_eq!(e, vec!["report must be a relative path"]);
        let m = parse_map(&json!({ "version": 1, "nodes": [] })).expect("valid");
        assert!(m.report.is_none());
        assert!(!serialize_map(&m).contains("report"));
    }

    #[test]
    fn strips_a_solidity_signature_and_keeps_other_names() {
        assert_eq!(test_name("invariant_sum()"), "invariant_sum");
        assert_eq!(test_name("invariant_sum(uint256)"), "invariant_sum");
        assert_eq!(test_name("tests::sum"), "tests::sum");
        assert_eq!(test_name("adds (1 + 2)"), "adds (1 + 2)");
        assert_eq!(test_name("test_add[case(1)]"), "test_add[case(1)]");
    }
}
