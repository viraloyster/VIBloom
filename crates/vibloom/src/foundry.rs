//! Foundry: its config and folders, its list of tests, and the syntax trees
//! of the build output that the survey reads.

use crate::cli::Fallible;
use crate::map::{RootsMap, test_name};
use crate::proc::{last_json, run_child};
use crate::scan::Found;
use crate::setup::{Plan, Stack, is_test_code, plan};
use crate::store::files_under;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

// What the project is and how its tests run, asking forge for its own
// folders when it is a Foundry project.
pub(crate) fn project_plan(root: &Path, stack: Option<Stack>) -> Plan {
    let has = |f: &str| root.join(f).is_file();
    let stack = stack.unwrap_or_else(|| Stack::detect(&has));
    let config = (stack == Stack::Foundry)
        .then(|| run_child("forge", &["config".into(), "--json".into()], root, 60).ok())
        .flatten()
        .and_then(|r| last_json(&r.stdout));
    plan(stack, config.as_ref(), &has)
}

// Foundry's own list of tests, by file and contract: it knows the contract
// each test runs in, also for a test inherited from a base contract, which
// reading the source cannot.
pub(crate) fn forge_list(root: &Path, map: &RootsMap) -> Option<Value> {
    if map.report.is_some() {
        return None;
    }
    let exe = map.runner.first().map_or("forge", String::as_str);
    let args = ["test".to_string(), "--list".into(), "--json".into()];
    last_json(&run_child(exe, &args, root, 600).ok()?.stdout)
}

pub(crate) fn forge_invariants(listed: &Value) -> Option<Vec<Found>> {
    let mut out = Vec::new();
    for (file, contracts) in listed.as_object()? {
        for (contract, tests) in contracts.as_object()? {
            for name in tests.as_array()?.iter().filter_map(Value::as_str) {
                if name.starts_with("invariant") || name.starts_with("statefulFuzz") {
                    out.push(Found {
                        file: file.clone(),
                        contract: contract.clone(),
                        name: test_name(name),
                    });
                }
            }
        }
    }
    Some(out)
}

// Only what the survey reads: the bytecode and the rest are skipped unparsed.
#[derive(serde::Deserialize)]
pub(crate) struct Artifact {
    #[serde(default)]
    ast: Option<Value>,
    #[serde(default)]
    abi: Option<Value>,
}

pub(crate) fn read_artifact(path: &Path) -> Option<Artifact> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

// Every folder under the build output, by its name: forge writes
// `out/<file name>/<Contract>.json`, deeper when two files share a name.
pub(crate) fn artifact_dirs(dir: &Path, out: &mut BTreeMap<String, Vec<PathBuf>>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = read.filter_map(|e| Some(e.ok()?.path())).collect();
    paths.sort();
    for p in paths.into_iter().filter(|p| p.is_dir()) {
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            out.entry(name.to_string()).or_default().push(p.clone());
        }
        artifact_dirs(&p, out);
    }
}

// The syntax trees of the project's own sources and of every file they
// import, each read once. A file forge wrote no artifact for (only free
// functions or structs) is left out: what it defines is then unresolved.
pub(crate) fn units(root: &Path, sources: &[String], out_dir: &str) -> Vec<crate::survey::Unit> {
    let mut dirs = BTreeMap::new();
    artifact_dirs(&root.join(out_dir), &mut dirs);
    let own: BTreeSet<&str> = sources.iter().map(String::as_str).collect();
    let mut queue: Vec<String> = sources.to_vec();
    let mut seen: BTreeSet<String> = queue.iter().cloned().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < queue.len() {
        let file = queue[i].clone();
        i += 1;
        let base = file.rsplit('/').next().unwrap_or(&file);
        let mut unit: Option<crate::survey::Unit> = None;
        for dir in dirs.get(base).into_iter().flatten() {
            let Ok(read) = fs::read_dir(dir) else {
                continue;
            };
            let mut paths: Vec<PathBuf> = read
                .filter_map(|e| Some(e.ok()?.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect();
            paths.sort();
            for path in paths {
                // Several compiler versions: `Token.0.8.20.json`.
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.split('.').next())
                    .unwrap_or_default()
                    .to_string();
                if let Some(u) = &mut unit {
                    // Only the project's own contracts need their ABI.
                    if own.contains(file.as_str())
                        && !u.abis.contains_key(&name)
                        && let Some(abi) = read_artifact(&path).and_then(|a| a.abi)
                    {
                        u.abis.insert(name, abi);
                    }
                    continue;
                }
                let Some(Artifact {
                    ast: Some(ast),
                    abi,
                }) = read_artifact(&path)
                else {
                    continue;
                };
                if ast.get("absolutePath").and_then(Value::as_str) != Some(file.as_str()) {
                    // The whole folder is another file of the same name.
                    break;
                }
                let mut abis = BTreeMap::new();
                abis.extend(abi.map(|a| (name, a)));
                let source = fs::read_to_string(root.join(&file)).unwrap_or_default();
                unit = Some(crate::survey::Unit {
                    path: file.clone(),
                    ast,
                    abis,
                    source,
                });
            }
            if unit.is_some() {
                break;
            }
        }
        let Some(unit) = unit else { continue };
        for n in unit
            .ast
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if n.get("nodeType").and_then(Value::as_str) == Some("ImportDirective")
                && let Some(p) = n.get("absolutePath").and_then(Value::as_str)
                && seen.insert(p.to_string())
            {
                queue.push(p.to_string());
            }
        }
        out.push(unit);
    }
    out
}

