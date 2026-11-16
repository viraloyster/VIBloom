//! Setting a project up: what kind of project it is, which runner and report
//! fit it, and which files an invariant test leans on. No IO: the command
//! reads the disk and asks the tools, this decides.

use regex::Regex;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stack {
    Foundry,
    Hardhat,
    Cargo,
    Pytest,
    Unknown,
}

impl Stack {
    /// From the files at the project root. Foundry wins when a project has
    /// both Foundry and Hardhat, since its report needs no extra reporter.
    pub fn detect(has: &dyn Fn(&str) -> bool) -> Self {
        if has("foundry.toml") {
            Self::Foundry
        } else if [
            "hardhat.config.ts",
            "hardhat.config.js",
            "hardhat.config.cjs",
        ]
        .iter()
        .any(|f| has(f))
        {
            Self::Hardhat
        } else if has("Cargo.toml") {
            Self::Cargo
        } else if ["pyproject.toml", "pytest.ini", "setup.py", "tox.ini"]
            .iter()
            .any(|f| has(f))
        {
            Self::Pytest
        } else {
            Self::Unknown
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "foundry" | "forge" => Some(Self::Foundry),
            "hardhat" => Some(Self::Hardhat),
            "cargo" | "nextest" | "rust" => Some(Self::Cargo),
            "pytest" | "python" => Some(Self::Pytest),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub runner: Vec<String>,
    pub report: Option<String>,
    pub tests: String,
    /// The source folder a new node watches by default.
    pub src: Option<String>,
    pub protect: Vec<String>,
    /// What the person still has to do by hand, if anything.
    pub notes: Vec<String>,
}

fn dir(s: &str) -> String {
    format!("{}/", s.trim_matches('/'))
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_string()).collect()
}

/// `forge_config` is the output of `forge config --json`, when forge answered.
pub fn plan(stack: Stack, forge_config: Option<&Value>, has: &dyn Fn(&str) -> bool) -> Plan {
    match stack {
        Stack::Foundry | Stack::Unknown => {
            let get = |k: &str, default: &str| {
                dir(forge_config
                    .and_then(|c| c.get(k))
                    .and_then(Value::as_str)
                    .unwrap_or(default))
            };
            let mut notes = vec![];
            if stack == Stack::Unknown {
                notes.push(
                    "No known project file here; assumed Foundry. For another runner: vibloom init --stack hardhat|cargo|pytest."
                        .into(),
                );
            }
            Plan {
                runner: strs(&["forge", "test", "--json"]),
                report: None,
                tests: get("test", "test"),
                src: Some(get("src", "src")),
                // Fuzz and invariant runs and depth live here: lowering them
                // weakens every invariant without touching a test.
                protect: if has("foundry.toml") {
                    strs(&["foundry.toml"])
                } else {
                    vec![]
                },
                notes,
            }
        }
        Stack::Hardhat => Plan {
            runner: strs(&["npx", "hardhat", "test"]),
            report: Some("cache/vibloom-junit.xml".into()),
            tests: "test/".into(),
            src: Some("contracts/".into()),
            protect: [
                "hardhat.config.ts",
                "hardhat.config.js",
                "hardhat.config.cjs",
            ]
            .iter()
            .filter(|f| has(f))
            .map(|f| (*f).to_string())
            .collect(),
            notes: strs(&[
                "Hardhat needs a JUnit reporter: npm i -D mocha-junit-reporter, then in the Hardhat config set mocha: { reporter: \"mocha-junit-reporter\", reporterOptions: { mochaFile: \"cache/vibloom-junit.xml\" } }.",
            ]),
        },
        Stack::Cargo => Plan {
            runner: strs(&["cargo", "nextest", "run", "--profile", "ci"]),
            report: Some("target/nextest/ci/junit.xml".into()),
            tests: "tests/".into(),
            src: Some("src/".into()),
            protect: vec![],
            notes: strs(&[
                "cargo-nextest writes the report: cargo install cargo-nextest, then add to .config/nextest.toml:\n  [profile.ci.junit]\n  path = \"junit.xml\"",
            ]),
        },
        Stack::Pytest => Plan {
            runner: strs(&["pytest", "-q", "--junitxml=.pytest_cache/vibloom-junit.xml"]),
            report: Some(".pytest_cache/vibloom-junit.xml".into()),
            tests: "tests/".into(),
            src: Some("src/".into()),
            protect: vec![],
            notes: vec![],
        },
    }
}

static IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+(?:[^"';]*?\bfrom\s+)?["']([^"']+)["']"#).expect("static regex")
});

