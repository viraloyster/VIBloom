//! Child processes: the runner and Foundry's tools, with a time limit.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) struct Finished {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

// The runner with a time limit: a test that hangs must not hang the agent's
// hook or CI for ever. Output is drained on threads so a full pipe cannot
// block the child.
// A Foundry tool where foundryup puts it, when it is there.
pub(crate) fn foundry_bin(exe: &str) -> Option<PathBuf> {
    if !matches!(exe, "forge" | "cast" | "anvil") {
        return None;
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let dir = PathBuf::from(home).join(".foundry").join("bin");
    [exe.to_string(), format!("{exe}.exe")]
        .iter()
        .map(|name| dir.join(name))
        .find(|p| p.is_file())
}

pub(crate) fn run_child(
    exe: &str,
    args: &[String],
    root: &Path,
    limit: u64,
) -> Result<Finished, String> {
    use std::io::Read as _;
    use std::process::Stdio;
    let spawn = |program: &std::ffi::OsStr| {
        Command::new(program)
            .args(args)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    };
    let mut child = match spawn(exe.as_ref()) {
        // An editor or an agent often starts with a PATH that lacks the
        // folder foundryup installs into, though a terminal has it.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => foundry_bin(exe)
            .and_then(|p| spawn(p.as_os_str()).ok())
            .ok_or_else(|| {
                format!(
                    "could not start {exe}: it is not on the PATH this process was started with"
                )
            })?,
        other => other.map_err(|e| format!("could not start {exe}: {e}"))?,
    };
    let drain = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed().as_secs() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "the runner did not finish in {limit} s and was stopped (\"timeout\" in the map sets the limit)"
                ));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(e) => return Err(format!("could not wait for {exe}: {e}")),
        }
    }
    Ok(Finished {
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

// The JSON a tool printed last: on one line after its logs, or, as newer
// forge prints `config --json`, the whole output pretty-printed.
pub(crate) fn last_json(text: &str) -> Option<Value> {
    if let Ok(v @ Value::Object(_)) = serde_json::from_str(text.trim()) {
        return Some(v);
    }
    let line = text.lines().map(str::trim).rfind(|l| l.starts_with('{'))?;
    serde_json::from_str(line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_json_on_its_last_line_or_pretty_printed() {
        let logs = "Compiling...\n{\"src\":\"contracts\"}\n";
        assert_eq!(last_json(logs), Some(json!({ "src": "contracts" })));
        let pretty = "{\n  \"src\": \"contracts\",\n  \"out\": \"artifacts/foundry\"\n}\n";
        assert_eq!(
            last_json(pretty).and_then(|v| v.get("out").cloned()),
            Some(json!("artifacts/foundry"))
        );
        assert_eq!(last_json("no json here"), None);
    }
}