// Whether a source of the project has an artifact without a syntax tree.
pub(crate) fn lacks_ast(root: &Path, sources: &[String], out_dir: &str) -> bool {
    let mut dirs = BTreeMap::new();
    artifact_dirs(&root.join(out_dir), &mut dirs);
    sources.iter().any(|file| {
        let base = file.rsplit('/').next().unwrap_or(file);
        dirs.get(base).into_iter().flatten().any(|dir| {
            fs::read_dir(dir).into_iter().flatten().any(|e| {
                e.ok().is_some_and(|e| {
                    let p = e.path();
                    p.extension().is_some_and(|x| x == "json")
                        && read_artifact(&p).is_some_and(|a| a.ast.is_none())
                })
            })
        })
    })
}

pub(crate) struct FoundryDirs {
    pub(crate) src: String,
    pub(crate) out: String,
    pub(crate) script: String,
    /// Where dependencies live (`lib`): never the project's own files.
    pub(crate) libs: Vec<String>,
}

pub(crate) fn foundry_dirs(root: &Path) -> FoundryDirs {
    let config = run_child("forge", &["config".into(), "--json".into()], root, 60)
        .ok()
        .and_then(|r| last_json(&r.stdout));
    let dir = |k: &str, default: &str| {
        config
            .as_ref()
            .and_then(|c| c.get(k))
            .and_then(Value::as_str)
            .unwrap_or(default)
            .trim_matches('/')
            .to_string()
    };
    let libs = config
        .as_ref()
        .and_then(|c| c.get("libs"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|l| l.trim_matches('/').to_string())
                .collect()
        })
        .unwrap_or_else(|| vec!["lib".to_string()]);
    FoundryDirs {
        src: dir("src", "src"),
        out: dir("out", "out"),
        script: dir("script", "script"),
        libs,
    }
}

// The project's own contracts, read from the compiler's syntax trees. It
// builds with `--ast`, which a plain `forge build` or `forge test` leaves out.
pub(crate) fn compiled(
    root: &Path,
    map: &RootsMap,
    command: &str,
) -> Fallible<(Vec<crate::survey::Contract>, FoundryDirs)> {
    if map.report.is_some() {
        return Err(format!(
            "`vibloom {command}` reads Solidity through Foundry; this project uses another runner."
        ));
    }
    let build = |force: bool| {
        let mut args = vec!["build".to_string(), "--ast".into()];
        if force {
            args.push("--force".into());
        }
        run_child("forge", &args, root, map.timeout)
    };
    let mut built = build(false)?;
    let dirs = foundry_dirs(root);
    let mut sources = Vec::new();
    files_under(root, &dirs.src, &mut sources);
    sources.retain(|f| f.ends_with(".sol") && !is_test_code(f, &map.tests, &dirs.script));
    // `forge test` recompiles a changed file without its syntax tree, and a
    // later `forge build --ast` sees nothing to do: the tree must be forced.
    if lacks_ast(root, &sources, &dirs.out) {
        built = build(true)?;
    }
    let own: BTreeSet<String> = sources.iter().cloned().collect();
    let contracts = crate::survey::read(&units(root, &sources, &dirs.out), &|f| own.contains(f));
    if contracts.is_empty() {
        let said = if built.stderr.trim().is_empty() {
            &built.stdout
        } else {
            &built.stderr
        };
        let lines: Vec<&str> = said.trim().lines().collect();
        return Err(format!(
            "No compiled contract with a syntax tree under {}/. `forge build --ast` said:\n{}",
            dirs.src,
            if lines.is_empty() {
                "nothing".to_string()
            } else {
                lines[lines.len().saturating_sub(6)..].join("\n")
            }
        ));
    }
    Ok((contracts, dirs))
}

/// What an invariant test leans on, as forge resolved its imports.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Closure {
    /// The project files it imports, directly or through others: what it
    /// should watch besides its own file.
    pub(crate) watch: Vec<String>,
    /// The test code among them (handlers, bases): guarded with the test.
    pub(crate) helpers: Vec<String>,
}

