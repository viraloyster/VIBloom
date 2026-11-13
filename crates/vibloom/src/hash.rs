//! Hashing and the canonical JSON every hash is taken over. The output matches
//! JavaScript's `JSON.stringify` with keys sorted, so logs written by either
//! implementation verify in the other.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// A string as `JSON.stringify` writes it: only quotes, backslashes and
/// control characters are escaped; everything else is written as is.
pub fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// JavaScript compares strings by UTF-16 code units, which orders characters
// outside the BMP differently from a byte comparison.
fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Sorted keys, no whitespace: the same value always hashes the same way.
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => js_string(s),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| js_cmp(a, b));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", js_string(k), canonical(&map[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_javascript_canonical_json_and_its_hash() {
        // Computed with Node: the JavaScript canonical() over the same value.
        let v = json!({
            "k": "\u{e9}\u{2028}\u{1F600}\u{1}\u{7f}/",
            "\u{e9}": 1,
            "z": [null, true, "a\"b\\c\n"],
            "B": 2,
            "a": -3,
            "\u{FF01}": "x",
            "\u{1F600}": "y"
        });
        let c = canonical(&v);
        assert_eq!(
            c,
            "{\"B\":2,\"a\":-3,\"k\":\"\u{e9}\u{2028}\u{1F600}\\u0001\u{7f}/\",\"z\":[null,true,\"a\\\"b\\\\c\\n\"],\"\u{e9}\":1,\"\u{1F600}\":\"y\",\"\u{FF01}\":\"x\"}"
        );
        assert_eq!(
            sha256_hex(c.as_bytes()),
            "190c0dda1b7f5d79c9e5ec43bd91a034ac200cf90acd610d435552eb1fe762b5"
        );
    }
}