/// A Solidity file's relative imports, resolved from the file's own folder.
/// Remapped and library imports ("forge-std/Test.sol") are not project files.
pub fn relative_imports(file: &str, source: &str) -> Vec<String> {
    let base: Vec<&str> = file.split('/').collect();
    let base = &base[..base.len().saturating_sub(1)];
    IMPORT
        .captures_iter(source)
        .filter_map(|c| c.get(1).map(|m| m.as_str()))
        .filter(|p| p.starts_with("./") || p.starts_with("../"))
        .filter_map(|p| {
            let mut parts: Vec<&str> = base.to_vec();
            for seg in p.split('/') {
                match seg {
                    "." | "" => {}
                    ".." => {
                        parts.pop()?;
                    }
                    s => parts.push(s),
                }
            }
            Some(parts.join("/"))
        })
        .collect()
}

/// Every file under `tests` that the given test files import, directly or
/// through another: handlers and base contracts. An invariant is only as
/// strong as its handler, so these are guarded with the test itself.
pub fn helpers(
    test_files: &[String],
    tests: &str,
    read: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    let mut seen: BTreeSet<String> = test_files.iter().cloned().collect();
    let mut queue: Vec<String> = test_files.to_vec();
    let mut out = BTreeSet::new();
    while let Some(f) = queue.pop() {
        let Some(source) = read(&f) else { continue };
        for imp in relative_imports(&f, &source) {
            if imp.starts_with(tests) && seen.insert(imp.clone()) {
                out.insert(imp.clone());
                queue.push(imp);
            }
        }
    }
    out.into_iter().collect()
}

/// Whether a source file is test or script code rather than the project's
/// own: dapptools projects keep their tests in `src/test/`, next to the code.
pub fn is_test_code(file: &str, tests: &str, script: &str) -> bool {
    let under = |d: &str| {
        let d = d.trim_matches('/');
        !d.is_empty() && file.starts_with(&format!("{d}/"))
    };
    let mut folders = file.split('/').rev().skip(1);
    file.ends_with(".t.sol")
        || file.ends_with(".s.sol")
        || under(tests)
        || under(script)
        || folders.any(|p| {
            matches!(
                p.to_lowercase().as_str(),
                "test" | "tests" | "mock" | "mocks"
            )
        })
}

/// Where the tests are when the planned folder holds none of the test files
/// the runner lists: the deepest folder they all share (`src/test/`).
pub fn tests_dir(planned: &str, listed: &[String]) -> Option<String> {
    let planned = dir(planned);
    if listed.is_empty() || listed.iter().any(|f| f.starts_with(&planned)) {
        return None;
    }
    let folder = |f: &str| {
        let mut parts: Vec<String> = f.split('/').map(str::to_string).collect();
        parts.pop();
        parts
    };
    let mut common = folder(&listed[0]);
    for f in &listed[1..] {
        let other = folder(f);
        let same = common
            .iter()
            .zip(&other)
            .take_while(|(a, b)| a == b)
            .count();
        common.truncate(same);
    }
    (!common.is_empty()).then(|| dir(&common.join("/")))
}

/// The state-changing functions of a compiled contract, from its ABI: what a
/// call can use to move the contract's state.
pub fn entry_points(abi: &Value) -> Vec<String> {
    let mut out: Vec<String> = abi
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f.get("type").and_then(Value::as_str) == Some("function"))
        .filter(|f| {
            matches!(
                f.get("stateMutability").and_then(Value::as_str),
                Some("nonpayable" | "payable")
            )
        })
        .filter_map(|f| f.get("name").and_then(Value::as_str).map(str::to_string))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The names that appear nowhere in the tests as a word. A name that does
