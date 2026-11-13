//! The record of every run, one JSON line each, chained by hash: an entry cannot
//! be changed or removed without breaking every hash after it.

use crate::forge::Outcome;
use crate::hash::{canonical, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const GENESIS: &str = "genesis";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunEntry {
    pub at: String,
    pub command: Vec<String>,
    pub outcomes: Vec<Outcome>,
    /// Hash of every watched file when the run started; None when it did not exist.
    pub files: BTreeMap<String, Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub seq: u64,
    pub prev: String,
    pub hash: String,
}

pub struct RunBody {
    pub at: String,
    pub command: Vec<String>,
    pub outcomes: Vec<Outcome>,
    pub files: BTreeMap<String, Option<String>>,
    pub error: Option<String>,
}

// The hash covers every field of the entry as stored, except the hash itself.
fn hash_of(entry: &Value) -> String {
    let mut v = entry.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("hash");
    }
    sha256_hex(canonical(&v).as_bytes())
}

pub fn next_entry(last: Option<&RunEntry>, body: RunBody) -> RunEntry {
    let mut e = RunEntry {
        at: body.at,
        command: body.command,
        outcomes: body.outcomes,
        files: body.files,
        error: body.error,
        seq: last.map_or(0, |l| l.seq) + 1,
        prev: last.map_or_else(|| GENESIS.to_string(), |l| l.hash.clone()),
        hash: String::new(),
    };
    e.hash = hash_of(&serde_json::to_value(&e).unwrap_or(Value::Null));
    e
}

#[derive(Debug, Default)]
pub struct ReadLog {
    pub entries: Vec<RunEntry>,
    pub problems: Vec<String>,
}

/// Entries up to the first broken link; anything after it is not trusted.
pub fn read_log(text: &str) -> ReadLog {
    let mut log = ReadLog::default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    for (i, line) in lines.iter().enumerate() {
        let raw: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                log.problems.push(format!("line {} is not JSON", i + 1));
                break;
            }
        };
        let last = log.entries.last();
        let seq = raw.get("seq").and_then(Value::as_u64).unwrap_or(0);
        let prev = raw.get("prev").and_then(Value::as_str).unwrap_or_default();
        let expected_prev = last.map_or(GENESIS, |l| l.hash.as_str());
        let last_seq = last.map_or(0, |l| l.seq);
        if prev != expected_prev || seq != last_seq + 1 {
            log.problems
                .push(format!("entry {seq} does not follow entry {last_seq}"));
            break;
        }
        let stored = raw.get("hash").and_then(Value::as_str).unwrap_or_default();
        if hash_of(&raw) != stored {
            log.problems
                .push(format!("entry {seq} was changed after it was written"));
            break;
        }
        match serde_json::from_value::<RunEntry>(raw) {
            Ok(e) => log.entries.push(e),
            Err(_) => {
                log.problems.push(format!("entry {seq} is not a run entry"));
                break;
            }
        }
    }
    let ignored = lines.len().saturating_sub(log.entries.len() + 1);
    if !log.problems.is_empty() && ignored > 0 {
        let noun = if ignored == 1 { "entry" } else { "entries" };
        log.problems
            .push(format!("{ignored} {noun} after it ignored"));
    }
    log
}

/// A branch may only add runs to the log it started from. Its log must keep
/// every base entry, unchanged and in order; a regenerated log, even one whose
/// own chain is valid, does not.
pub fn extends_log(base: &[RunEntry], head: &[RunEntry]) -> Vec<String> {
    if head.len() < base.len() {
        return vec![format!(
            "the log has {} runs, fewer than the {} on the base",
            head.len(),
            base.len()
        )];
    }
    for (i, b) in base.iter().enumerate() {
        if head.get(i).map(|h| &h.hash) != Some(&b.hash) {
            return vec![format!(
                "run {} differs from the base: the log was rewritten, not extended",
                b.seq
            )];
        }
    }
    vec![]
}

pub fn to_line(e: &RunEntry) -> String {
    let mut s = serde_json::to_string(e).unwrap_or_default();
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::Status;

    fn body(status: Status, at: &str) -> RunBody {
        RunBody {
            at: at.into(),
            command: vec!["forge".into(), "test".into(), "--json".into()],
            outcomes: vec![Outcome {
                file: "t.sol".into(),
                contract: "T".into(),
                name: "invariant_a".into(),
                status,
                reason: None,
            }],
            files: BTreeMap::from([("src/A.sol".into(), Some("abc".into()))]),
            error: None,
        }
    }

    fn chain() -> Vec<RunEntry> {
        let a = next_entry(None, body(Status::Fail, "2026-11-13T00:00:00.000Z"));
        let b = next_entry(Some(&a), body(Status::Pass, "2026-11-13T00:00:00.000Z"));
        vec![a, b]
    }

    fn text(es: &[RunEntry]) -> String {
        es.iter().map(to_line).collect()
    }

    #[test]
    fn reads_back_an_intact_chain() {
        let es = chain();
        let r = read_log(&text(&es));
        assert_eq!(r.entries, es);
        assert!(r.problems.is_empty());
    }

    #[test]
    fn stops_at_an_entry_changed_after_it_was_written() {
        let mut es = chain();
        es[0].outcomes[0].status = Status::Pass;
        let r = read_log(&text(&es));
        assert!(r.entries.is_empty());
        assert_eq!(
            r.problems,
            vec![
                "entry 1 was changed after it was written",
                "1 entry after it ignored"
            ]
        );
    }

    #[test]
    fn detects_a_removed_or_relinked_entry() {
        let es = chain();
        assert!(read_log(&text(&es[1..])).problems[0].contains("does not follow"));
        let fake = next_entry(None, body(Status::Pass, "2026-11-13T00:00:00.000Z"));
        let mut b = es[1].clone();
        b.prev = fake.hash;
        let r = read_log(&text(&[es[0].clone(), b]));
        assert_eq!(r.entries.len(), 1);
        assert!(r.problems[0].contains("does not follow"));
    }

    #[test]
    fn extends_only_by_appending() {
        let es = chain();
        assert!(extends_log(&es[..1], &es).is_empty());
        let regenerated = next_entry(None, body(Status::Pass, "2026-11-14T00:00:00.000Z"));
        assert!(
            read_log(&text(std::slice::from_ref(&regenerated)))
                .problems
                .is_empty()
        );
        assert_eq!(
            extends_log(&es[..1], &[regenerated]),
            vec!["run 1 differs from the base: the log was rewritten, not extended"]
        );
        assert_eq!(
            extends_log(&es, &es[..1]),
            vec!["the log has 1 runs, fewer than the 2 on the base"]
        );
    }
}
