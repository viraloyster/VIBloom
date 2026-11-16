use crate::cli::Fallible;
use crate::hooks::{HookInput, HookOutput, Role, post_tool, pre_tool, stop, test_run};
use crate::paths::relative_to;
use crate::runner::run;
use crate::store::{find_root, load_log, load_map, state_dir, views};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn hook(kind: &str, stdin: &str, role: Role, cwd: &Path) -> Fallible<HookOutput> {
    let Ok(raw) = serde_json::from_str::<Value>(if stdin.trim().is_empty() { "{}" } else { stdin })
    else {
        return Ok(HookOutput {
            stderr: Some("VIBloom: the hook input was not JSON; nothing checked.".into()),
            stdout: None,
        });
    };
    let input = HookInput::from_json(&raw);
    let base = input
        .cwd
        .as_ref()
        .map_or_else(|| cwd.to_path_buf(), PathBuf::from);
    let Some(root) = find_root(&base) else {
        return Ok(HookOutput::default());
    };
    let rel = |p: &str| relative_to(&root, &base, p);
    let map = match load_map(&root) {
        Ok(m) => m,
        Err(e) => {
            return Ok(match kind {
                "pre-tool" => crate::hooks::pre_tool_unreadable(&input, role, &e),
                "stop" => crate::hooks::stop_unreadable(&input, &e),
                _ => HookOutput {
                    stderr: Some(e),
                    stdout: None,
                },
            });
        }
    };
    match kind {
        "pre-tool" => Ok(pre_tool(&input, &map, role, &rel)),
        "post-tool" => {
            // After a test run, the guard runs the tests itself and records
            // that; the agent's own output is never parsed or trusted.
            let filters = (input.tool_name == "Bash")
                .then(|| test_run(&map, input.command.as_deref().unwrap_or_default()))
                .flatten();
            let ran = filters.is_some();
            let vs = match filters {
                Some(f) => run(&root, &f)?.views,
                None => views(&root)?,
            };
            let out = post_tool(&input, &vs, ran, &rel);
            // The same note after every edit of the same file would only fill
            // the agent's context: it is given once per file and run.
            if !ran && out.stdout.is_some() {
                let seq = load_log(&root).entries.last().map_or(0, |e| e.seq);
                let key = format!(
                    "{seq}\t{}",
                    input.file_path.as_deref().and_then(rel).unwrap_or_default()
                );
                let path = state_dir(&root).join("vibloom-notified");
                let seen = fs::read_to_string(&path).unwrap_or_default();
                if seen.lines().any(|l| l == key) {
                    return Ok(HookOutput::default());
                }
                // Notes from earlier runs no longer matter.
                let kept: String = seen
                    .lines()
                    .filter(|l| l.starts_with(&format!("{seq}\t")))
                    .map(|l| format!("{l}\n"))
                    .collect();
                let _ = fs::write(&path, format!("{kept}{key}\n"));
            }
            Ok(out)
        }
        "stop" => Ok(stop(&input, &views(&root)?, &load_log(&root).problems)),
        other => Ok(HookOutput {
            stderr: Some(format!("VIBloom: unknown hook {other}")),
            stdout: None,
        }),
    }
}
