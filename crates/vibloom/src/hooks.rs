//! Decisions for agent hooks, in the format Claude Code reads. Each takes the
//! hook's input and what the guard knows, and returns what to print. No IO.

use crate::derive::{NodeView, label, troubled};
use crate::forge::forge_filters;
use crate::map::{LOG_PATH, RootsMap, covers};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Builder,
    Verifier,
}

impl Role {
    pub fn from_env(value: Option<&str>) -> Self {
        if value == Some("verifier") {
            Self::Verifier
        } else {
            Self::Builder
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct HookOutput {
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

#[derive(Debug, Default)]
pub struct HookInput {
    pub tool_name: String,
    pub file_path: Option<String>,
    pub command: Option<String>,
    pub stop_hook_active: bool,
    pub cwd: Option<String>,
}

impl HookInput {
    pub fn from_json(v: &Value) -> Self {
        let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
        Self {
            tool_name: s("/tool_name").unwrap_or_default(),
            file_path: s("/tool_input/file_path").or_else(|| s("/tool_input/notebook_path")),
            command: s("/tool_input/command"),
            stop_hook_active: v.get("stop_hook_active") == Some(&Value::Bool(true)),
            cwd: s("/cwd"),
        }
    }
}

const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// Paths only the verifier may change: protected tests, the protect list and
/// the guard's own files.
pub fn guarded(map: &RootsMap) -> Vec<String> {
    let mut out = vec![".vibloom/".to_string()];
    for p in map.protect.iter().cloned().chain(
        map.nodes
            .iter()
            .filter(|n| n.protected)
            .filter_map(|n| n.test.as_ref().map(|t| t.file.clone())),
    ) {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

pub fn is_guarded(map: &RootsMap, rel: &str) -> bool {
    guarded(map).iter().any(|g| covers(g, rel))
}

// Shell commands that plainly write to a file: redirection, in-place edits,
// moves, deletes, copies. A heuristic, not a sandbox.
static WRITES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(^|[\s;&|])(>|>>|tee\b|sed\s+-i|perl\s+-i|rm\b|mv\b|cp\b|truncate\b|dd\b|git\s+(checkout|restore|apply|am|mv|rm|stash|reset|revert|cherry-pick|merge|rebase)\b)",
    )
    .expect("static regex")
});
// Anything that signs or sends: an agent reads the chain, it does not write
// to it.
static CHAIN_WRITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\bcast\s+(send|publish|mktx|wallet)\b|\bforge\s+create\b|\bforge\s+script\b[^;&|]*--broadcast\b|--private-key\b|--mnemonic\b|--ledger\b|--trezor\b|--keystore\b",
    )
    .expect("static regex")
});
// A commit that skips the commit check.
static NO_VERIFY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bgit\b[^;&|]*\bcommit\b[^;&|]*(--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)")
        .expect("static regex")
});

fn emit(v: Value) -> HookOutput {
    HookOutput {
        stdout: Some(v.to_string()),
        stderr: None,
    }
}

