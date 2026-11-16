//! "Did you mean": the nearest names to one that does not exist, so a typo
//! costs one more try and not a search through the map.

/// Up to three names close to `word`: sharing its start, containing it, or a
/// few edits away. Closest first.
pub fn nearest<'a>(word: &str, names: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let w = word.to_lowercase();
    let mut scored: Vec<(usize, &str)> = names
        .into_iter()
        .filter_map(|n| {
            let low = n.to_lowercase();
            let d = distance(&w, &low);
            let near = d <= (w.chars().count() / 3).max(2);
            let part = w.len() >= 3 && (low.starts_with(&w) || low.contains(&w));
            (near || part).then_some((if near { d } else { d.min(99) + 100 }, n))
        })
        .collect();
    scored.sort();
    scored.dedup_by(|a, b| a.1 == b.1);
    scored.into_iter().take(3).map(|(_, n)| n).collect()
}

/// "No node X in the map." with the nearest ids, or with where to look.
pub fn unknown<'a>(what: &str, word: &str, names: impl IntoIterator<Item = &'a str>) -> String {
    let near = nearest(word, names);
    if near.is_empty() {
        format!("No {what} {word}.")
    } else {
        format!("No {what} {word}. Did you mean {}?", near.join(", "))
    }
}

// Levenshtein, by characters.
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let sub = prev[j] + usize::from(ca != *cb);
            cur.push(sub.min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_by_edits_and_by_prefix() {
        let ids = [
            "inv.assets-match-flows",
            "inv.shares-are-backed",
            "asm.rounding",
        ];
        assert_eq!(
            nearest("inv.asset-match-flows", ids),
            vec!["inv.assets-match-flows"]
        );
        assert_eq!(nearest("inv.shares", ids), vec!["inv.shares-are-backed"]);
        assert_eq!(nearest("asm.rouding", ids), vec!["asm.rounding"]);
        assert!(nearest("zzz", ids).is_empty());
        assert_eq!(
            unknown("node", "inv.shares", ids),
            "No node inv.shares. Did you mean inv.shares-are-backed?"
        );
        assert_eq!(unknown("node", "zzz", ids), "No node zzz.");
    }

    #[test]
    fn counts_edits() {
        assert_eq!(distance("kitten", "sitting"), 3);
        assert_eq!(distance("", "abc"), 3);
        assert_eq!(distance("same", "same"), 0);
    }
}
