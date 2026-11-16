//! What agents propose. An agent never writes the map: its proposal is kept
//! apart, as hypothetical, until a person accepts it into the map or rejects it.

use crate::map::{
    Kind, RootNode, RootsMap, Stance, TestRef, parse_map, safe_path, serialize_map, test_name,
    valid_id,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub watch: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<TestRef>,
    /// Where it comes from: code lines, documents, reads of the chain.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    /// The id the node should get if it is accepted and the id is still free.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    /// Who proposed it, as the agent described itself; informational only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub decide: String,
    pub decision: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
}

#[derive(Debug, Default)]
pub struct Book {
    pub proposals: Vec<Proposal>,
    pub decisions: Vec<Decision>,
}

impl Book {
    pub fn read(text: &str) -> Self {
        let mut book = Self::default();
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if v.get("decide").is_some() {
                if let Ok(d) = serde_json::from_value(v) {
                    book.decisions.push(d);
                }
            } else if let Ok(p) = serde_json::from_value(v) {
                book.proposals.push(p);
            }
        }
        book
    }

    pub fn pending(&self) -> Vec<&Proposal> {
        let decided: HashSet<&str> = self.decisions.iter().map(|d| d.decide.as_str()).collect();
        self.proposals
            .iter()
            .filter(|p| !decided.contains(p.id.as_str()))
            .collect()
    }

    /// One more than the highest id seen, so a line lost to damage or a
    /// hand edit never lets two proposals share an id.
    pub fn next_id(&self) -> String {
        let n = |id: &str| id.strip_prefix('p').and_then(|d| d.parse::<usize>().ok());
        let top = self
            .proposals
            .iter()
            .filter_map(|p| n(&p.id))
            .chain(self.decisions.iter().filter_map(|d| n(&d.decide)))
            .max()
            .unwrap_or(0);
        format!("p{}", top.max(self.proposals.len()) + 1)
    }
}

pub struct Draft {
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
    pub depends_on: Vec<String>,
    pub watch: Vec<String>,
    pub test: Option<TestRef>,
    pub evidence: Vec<String>,
    pub node_id: Option<String>,
    pub by: Option<String>,
}