pub fn pre_tool(
    input: &HookInput,
    map: &RootsMap,
    role: Role,
    rel: &dyn Fn(&str) -> Option<String>,
) -> HookOutput {
    if role == Role::Verifier {
        return HookOutput::default();
    }
    let deny = |reason: String| {
        emit(json!({ "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))
    };
    if EDIT_TOOLS.contains(&input.tool_name.as_str())
        && let Some(r) = input.file_path.as_deref().and_then(rel)
        && is_guarded(map, &r)
    {
        return deny(format!(
            "VIBloom: {r} is guarded. Only the verifier role may change protected tests and the roots map. \
             If the test is wrong, say so and explain why; do not change it to make it pass."
        ));
    }
    if input.tool_name == "Bash" {
        let cmd = input.command.as_deref().unwrap_or_default();
        // The role is given by whoever starts the agent, never taken by it.
        if cmd.contains("VIBLOOM_ROLE") {
            return deny(
                "VIBloom: a builder does not set VIBLOOM_ROLE. Ask the person to do what needs the verifier."
                    .into(),
            );
        }
        if CHAIN_WRITE.is_match(cmd) {
            return deny(
                "VIBloom: this command would sign or send a transaction. A builder only reads the chain (cast call, cast code, cast storage); a person sends."
                    .into(),
            );
        }
        if NO_VERIFY.is_match(cmd) {
            return deny(
                "VIBloom: this commit would skip the commit check. Commit without --no-verify."
                    .into(),
            );
        }
        if let Some(hit) = guarded(map)
            .into_iter()
            .find(|g| cmd.contains(g.trim_end_matches('/')))
            && WRITES.is_match(cmd)
        {
            return deny(format!(
                "VIBloom: this command looks like it writes to {hit}, which is guarded."
            ));
        }
    }
    HookOutput::default()
}

pub fn summary(views: &[NodeView]) -> String {
    views
        .iter()
        .filter(|v| troubled(v))
        .map(|v| {
            let mut parts = vec![format!("{} [{}] {}", v.id, label(v), v.title)];
            if let Some(r) = &v.reason {
                parts.push(format!("failure: {r}"));
            }
            if !v.because.is_empty() {
                parts.push(format!("because of {}", v.because.join(", ")));
            }
            if !v.changed.is_empty() {
                parts.push(format!("changed: {}", v.changed.join(", ")));
            }
            format!("- {}", parts.join("; "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether a shell command runs the project's tests, and with which filters.
/// Foundry's filters are kept, to re-run the same subset; for any other
/// runner the command only has to name it, and the whole suite runs.
pub fn test_run(map: &RootsMap, command: &str) -> Option<Vec<String>> {
    if map.report.is_none() {
        return forge_filters(command);
    }
    let word = |w: &str| {
        let name = w.rsplit(['/', '\\']).next().unwrap_or(w);
        Regex::new(&format!(r"(^|[\s;&|/]){}(\s|$)", regex::escape(name)))
            .is_ok_and(|r| r.is_match(command))
    };
    let mut named = map.runner.iter().take_while(|w| !w.starts_with('-'));
    let exe = named.next()?;
    (word(exe) && named.next().is_none_or(|sub| word(sub))).then(Vec::new)
}

/// After a tool ran. `ran` says the tool was a test run, and then `views` is
/// the state after the guard ran the tests itself.
pub fn post_tool(
    input: &HookInput,
    views: &[NodeView],
    ran: bool,
    rel: &dyn Fn(&str) -> Option<String>,
) -> HookOutput {
    let context = |text: String| {
        emit(
            json!({ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": text }}),
        )
    };
    if ran {
        let bad = views.iter().filter(|v| troubled(v)).count();
        if bad == 0 {
            let held = views
                .iter()
                .filter(|v| v.evidence == crate::derive::Evidence::Holds)
                .count();
            return context(format!(
                "VIBloom: recorded the run; {held} tested nodes hold, none need attention."
            ));
        }
        return emit(json!({
            "decision": "block",
            "reason": format!(
                "VIBloom recorded the run. {bad} nodes need attention:\n{}\n\
                 Fix the code, not the invariant. If you believe an invariant or assumption is wrong, \
                 stop and explain why instead of changing it.",
                summary(views)
            ),
        }));
    }
    if EDIT_TOOLS.contains(&input.tool_name.as_str()) {
        let Some(r) = input.file_path.as_deref().and_then(rel) else {
            return HookOutput::default();
        };
        let hit: Vec<&str> = views
            .iter()
            .filter(|v| v.watch.iter().any(|w| covers(w, &r)))
            .map(|v| v.id.as_str())
            .collect();
        if !hit.is_empty() {
            return context(format!(
                "VIBloom: {r} is watched by {}. Their evidence is now pending review; run the tests before calling this done.",
                hit.join(", ")
            ));
        }
    }
    HookOutput::default()
}

pub fn stop(input: &HookInput, views: &[NodeView], log_problems: &[String]) -> HookOutput {
    if !log_problems.is_empty() {
        return emit(json!({
            "decision": "block",
            "reason": format!(
                "VIBloom: the run log failed verification:\n- {}\nThe record may only be appended by the guard. Tell the person.",
                log_problems.join("\n- ")
            ),
        }));
    }
    let bad = views.iter().filter(|v| troubled(v)).count();
    if bad == 0 {
        return HookOutput::default();
    }
    // Claude Code sets this when a Stop hook already sent the agent back once;
    // letting it stop then avoids a loop, and the state stays visible.
    if input.stop_hook_active {
        return emit(
            json!({ "systemMessage": format!("VIBloom: stopping with {bad} nodes that need attention.") }),
        );
    }
    emit(json!({
        "decision": "block",
        "reason": format!(
            "VIBloom: the task is not done. {bad} nodes need attention:\n{}\n\
             Run the tests again after fixing the code, or explain why a node is wrong.",
            summary(views)
        ),
    }))
}

/// The log is appended by the guard, never committed as a guarded edit; its
/// integrity is checked on its own.
pub fn guarded_for_commit(map: &RootsMap, file: &str) -> bool {
    file != LOG_PATH && file != crate::map::PROPOSALS_PATH && is_guarded(map, file)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::derive::{Evidence, Support};
    use crate::map::{Kind, Stance, parse_map};

    fn map() -> RootsMap {
        parse_map(&json!({
            "version": 1,
            "protect": ["foundry.toml"],
            "nodes": [
                { "id": "inv.sum", "kind": "invariant", "title": "sum",
                  "test": { "file": "test/C.t.sol", "name": "invariant_sum" }, "watch": ["src/C.sol"] },
                { "id": "inv.open", "kind": "invariant", "title": "open",
                  "test": { "file": "test/Open.t.sol", "name": "invariant_open" }, "protected": false }
            ]
        }))
        .expect("valid")
    }

    fn rel(p: &str) -> Option<String> {
        p.strip_prefix("/repo/").map(str::to_string)
    }

    pub(crate) fn view(evidence: Evidence) -> NodeView {
        NodeView {
            id: "inv.sum".into(),
            kind: Kind::Invariant,
            title: "sum".into(),
            detail: None,
            stance: Stance::Adopted,
            protected: true,
            evidence,
            support: Support::Ok,
            because: vec![],
            changed: vec![],
            reason: None,
            fuzz: None,
            run: Some(3),
            depends_on: vec![],
            watch: vec!["src/C.sol".into(), "test/C.t.sol".into()],
            test_file: Some("test/C.t.sol".into()),
            sources: vec![],
        }
    }

    fn edit(path: &str) -> HookInput {
        HookInput {
            tool_name: "Edit".into(),
            file_path: Some(path.into()),
            ..Default::default()
        }
    }

    fn bash(cmd: &str) -> HookInput {
        HookInput {
            tool_name: "Bash".into(),
            command: Some(cmd.into()),
            ..Default::default()
        }
    }

    fn json_of(o: &HookOutput) -> Value {
        serde_json::from_str(o.stdout.as_deref().unwrap_or("{}")).expect("json")
    }

    fn denied(o: &HookOutput) -> bool {
        json_of(o).pointer("/hookSpecificOutput/permissionDecision") == Some(&json!("deny"))
    }

    #[test]
    fn denies_the_builder_guarded_paths() {
        for p in [
            "/repo/test/C.t.sol",
            "/repo/.vibloom/roots.json",
            "/repo/.vibloom/log.jsonl",
            "/repo/foundry.toml",
        ] {
            assert!(
                denied(&pre_tool(&edit(p), &map(), Role::Builder, &rel)),
                "{p}"
            );
        }
        assert_eq!(
            pre_tool(&edit("/repo/src/C.sol"), &map(), Role::Builder, &rel),
            HookOutput::default()
        );
        assert_eq!(
            pre_tool(&edit("/repo/test/Open.t.sol"), &map(), Role::Builder, &rel),
            HookOutput::default()
        );
        assert_eq!(
            pre_tool(&edit("/repo/test/C.t.sol"), &map(), Role::Verifier, &rel),
            HookOutput::default()
        );
    }

    #[test]
    fn denies_shell_writes_to_guarded_paths_only() {
        assert!(denied(&pre_tool(
            &bash("sed -i 's/a/b/' test/C.t.sol"),
            &map(),
            Role::Builder,
            &rel
        )));
        assert!(denied(&pre_tool(
            &bash("echo {} > .vibloom/roots.json"),
            &map(),
            Role::Builder,
            &rel
        )));
        assert_eq!(
            pre_tool(&bash("cat test/C.t.sol"), &map(), Role::Builder, &rel),
            HookOutput::default()
        );
    }

    #[test]
    fn denies_taking_the_role_skipping_the_check_or_restoring_a_guarded_file() {
        for cmd in [
            "cast send 0xabc 'mint(address,uint256)' 0xdef 1 --rpc-url $ETH_RPC_URL",
            "cast call 0xabc 'owner()' --private-key 0x01",
            "forge script script/Deploy.s.sol --rpc-url x --broadcast",
            "forge create src/C.sol:C",
            "VIBLOOM_ROLE=verifier vibloom proposals accept p1",
            "export VIBLOOM_ROLE=verifier",
            "git commit --no-verify -m x",
            "git add -A && git commit -nm x",
            "git checkout HEAD~1 -- test/C.t.sol",
            "git restore --source=HEAD~3 test/C.t.sol",
        ] {
            assert!(
                denied(&pre_tool(&bash(cmd), &map(), Role::Builder, &rel)),
                "{cmd}"
            );
        }
        for cmd in [
            "cast call 0xabc 'totalSupply()(uint256)' --block 21000000",
            "cast storage 0xabc 0",
            "forge script script/Check.s.sol",
            "git commit -m 'fix the sum'",
            "git commit --amend -m x",
            "git checkout -b feature",
            "git log -n 3",
        ] {
            assert_eq!(
                pre_tool(&bash(cmd), &map(), Role::Builder, &rel),
                HookOutput::default(),
                "{cmd}"
            );
        }
        assert_eq!(
            pre_tool(
                &bash("git commit --no-verify -m x"),
                &map(),
                Role::Verifier,
                &rel
            ),
            HookOutput::default()
        );
    }

    #[test]
    fn sends_the_agent_back_after_a_broken_run() {
        let mut v = view(Evidence::Broken);
        v.reason = Some("drift".into());
        let out = json_of(&post_tool(
            &bash("forge test --mt invariant_sum"),
            &[v],
            true,
            &rel,
        ));
        assert_eq!(out["decision"], "block");
        let reason = out["reason"].as_str().unwrap_or_default();
        assert!(reason.contains("inv.sum [BROKEN] sum; failure: drift"));
        assert!(reason.contains("Fix the code, not the invariant"));
        let clean = json_of(&post_tool(
            &bash("forge test"),
            &[view(Evidence::Holds)],
            true,
            &rel,
        ));
        assert!(
            clean["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap_or_default()
                .contains("1 tested nodes hold")
        );
    }

    #[test]
    fn warns_when_an_edit_touches_a_watched_file() {
        let input = HookInput {
            tool_name: "Write".into(),
            file_path: Some("/repo/src/C.sol".into()),
            ..Default::default()
        };
        let out = json_of(&post_tool(&input, &[view(Evidence::Holds)], false, &rel));
        assert!(
            out["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap_or_default()
                .contains("pending review")
        );
        let other = HookInput {
            tool_name: "Write".into(),
            file_path: Some("/repo/README.md".into()),
            ..Default::default()
        };
        assert_eq!(
            post_tool(&other, &[view(Evidence::Holds)], false, &rel),
            HookOutput::default()
        );
    }

    #[test]
    fn knows_a_test_run_of_the_projects_own_runner() {
        assert_eq!(
            test_run(&map(), "forge test --mt invariant_sum -vv"),
            Some(vec!["--mt".to_string(), "invariant_sum".to_string()])
        );
        assert_eq!(test_run(&map(), "forge build"), None);
        let with = |runner: serde_json::Value| {
            parse_map(
                &json!({ "version": 1, "runner": runner, "report": "out/j.xml", "nodes": [] }),
            )
            .expect("valid")
        };
        let pytest = with(json!(["/venv/bin/pytest", "-q", "--junitxml=out/j.xml"]));
        assert_eq!(test_run(&pytest, "cd app && pytest -k vault"), Some(vec![]));
        assert_eq!(test_run(&pytest, ".venv/bin/pytest"), Some(vec![]));
        assert_eq!(test_run(&pytest, "pip install pytest-cov"), None);
        let nextest = with(json!(["cargo", "nextest", "run", "--profile", "ci"]));
        assert_eq!(
            test_run(&nextest, "cargo nextest run -p vault"),
            Some(vec![])
        );
        assert_eq!(test_run(&nextest, "cargo build"), None);
        // The filters are forge's; another runner never gets them.
        assert_eq!(test_run(&pytest, "forge test --mt x"), None);
    }

    #[test]
    fn blocks_stopping_once_and_on_a_tampered_log() {
        let mut stale = view(Evidence::Stale);
        stale.changed = vec!["src/C.sol".into()];
        let first = HookInput::default();
        assert_eq!(
            json_of(&stop(&first, std::slice::from_ref(&stale), &[]))["decision"],
            "block"
        );
        let again = HookInput {
            stop_hook_active: true,
            ..Default::default()
        };
        let out = json_of(&stop(&again, &[stale], &[]));
        assert!(out.get("decision").is_none());
        assert!(
            out["systemMessage"]
                .as_str()
                .unwrap_or_default()
                .contains("1 nodes that need attention")
        );
        assert_eq!(
            stop(&first, &[view(Evidence::Holds)], &[]),
            HookOutput::default()
        );
        assert_eq!(
            json_of(&stop(
                &first,
                &[view(Evidence::Holds)],
                &["entry 1 was changed".into()]
            ))["decision"],
            "block"
        );
    }
}
