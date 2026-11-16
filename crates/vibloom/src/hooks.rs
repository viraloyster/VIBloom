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

// Case is ignored: on macOS and Windows "TEST/C.t.sol" is the same file.
fn guarded_hit(map: &RootsMap, rel: &str, ancestor: bool) -> Option<String> {
    let rel = rel.to_lowercase();
    guarded(map).into_iter().find(|g| {
        let low = g.to_lowercase();
        covers(&low, &rel)
            || (ancestor && low.starts_with(&format!("{}/", rel.trim_end_matches('/'))))
    })
}

// A glob such as test/*.t.sol, as a regex over whole paths.
fn glob_hit(map: &RootsMap, rel: &str) -> Option<String> {
    let mut re = String::from("(?i)^");
    for c in rel.chars() {
        match c {
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push_str("(/|$)");
    let re = Regex::new(&re).ok()?;
    guarded(map).into_iter().find(|g| re.is_match(g))
}

// Shell commands that plainly write to a file: redirection, in-place edits,
// moves, deletes, copies, links, and interpreters that can write anything.
// A heuristic, not a sandbox.
static WRITES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(^|[\s;&|(`])(>|>>|tee\b|sed\s+(-[a-zA-Z]*i|--in-place)|perl\b|python[0-9.]*\b|node\b|ruby\b|php\b|deno\b|bun\b|awk\b|gawk\b|ed\b|ex\b|vi\b|vim\b|nvim\b|rm\b|mv\b|cp\b|ln\b|install\b|rsync\b|patch\b|xargs\b|truncate\b|dd\b|find\b[^;&|]*\s-(exec|execdir|delete|ok)\b|git\s+(checkout|restore|apply|am|mv|rm|stash|reset|revert|cherry-pick|merge|rebase|clean)\b)",
    )
    .expect("static regex")
});
// Commands that act on a whole folder named as a plain word (`rm -r test`,
// `git checkout HEAD~1 -- test`): there a folder reaches every file in it.
static FOLDER_CMDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(^|\s)(git\s+(checkout|restore|stash|reset|rm|mv|clean|apply)|rm|mv|cp|ln|rsync|install|find)\b",
    )
    .expect("static regex")
});
// Anything that signs or sends: an agent reads the chain, it does not write
// to it.
static CHAIN_WRITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\bcast\s+(send|publish|mktx|wallet)\b|\bforge\s+create\b|\bforge\s+script\b[^;&|]*--broadcast\b|--private-key\b|--mnemonic\b|--ledger\b|--trezor\b|--keystore\b|--unlocked\b|\beth_send(Raw)?Transaction\b",
    )
    .expect("static regex")
});
// A commit that skips the commit check.
static NO_VERIFY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bgit\b[^;&|]*\bcommit\b[^;&|]*(--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)")
        .expect("static regex")
});
// Where git finds the commit check: moving or editing it skips the check.
static GIT_HOOKS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)core\.hookspath|\.git/hooks\b").expect("static regex"));

// The words of a command roughly as the shell splits them, with quotes and
// backslashes dropped, so test/C"".t.sol and test/C\.t.sol read as written.
fn words(cmd: &str) -> Vec<String> {
    cmd.split(|c: char| c.is_whitespace() || ";&|<>()`=".contains(c))
        .map(|w| {
            w.chars()
                .filter(|c| !"'\"\\".contains(*c))
                .collect::<String>()
        })
        .map(|w| w.trim_start_matches('$').to_string())
        .filter(|w| !w.is_empty() && !w.starts_with('-'))
        .collect()
}

// The guarded path a command names, read from the folder it runs in and
// from any folder it changes into first.
fn named_in(cmd: &str, map: &RootsMap, rel: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let mut bases = vec![String::new()];
    for pair in words(cmd).windows(2) {
        if matches!(pair[0].as_str(), "cd" | "pushd") {
            bases.push(pair[1].clone());
        }
    }
    // Judged a segment at a time, so `forge test && rm -r out` does not read
    // the word "test" as the folder rm acts on.
    for seg in cmd.split(['\n', ';', '&', '|']) {
        let folders = FOLDER_CMDS.is_match(seg);
        for w in &words(seg) {
            for b in &bases {
                let joined = if b.is_empty() || w.starts_with('/') || w.starts_with('~') {
                    w.clone()
                } else {
                    format!("{b}/{w}")
                };
                let hit = match rel(&joined) {
                    Some(r) if r.contains(['*', '?']) => glob_hit(map, &r),
                    Some(r) => guarded_hit(map, &r, folders),
                    // The project folder itself.
                    None if folders && rel(&format!("{joined}/x")).is_some() => {
                        guarded(map).into_iter().next()
                    }
                    None => None,
                };
                if hit.is_some() {
                    return hit;
                }
            }
            // As written, for a path the resolution above cannot place.
            if let Some(hit) = guarded(map)
                .into_iter()
                .find(|g| w.contains(g.trim_end_matches('/')))
            {
                return Some(hit);
            }
        }
    }
    None
}

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
        && let Some(path) = input.file_path.as_deref()
        && GIT_HOOKS.is_match(&path.replace('\\', "/"))
    {
        return deny(
            "VIBloom: the git hooks hold the commit check; a builder does not change them.".into(),
        );
    }
    if EDIT_TOOLS.contains(&input.tool_name.as_str())
        && let Some(r) = input.file_path.as_deref().and_then(rel)
        && guarded_hit(map, &r, false).is_some()
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
        if GIT_HOOKS.is_match(cmd)
            && (WRITES.is_match(cmd) || cmd.to_lowercase().contains("core.hookspath"))
        {
            return deny(
                "VIBloom: the git hooks hold the commit check; a builder does not change them."
                    .into(),
            );
        }
        if WRITES.is_match(cmd)
            && let Some(hit) = named_in(cmd, map, rel)
        {
            return deny(format!(
                "VIBloom: this command looks like it writes to {hit}, which is guarded."
            ));
        }
    }
    HookOutput::default()
}

/// Before a tool runs while the map cannot be read. Which tests are protected
/// is then unknown, so nothing is written until the map is fixed: a map
/// broken on purpose must not switch the guard off.
pub fn pre_tool_unreadable(input: &HookInput, role: Role, problem: &str) -> HookOutput {
    if role == Role::Verifier {
        return HookOutput::default();
    }
    let cmd = input.command.as_deref().unwrap_or_default();
    let writes = EDIT_TOOLS.contains(&input.tool_name.as_str())
        || (input.tool_name == "Bash"
            && (WRITES.is_match(cmd)
                || cmd.contains("VIBLOOM_ROLE")
                || CHAIN_WRITE.is_match(cmd)
                || NO_VERIFY.is_match(cmd)
                || GIT_HOOKS.is_match(cmd)));
    if !writes {
        return HookOutput::default();
    }
    emit(json!({ "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": format!(
            "VIBloom: {problem}\nUntil it is fixed nothing is guarded reliably, so files are not changed. Ask the person to fix the map."
        ),
    }}))
}

pub fn summary(views: &[NodeView]) -> String {
    views
        .iter()
        .filter(|v| troubled(v))
        .map(|v| {
            let mut parts = vec![format!("{} [{}] {}", v.id, label(v), v.title)];
            if let Some(r) = &v.reason {
                parts.push(if v.evidence == crate::derive::Evidence::TestChanged {
                    r.clone()
                } else {
                    format!("failure: {r}")
                });
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
        let watching = |tested: bool| -> Vec<&str> {
            views
                .iter()
                .filter(|v| {
                    v.test_file.is_some() == tested && v.watch.iter().any(|w| covers(w, &r))
                })
                .map(|v| v.id.as_str())
                .collect()
        };
        let (tested, by_hand) = (watching(true), watching(false));
        // Only a node with a test goes pending review; one without has no run
        // to compare with, so saying it went pending would not be true.
        let mut notes = Vec::new();
        if !tested.is_empty() {
            notes.push(format!(
                "VIBloom: {r} is watched by {}. Their evidence is now pending review; run the tests before calling this done.",
                tested.join(", ")
            ));
        }
        if !by_hand.is_empty() {
            let one = by_hand.len() == 1;
            notes.push(format!(
                "VIBloom: {r} is also watched by {}, which no test checks, so {} state never changes with the file: a person should re-read {} against this change.",
                by_hand.join(", "),
                if one { "its" } else { "their" },
                if one { "it" } else { "them" }
            ));
        }
        if !notes.is_empty() {
            return context(notes.join("\n"));
        }
    }
    HookOutput::default()
}

pub fn stop(input: &HookInput, views: &[NodeView], log_problems: &[String]) -> HookOutput {
    // Only the verifier can repair the log, so the agent is told once and
    // then let go, like any other trouble it cannot fix itself.
    if !log_problems.is_empty() && input.stop_hook_active {
        return emit(
            json!({ "systemMessage": "VIBloom: stopping with a run log that fails verification." }),
        );
    }
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

/// Before the agent stops while the map cannot be read: told once, as for
/// any other trouble.
pub fn stop_unreadable(input: &HookInput, problem: &str) -> HookOutput {
    if input.stop_hook_active {
        return emit(
            json!({ "systemMessage": "VIBloom: stopping with a map that cannot be read." }),
        );
    }
    emit(json!({
        "decision": "block",
        "reason": format!("VIBloom: {problem}\nNothing can be checked until the map is fixed. Tell the person; do not rewrite it yourself."),
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
            accepts: vec![],
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

    // Like the CLI's: relative paths are read from /repo, and ".." is folded.
    fn rel_from_root(p: &str) -> Option<String> {
        let p = p.strip_prefix("/repo/").unwrap_or(p);
        if p.starts_with('/') {
            return None;
        }
        let mut out: Vec<&str> = Vec::new();
        for part in p.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    out.pop()?;
                }
                x => out.push(x),
            }
        }
        (!out.is_empty()).then(|| out.join("/"))
    }

    #[test]
    fn denies_shell_writes_that_name_a_guarded_path_another_way() {
        for cmd in [
            "sed -i s/a/b/ ./test/./C.t.sol",
            "sed -i s/a/b/ test//C.t.sol",
            "sed -i s/a/b/ test/C*.sol",
            "sed -i s/a/b/ test/C\"\".t.sol",
            "sed --in-place s/a/b/ test/C.t.sol",
            "sed -i s/a/b/ TEST/C.t.sol",
            "cd test && sed -i s/a/b/ C.t.sol",
            "perl -pi -e s/64/1/ foundry.toml",
            "python3 -c \"open('test/C.t.sol','w').write('')\"",
            "node -e \"require('fs').writeFileSync('.vibloom/roots.json','')\"",
            "install /tmp/x test/C.t.sol",
            "rsync /tmp/x test/C.t.sol",
            "ln -sf /tmp/x test/C.t.sol",
            "rm -r test",
            "find test -name '*.sol' -exec sed -i s/a/b/ {} +",
            "git checkout HEAD~1 -- test",
            "git checkout HEAD~1 -- .",
            "git restore --source=HEAD~1 test",
            "git -c core.hooksPath=/dev/null commit -m x",
            "git config core.hooksPath /dev/null",
            "rm .git/hooks/pre-commit",
            "cast rpc eth_sendRawTransaction 0xdead",
        ] {
            assert!(
                denied(&pre_tool(&bash(cmd), &map(), Role::Builder, &rel_from_root)),
                "{cmd}"
            );
        }
        for cmd in [
            "forge test > /tmp/out.txt",
            "forge test && rm -rf out",
            "grep -rn total test/ > /tmp/g",
            "cat test/C.t.sol | head",
            "cp src/C.sol src/D.sol",
            "cd src && cp C.sol D.sol",
            "find src -name '*.sol' -exec grep -l total {} +",
            "git log -- test/",
            "git stash pop",
            "python3 scripts/gen.py",
            "cat .git/hooks/pre-commit",
        ] {
            assert_eq!(
                pre_tool(&bash(cmd), &map(), Role::Builder, &rel_from_root),
                HookOutput::default(),
                "{cmd}"
            );
        }
        assert!(denied(&pre_tool(
            &edit("/repo/.git/hooks/pre-commit"),
            &map(),
            Role::Builder,
            &rel_from_root
        )));
        assert!(denied(&pre_tool(
            &edit("/repo/Test/c.t.sol"),
            &map(),
            Role::Builder,
            &rel_from_root
        )));
    }

    #[test]
    fn writes_nothing_while_the_map_cannot_be_read() {
        let problem = ".vibloom/roots.json is not valid JSON";
        assert!(denied(&pre_tool_unreadable(
            &edit("/repo/test/C.t.sol"),
            Role::Builder,
            problem
        )));
        assert!(denied(&pre_tool_unreadable(
            &bash("export VIBLOOM_ROLE=verifier"),
            Role::Builder,
            problem
        )));
        assert_eq!(
            pre_tool_unreadable(&bash("cat src/C.sol"), Role::Builder, problem),
            HookOutput::default()
        );
        assert_eq!(
            pre_tool_unreadable(&edit("/repo/test/C.t.sol"), Role::Verifier, problem),
            HookOutput::default()
        );
        let first = json_of(&stop_unreadable(&HookInput::default(), problem));
        assert_eq!(first["decision"], "block");
        let again = HookInput {
            stop_hook_active: true,
            ..Default::default()
        };
        assert!(
            json_of(&stop_unreadable(&again, problem))
                .get("decision")
                .is_none()
        );
    }

    #[test]
    fn says_which_watchers_no_test_checks_after_an_edit() {
        let mut asm = view(Evidence::None);
        asm.id = "asm.only-add".into();
        asm.test_file = None;
        asm.watch = vec!["src/C.sol".into()];
        let out = json_of(&post_tool(
            &edit("/repo/src/C.sol"),
            &[view(Evidence::Holds), asm],
            false,
            &rel,
        ));
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap_or_default();
        assert!(
            text.contains("watched by inv.sum. Their evidence is now pending review"),
            "{text}"
        );
        assert!(
            text.contains("also watched by asm.only-add, which no test checks, so its state never changes with the file: a person should re-read it"),
            "{text}"
        );
        assert!(!text.contains("inv.sum, asm.only-add"), "{text}");
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
        // Only the verifier can repair the log: after one try the agent may stop.
        let out = json_of(&stop(
            &again,
            &[view(Evidence::Holds)],
            &["entry 1 was changed".into()],
        ));
        assert!(out.get("decision").is_none(), "{out}");
        assert!(
            out["systemMessage"]
                .as_str()
                .unwrap_or_default()
                .contains("fails verification")
        );
    }
}
