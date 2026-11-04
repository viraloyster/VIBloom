# Contributing

VIBloom is a research instrument; changes are judged by whether they keep its
results honest and reproducible.

- Read [AGENTS.md](AGENTS.md) for the layout, the commands and the rules (they
  apply to people too), and [docs/architecture.md](docs/architecture.md)
  before changing the engine.
- `npm run check` and `npm test` must pass. `npm run verify` must still
  reproduce every recorded session; `npm run dataset -- check` must still
  match the evaluation report.
- A fix comes with a test that would have caught it, next to the code.
- Model output never becomes a result without a deterministic check.
- English and ASCII only in the repository; one short imperative line per
  commit message.
- Never commit a key, a token or a recording that contains one.