/// For each test file, the transitive closure of its imports, read from the
/// compiler's syntax trees, where `ImportDirective.absolutePath` has the
/// remappings resolved. None when a test file has no syntax tree in `out/`.
pub(crate) fn closures(
    units: &[crate::survey::Unit],
    test_files: &[String],
    tests: &str,
    dirs: &FoundryDirs,
    exists: &dyn Fn(&str) -> bool,
) -> Option<BTreeMap<String, Closure>> {
    let imports: BTreeMap<&str, Vec<&str>> = units
        .iter()
        .map(|u| {
            let list = u
                .ast
                .get("nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|n| n.get("nodeType").and_then(Value::as_str) == Some("ImportDirective"))
                .filter_map(|n| n.get("absolutePath").and_then(Value::as_str))
                .collect();
            (u.path.as_str(), list)
        })
        .collect();
    let own = |f: &str| {
        !f.starts_with('/')
            && !f.split('/').any(|s| s == ".." || s == "node_modules")
            && !dirs
                .libs
                .iter()
                .any(|l| !l.is_empty() && f.starts_with(&format!("{l}/")))
            && exists(f)
    };
    let mut out = BTreeMap::new();
    for t in test_files {
        imports.get(t.as_str())?;
        let mut seen: BTreeSet<&str> = BTreeSet::from([t.as_str()]);
        let mut queue = vec![t.as_str()];
        let mut c = Closure::default();
        while let Some(f) = queue.pop() {
            for imp in imports.get(f).into_iter().flatten() {
                if !seen.insert(imp) {
                    continue;
                }
                queue.push(imp);
                if !own(imp) {
                    continue;
                }
                c.watch.push((*imp).to_string());
                if imp.starts_with(tests) || is_test_code(imp, tests, &dirs.script) {
                    c.helpers.push((*imp).to_string());
                }
            }
        }
        c.watch.sort();
        c.helpers.sort();
        out.insert(t.clone(), c);
    }
    Some(out)
}

/// Builds the project with syntax trees and reads each test file's import
/// closure. None when forge is not the runner, the build fails or a test
/// file has no syntax tree.
pub(crate) fn import_closures(
    root: &Path,
    map: &RootsMap,
    test_files: &[String],
) -> Option<BTreeMap<String, Closure>> {
    let exe = map.runner.first().map_or("forge", String::as_str);
    if map.report.is_some()
        || !exe
            .rsplit(['/', '\\'])
            .next()
            .is_some_and(|e| e.starts_with("forge"))
        || !root.join("foundry.toml").is_file()
        || test_files.is_empty()
    {
        return None;
    }
    let build = |force: bool| {
        let mut args = vec!["build".to_string(), "--ast".into()];
        if force {
            args.push("--force".into());
        }
        run_child(exe, &args, root, map.timeout).ok()
    };
    build(false)?;
    let dirs = foundry_dirs(root);
    // `forge test` leaves the trees out of what it recompiled.
    if lacks_ast(root, test_files, &dirs.out) {
        build(true)?;
    }
    let units = units(root, test_files, &dirs.out);
    closures(&units, test_files, &map.tests, &dirs, &|f| {
        root.join(f).is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn unit(path: &str, imports: &[&str]) -> crate::survey::Unit {
        let nodes: Vec<Value> = imports
            .iter()
            .map(|i| json!({ "nodeType": "ImportDirective", "absolutePath": i }))
            .collect();
        crate::survey::Unit {
            path: path.into(),
            ast: json!({ "absolutePath": path, "nodes": nodes }),
            abis: BTreeMap::new(),
            source: String::new(),
        }
    }

    #[test]
    fn follows_imports_forge_resolved_including_remapped_ones() {
        let units = vec![
            // A remapped import ("handlers/H.sol") and a library.
            unit(
                "test/Vault.t.sol",
                &[
                    "lib/forge-std/src/Test.sol",
                    "test/handlers/H.sol",
                    "src/Vault.sol",
                ],
            ),
            unit("test/handlers/H.sol", &["src/Vault.sol", "test/Base.sol"]),
            unit("test/Base.sol", &["src/Math.sol"]),
            unit("lib/forge-std/src/Test.sol", &["lib/forge-std/src/Vm.sol"]),
            unit("src/Vault.sol", &[]),
            unit("src/Math.sol", &[]),
        ];
        let dirs = FoundryDirs {
            src: "src".into(),
            out: "out".into(),
            script: "script".into(),
            libs: vec!["lib".into()],
        };
        let got = closures(
            &units,
            &["test/Vault.t.sol".into()],
            "test/",
            &dirs,
            &|_| true,
        )
        .expect("trees");
        assert_eq!(
            got["test/Vault.t.sol"],
            Closure {
                watch: vec![
                    "src/Math.sol".into(),
                    "src/Vault.sol".into(),
                    "test/Base.sol".into(),
                    "test/handlers/H.sol".into()
                ],
                helpers: vec!["test/Base.sol".into(), "test/handlers/H.sol".into()],
            }
        );
        // A test file without a tree: the caller falls back to the text.
        assert!(
            closures(
                &units,
                &["test/Other.t.sol".into()],
                "test/",
                &dirs,
                &|_| true
            )
            .is_none()
        );
    }
}
