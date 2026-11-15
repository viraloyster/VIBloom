//! Reads a JUnit XML report, the format most test runners can write
//! (cargo-nextest, pytest, Jest, mocha, Go). One outcome per `<testcase>`.

use crate::forge::{Outcome, RunnerOutputError, Status};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

fn attr(e: &BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .and_then(|a| a.unescape_value().ok())
        .map(|v| v.into_owned())
}

// Reporters write the file absolute, relative or with backslashes; the map
// holds it relative to the project root with forward slashes.
fn relative(file: &str, root: &str) -> String {
    let f = file.replace('\\', "/");
    let r = root.replace('\\', "/");
    let r = r.trim_end_matches('/');
    match f.strip_prefix(r) {
        Some(rest) if !r.is_empty() && rest.starts_with('/') => rest[1..].to_string(),
        _ => f.trim_start_matches("./").to_string(),
    }
}

fn clip(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.chars().take(500).collect())
}

pub fn parse_junit(xml: &str, root: &str) -> Result<Vec<Outcome>, RunnerOutputError> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut suite_file: Option<String> = None;
    let mut case: Option<Outcome> = None;
    // Inside a <failure> or <error> without a message: its text is the reason.
    let mut text: Option<String> = None;
    let mut saw_root = false;
    loop {
        let ev = reader
            .read_event()
            .map_err(|_| RunnerOutputError("the JUnit report could not be parsed".into()))?;
        match &ev {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"testsuites" => {
                saw_root = true;
            }
            Event::Start(e) if e.name().as_ref() == b"testsuite" => {
                saw_root = true;
                suite_file = attr(e, b"file");
            }
            Event::End(e) if e.name().as_ref() == b"testsuite" => suite_file = None,
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"testcase" => {
                let empty = matches!(ev, Event::Empty(_));
                let contract = attr(e, b"classname").unwrap_or_default();
                let file = attr(e, b"file")
                    .or_else(|| suite_file.clone())
                    .map(|f| relative(&f, root))
                    .unwrap_or_default();
                let c = Outcome {
                    file,
                    contract,
                    name: attr(e, b"name").unwrap_or_default(),
                    status: Status::Pass,
                    reason: None,
                    fuzz: None,
                };
                if empty {
                    out.push(c);
                } else {
                    case = Some(c);
                }
            }
            Event::Start(e) | Event::Empty(e)
                if matches!(e.name().as_ref(), b"failure" | b"error" | b"skipped") =>
            {
                let empty = matches!(ev, Event::Empty(_));
                if let Some(c) = case.as_mut() {
                    let skipped = e.name().as_ref() == b"skipped";
                    // A failure outranks a skip reported for the same case.
                    if !(skipped && c.status == Status::Fail) {
                        c.status = if skipped { Status::Skip } else { Status::Fail };
                        c.reason = attr(e, b"message").and_then(|m| clip(&m));
                        text = (!empty && c.reason.is_none()).then(String::new);
                    }
                }
            }
            // Text arrives in pieces, split at each entity reference.
            Event::Text(t) => {
                if let (Some(buf), Ok(s)) = (text.as_mut(), t.decode()) {
                    buf.push_str(&s);
                }
            }
            Event::GeneralRef(r) => {
                if let Some(buf) = text.as_mut() {
                    let name = String::from_utf8_lossy(r);
                    let ch = match name.as_ref() {
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "amp" => Some('&'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => r.resolve_char_ref().ok().flatten(),
                    };
                    if let Some(c) = ch {
                        buf.push(c);
                    }
                }
            }
            Event::CData(t) => {
                if let Some(buf) = text.as_mut() {
                    buf.push_str(&String::from_utf8_lossy(t));
                }
            }
            Event::End(e) if matches!(e.name().as_ref(), b"failure" | b"error") => {
                if let (Some(c), Some(buf)) = (case.as_mut(), text.take()) {
                    c.reason = clip(&buf);
                }
            }
            Event::End(e) if e.name().as_ref() == b"testcase" => {
                if let Some(c) = case.take() {
                    out.push(c);
                }
            }
            _ => {}
        }
    }
    if case.is_some() {
        return Err(RunnerOutputError(
            "the JUnit report ends inside a test case".into(),
        ));
    }
    if !saw_root {
        return Err(RunnerOutputError(
            "the report has no <testsuites> or <testsuite>".into(),
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEXTEST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="3" failures="1" errors="0">
  <testsuite name="vault" tests="3" disabled="1" errors="0" failures="1">
    <testcase name="tests::total_matches_deposits" classname="vault" time="0.01"/>
    <testcase name="tests::no_overdraw" classname="vault" time="0.02">
      <failure type="test failure">thread 'tests::no_overdraw' panicked at src/lib.rs:40:9:
assertion failed: balance &gt;= 0</failure>
      <system-out></system-out>
    </testcase>
    <testcase name="tests::slow" classname="vault"><skipped message="ignored"/></testcase>
  </testsuite>
</testsuites>"#;

    #[test]
    fn reads_passes_failures_and_skips() {
        let o = parse_junit(NEXTEST, "/repo").expect("report");
        assert_eq!(o.len(), 3);
        assert_eq!(o[0].status, Status::Pass);
        assert_eq!(o[0].contract, "vault");
        assert_eq!(o[0].name, "tests::total_matches_deposits");
        assert_eq!(o[0].file, "");
        assert_eq!(o[1].status, Status::Fail);
        let reason = o[1].reason.as_deref().unwrap_or_default();
        assert!(reason.starts_with("thread 'tests::no_overdraw' panicked"));
        assert!(reason.contains("balance >= 0"));
        assert_eq!(o[2].status, Status::Skip);
        assert_eq!(o[2].reason.as_deref(), Some("ignored"));
    }

    #[test]
    fn takes_the_file_from_the_case_or_its_suite_relative_to_the_root() {
        let xml = r#"<testsuites>
          <testsuite name="Vault" file="/repo/test/vault.js">
            <testcase classname="Vault" name="keeps totals"><failure message="expected 3 to equal 4"/></testcase>
          </testsuite>
          <testsuite name="tests.test_math">
            <testcase classname="tests.test_math" name="test_add" file="tests\test_math.py"/>
          </testsuite>
        </testsuites>"#;
        let o = parse_junit(xml, "/repo/").expect("report");
        assert_eq!(o[0].file, "test/vault.js");
        assert_eq!(o[0].reason.as_deref(), Some("expected 3 to equal 4"));
        assert_eq!(o[1].file, "tests/test_math.py");
        assert_eq!(o[1].status, Status::Pass);
    }

    #[test]
    fn refuses_what_is_not_a_junit_report() {
        assert!(parse_junit("<html><body/></html>", "/").is_err());
        assert!(parse_junit("<testsuites><testcase", "/").is_err());
        assert_eq!(parse_junit("<testsuites/>", "/"), Ok(vec![]));
    }
}