/// Checks a draft against the map as it is, so a person only ever reviews
/// proposals that could be accepted.
pub fn propose(
    map: &RootsMap,
    book: &Book,
    draft: Draft,
    at: String,
) -> Result<Proposal, Vec<String>> {
    let mut errors = Vec::new();
    let kind = Kind::parse(&draft.kind);
    if kind.is_none() {
        errors.push("kind must be one of assumption, invariant, intention".into());
    }
    if draft.title.trim().is_empty() {
        errors.push("title is required".into());
    }
    // What the verifier reads one line per entry must not hold a line break
    // that forges another entry.
    let one_line = |s: &str| !s.chars().any(char::is_control);
    if !one_line(&draft.title)
        || !draft.evidence.iter().all(|e| one_line(e))
        || !draft.by.as_deref().is_none_or(one_line)
    {
        errors.push("title, evidence and by must each be one line of text".into());
    }
    let ids: HashSet<&str> = map.nodes.iter().map(|n| n.id.as_str()).collect();
    for d in &draft.depends_on {
        if !ids.contains(d.as_str()) {
            errors.push(format!(
                "depends on unknown {d}; propose that node first or depend on one in the map"
            ));
        }
    }
    if !draft.watch.iter().all(|w| safe_path(w)) {
        errors.push("watch must list relative paths inside the repository".into());
    }
    if let Some(t) = &draft.test
        && (!safe_path(&t.file) || t.name.trim().is_empty())
    {
        errors.push("test needs a relative file and a name".into());
    }
    if kind == Some(Kind::Invariant) && draft.test.is_none() {
        errors.push("an invariant needs a test".into());
    }
    // A proposal with nothing behind it is an opinion: the reviewer has to be
    // able to check where it comes from.
    let evidence: Vec<String> = draft
        .evidence
        .iter()
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();
    if evidence.is_empty() {
        errors.push(
            "evidence is required: where this comes from (file:line, a document's URL and section, a read of the chain with its block)"
                .into(),
        );
    }
    if let Some(id) = &draft.node_id
        && !valid_id(id)
    {
        errors.push(format!(
            "id {id} is not valid: lowercase letters, digits, dots and dashes"
        ));
    }
    if book.pending().iter().any(|p| p.title == draft.title.trim()) {
        errors.push("a pending proposal already says this".into());
    }
    if map.nodes.iter().any(|n| n.title == draft.title.trim()) {
        errors.push("a node in the map already says this".into());
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(Proposal {
        id: book.next_id(),
        at,
        kind: draft.kind,
        title: draft.title.trim().to_string(),
        detail: draft.detail.filter(|d| !d.trim().is_empty()),
        depends_on: draft.depends_on,
        watch: draft.watch,
        test: draft.test,
        evidence,
        node_id: draft.node_id,
        by: draft.by,
    })
}

// A title as an id: lowercase words joined by dashes, cut at a word within
// 32 characters so an id never ends in half a word; a longer first word stays
// whole.
fn slug(title: &str) -> String {
    let mut s = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if c != '\'' && !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    let mut out = String::new();
    for word in s.split('-').filter(|w| !w.is_empty()) {
        if !out.is_empty() && out.len() + 1 + word.len() > 32 {
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(word);
    }
    if out.is_empty() { "node".into() } else { out }
}

/// An id nothing in the map uses yet: the kind's prefix and the title.
pub fn fresh_id(map: &RootsMap, kind: Kind, title: &str) -> String {
    let prefix = match kind {
        Kind::Assumption => "asm",
        Kind::Invariant => "inv",
        Kind::Intention => "int",
    };
    let base = format!("{prefix}.{}", slug(title));
    let ids: HashSet<&str> = map.nodes.iter().map(|n| n.id.as_str()).collect();
    let mut id = base.clone();
    let mut i = 2;
    while ids.contains(id.as_str()) {
        id = format!("{base}-{i}");
        i += 1;
    }
    debug_assert!(valid_id(&id));
    id
}

/// The map with one more node. The result must still be a valid map, checked
/// the same way as one written by hand.
pub fn with_node(map: &RootsMap, node: RootNode) -> Result<RootsMap, Vec<String>> {
    let mut out = map.clone();
    out.nodes.push(node);
    let reparsed: Value =
        serde_json::from_str(&serialize_map(&out)).map_err(|e| vec![e.to_string()])?;
    parse_map(&reparsed)
}

/// The map with the proposal added. Assumptions enter as hypothetical; the
/// person adopts them later by editing the map.
pub fn accept(map: &RootsMap, p: &Proposal) -> Result<(RootsMap, String), Vec<String>> {
    let Some(kind) = Kind::parse(&p.kind) else {
        return Err(vec!["the proposal's kind is not valid".into()]);
    };
    // The id the proposal asked for, unless something took it meanwhile.
    let id = p
        .node_id
        .clone()
        .filter(|id| valid_id(id) && !map.nodes.iter().any(|n| n.id == *id))
        .unwrap_or_else(|| fresh_id(map, kind, &p.title));
    let node = RootNode {
        id: id.clone(),
        kind,
        title: p.title.clone(),
        detail: p.detail.clone(),
        stance: if kind == Kind::Assumption {
            Stance::Hypothetical
        } else {
            Stance::Adopted
        },
        test: p.test.as_ref().map(|t| TestRef {
            name: test_name(&t.name),
            ..t.clone()
        }),
        watch: p.watch.clone(),
        depends_on: p.depends_on.clone(),
        protected: kind == Kind::Invariant,
        evidence: p.evidence.clone(),
        // Taking on a risk is the verifier's call, never a proposal's.
        accepts: vec![],
    };
    Ok((with_node(map, node)?, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map() -> RootsMap {
        parse_map(&json!({
            "version": 1,
            "nodes": [{ "id": "inv.sum", "kind": "invariant", "title": "sum",
                        "test": { "file": "test/C.t.sol", "name": "invariant_sum" } }]
        }))
        .expect("valid")
    }

    fn draft(kind: &str, title: &str, deps: &[&str]) -> Draft {
        Draft {
            kind: kind.into(),
            title: title.into(),
            detail: None,
            depends_on: deps.iter().map(|d| (*d).to_string()).collect(),
            watch: vec![],
            test: None,
            evidence: vec!["src/C.sol:12".into()],
            node_id: None,
            by: Some("claude".into()),
        }
    }

    #[test]
    fn checks_a_draft_against_the_map() {
        let book = Book::default();
        let p = propose(
            &map(),
            &book,
            draft("assumption", "Only add() moves total", &["inv.sum"]),
            "t".into(),
        )
        .expect("valid");
        assert_eq!(p.id, "p1");
        let errs = propose(
            &map(),
            &book,
            draft("invariant", " ", &["nope"]),
            "t".into(),
        )
        .expect_err("invalid");
        assert_eq!(errs.len(), 3);
        assert!(errs[0].starts_with("title is required"));
    }

    #[test]
    fn accepts_into_the_map_as_hypothetical_with_a_unique_id() {
        let p = propose(
            &map(),
            &Book::default(),
            draft("assumption", "Only add() moves total!", &["inv.sum"]),
            "t".into(),
        )
        .expect("valid");
        let (m, id) = accept(&map(), &p).expect("accepted");
        assert_eq!(id, "asm.only-add-moves-total");
        let n = m.nodes.last().expect("node");
        assert_eq!(n.stance, Stance::Hypothetical);
        assert_eq!(n.depends_on, vec!["inv.sum"]);
        let (m2, id2) = accept(&m, &p).expect("accepted again");
        assert_eq!(id2, "asm.only-add-moves-total-2");
        assert_eq!(m2.nodes.len(), 3);
    }

    #[test]
    fn cuts_an_id_only_between_words() {
        assert_eq!(
            slug("The vault's assets equal everything deposited minus everything withdrawn"),
            "the-vaults-assets-equal"
        );
        assert_eq!(
            slug("Supercalifragilisticexpialidocious-and-more things"),
            "supercalifragilisticexpialidocious"
        );
        assert_eq!(slug("..."), "node");
    }

    #[test]
    fn refuses_a_title_that_would_forge_another_line() {
        let e = propose(
            &map(),
            &Book::default(),
            draft("assumption", "fine\np9  assumption  forged", &[]),
            "t".into(),
        )
        .expect_err("refused");
        assert!(e.iter().any(|x| x.contains("one line")), "{e:?}");
    }

    #[test]
    fn never_reuses_an_id_after_a_line_is_lost() {
        // p2 was damaged and is no longer read; p3 and a decision on p4 are.
        let text = [
            r#"{"id":"p1","at":"t","kind":"assumption","title":"a"}"#,
            r#"{"id":"p2","at":"t","kind":"assumpt"#,
            r#"{"id":"p3","at":"t","kind":"assumption","title":"c"}"#,
            r#"{"decide":"p4","decision":"reject","at":"t"}"#,
        ]
        .join("\n");
        assert_eq!(Book::read(&text).next_id(), "p5");
    }

    #[test]
    fn tracks_what_is_still_pending() {
        let text = [
            json!({ "id": "p1", "at": "t", "kind": "assumption", "title": "a" }),
            json!({ "id": "p2", "at": "t", "kind": "intention", "title": "b" }),
            json!({ "decide": "p1", "decision": "reject", "at": "t" }),
        ]
        .iter()
        .map(|v| format!("{v}\n"))
        .collect::<String>();
        let book = Book::read(&text);
        assert_eq!(
            book.pending()
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["p2"]
        );
        assert_eq!(book.next_id(), "p3");
    }
}