/// appear may still never be called; one that does not appear cannot be.
pub fn unmentioned(names: &[String], tests: &str) -> Vec<String> {
    names
        .iter()
        .filter(|n| {
            Regex::new(&format!(r"\b{}\b", regex::escape(n))).is_ok_and(|r| !r.is_match(tests))
        })
        .cloned()
        .collect()
}

/// The configuration files of the checks' tools: those a command names
/// (`--config echidna.yaml`) and Halmos's own `halmos.toml`. Like
/// `foundry.toml`, they set how hard the tool tries.
pub fn check_configs(checks: &[crate::map::Check], has: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut out = BTreeSet::new();
    for c in checks {
        if c.tool == crate::map::Tool::Halmos {
            out.insert("halmos.toml".to_string());
        }
        for w in c
            .command
            .iter()
            .flatten()
            .flat_map(|a| a.split_whitespace())
        {
            let w = w.rsplit('=').next().unwrap_or(w).trim_matches(['"', '\'']);
            if [".yaml", ".yml", ".toml"].iter().any(|e| w.ends_with(e)) {
                out.insert(w.trim_start_matches("./").to_string());
            }
        }
    }
    out.into_iter()
        .filter(|f| crate::map::safe_path(f) && has(f))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_config_files_a_check_runs_with() {
        let m = crate::map::parse_map(&serde_json::json!({
            "version": 1,
            "checks": [
                { "tool": "echidna", "report": "out/e.json",
                  "command": ["sh", "-c", "echidna . --config ./echidna.yaml --format json > out/e.json"] },
                { "tool": "halmos", "report": "out/h.json", "command": ["halmos", "--config=conf/h.toml", "--json-output", "out/h.json"] }
            ],
            "nodes": []
        }))
        .expect("map");
        let has = |f: &str| matches!(f, "echidna.yaml" | "conf/h.toml" | "halmos.toml");
        assert_eq!(
            check_configs(&m.checks, &has),
            vec!["conf/h.toml", "echidna.yaml", "halmos.toml"]
        );
        assert!(check_configs(&m.checks, &|_| false).is_empty());
    }
    use serde_json::json;

    #[test]
    fn detects_the_stack_from_the_files_at_the_root() {
        let with = |files: &'static [&'static str]| move |f: &str| files.contains(&f);
        assert_eq!(
            Stack::detect(&with(&["foundry.toml", "hardhat.config.ts"])),
            Stack::Foundry
        );
        assert_eq!(Stack::detect(&with(&["hardhat.config.js"])), Stack::Hardhat);
        assert_eq!(Stack::detect(&with(&["Cargo.toml"])), Stack::Cargo);
        assert_eq!(Stack::detect(&with(&["pyproject.toml"])), Stack::Pytest);
        assert_eq!(Stack::detect(&with(&[])), Stack::Unknown);
    }

    #[test]
    fn plans_foundry_from_its_own_config_and_guards_it() {
        let p = plan(
            Stack::Foundry,
            Some(&json!({ "src": "contracts", "test": "test/foundry" })),
            &|f| f == "foundry.toml",
        );
        assert_eq!(p.runner, vec!["forge", "test", "--json"]);
        assert_eq!(p.report, None);
        assert_eq!(p.src.as_deref(), Some("contracts/"));
        assert_eq!(p.tests, "test/foundry/");
        assert_eq!(p.protect, vec!["foundry.toml"]);
        assert!(p.notes.is_empty());
    }

    #[test]
    fn plans_the_junit_runners_with_a_report_git_ignores() {
        let none = |_: &str| false;
        let c = plan(Stack::Cargo, None, &none);
        assert_eq!(c.report.as_deref(), Some("target/nextest/ci/junit.xml"));
        let p = plan(Stack::Pytest, None, &none);
        assert_eq!(p.report.as_deref(), Some(".pytest_cache/vibloom-junit.xml"));
        assert!(p.runner[2].ends_with(".pytest_cache/vibloom-junit.xml"));
        assert_eq!(plan(Stack::Hardhat, None, &none).notes.len(), 1);
    }

    #[test]
    fn lists_the_entry_points_no_test_mentions() {
        let vault = json!([
            { "type": "constructor", "stateMutability": "nonpayable" },
            { "type": "function", "name": "deposit", "stateMutability": "nonpayable" },
            { "type": "function", "name": "sweep", "stateMutability": "payable" },
            { "type": "function", "name": "totalAssets", "stateMutability": "view" },
            { "type": "function", "name": "deposit", "stateMutability": "nonpayable" }
        ]);
        let names = entry_points(&vault);
        assert_eq!(names, vec!["deposit", "sweep"]);
        assert_eq!(
            unmentioned(&names, "vault.deposit(assets); // sweeping is later"),
            vec!["sweep"]
        );
        assert_eq!(entry_points(&Value::Null), Vec::<String>::new());
    }

    #[test]
    fn tells_test_and_script_code_from_the_project_s_own() {
        let test = |f: &str| is_test_code(f, "test/", "script");
        assert!(test("src/test/vat.t.sol"));
        assert!(test("src/test/Helpers.sol"));
        assert!(test("src/Deploy.s.sol"));
        assert!(test("test/Base.sol"));
        assert!(test("script/Deploy.sol"));
        assert!(test("src/Mocks/Token.sol"));
        assert!(test("contracts/mock/Oracle.sol"));
        assert!(!test("src/vat.sol"));
        // A file named like a folder is no folder.
        assert!(!test("src/test.sol"));
        assert!(!test("src/testing/Lib.sol"));
        assert!(!is_test_code("src/vat.sol", "", ""));
    }

    #[test]
    fn finds_the_tests_folder_from_the_listed_test_files() {
        let listed = |fs: &[&str]| fs.iter().map(|f| (*f).to_string()).collect::<Vec<_>>();
        let dss = listed(&["src/test/vat.t.sol", "src/test/dai.t.sol"]);
        assert_eq!(tests_dir("test/", &dss).as_deref(), Some("src/test/"));
        let nested = listed(&["src/test/a/x.t.sol", "src/test/b/y.t.sol"]);
        assert_eq!(tests_dir("test", &nested).as_deref(), Some("src/test/"));
        // The planned folder holds some of them: it stays.
        assert_eq!(
            tests_dir("test/", &listed(&["test/A.t.sol", "src/B.t.sol"])),
            None
        );
        assert_eq!(tests_dir("test/", &[]), None);
        // Nothing in common is no folder.
        assert_eq!(
            tests_dir("test/", &listed(&["a/x.t.sol", "b/y.t.sol"])),
            None
        );
    }

    #[test]
    fn finds_the_handlers_an_invariant_test_leans_on() {
        let read = |f: &str| {
            Some(
                match f {
                    "test/Vault.t.sol" => {
                        "import {Test} from \"forge-std/Test.sol\";\nimport {Handler} from \"./handlers/Handler.sol\";\nimport \"../src/Vault.sol\";"
                    }
                    "test/handlers/Handler.sol" => "import { Base } from '../Base.sol';",
                    "test/Base.sol" => "import \"./handlers/Handler.sol\"; // cycle",
                    _ => return None,
                }
                .to_string(),
            )
        };
        assert_eq!(
            helpers(&["test/Vault.t.sol".into()], "test/", &read),
            vec!["test/Base.sol", "test/handlers/Handler.sol"]
        );
        // Tests next to the sources: the sources they import are no helpers.
        let dss = |f: &str| {
            (f == "src/test/vat.t.sol")
                .then(|| "import \"../vat.sol\";\nimport \"./Base.sol\";".to_string())
        };
        assert_eq!(
            helpers(&["src/test/vat.t.sol".into()], "src/test/", &dss),
            vec!["src/test/Base.sol"]
        );
        assert_eq!(
            relative_imports("test/a/B.sol", "import \"../../../outside.sol\";"),
            Vec::<String>::new()
        );
    }
}
