# Contributing

VIBloom keeps assumptions, invariants and intentions honest; changes are
judged by whether they keep its results honest and reproducible.

- Read [AGENTS.md](AGENTS.md) for the layout, the commands and the rules (they
  apply to people too), and [docs/architecture.md](docs/architecture.md)
  before changing the tree.
- `npm run check` and `npm test` must pass, and so must `cargo fmt --all
--check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`.
- A fix comes with a test that would have caught it, next to the code.
- Model output never becomes a result without a deterministic check.
- English and ASCII only in the repository; one short imperative line per
  commit message.
- Never commit a key, a token or a file that contains one.
