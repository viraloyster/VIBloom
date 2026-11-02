# VIBloom

VIBloom turns hypotheses about chemical models into executable claims, tests them
with reproducible computational experiments, and keeps every conclusion linked to
the assumptions it depends on and the invariants it must respect.

The interface is a guanacaste tree. The canopy shows what has been built. The
roots are the map: a network of assumptions, invariants, sources and experiments.
When a root changes or breaks, the conclusions that depend on it are marked for
review.

Status: under active development during the Meta Global AI Developer Hackathon
(October 27 - November 4, 2026). See [HACKATHON.md](HACKATHON.md).

## How it works

1. A claim in natural language becomes a predicate the engine can execute.
2. A deterministic engine runs the experiments and records the evidence.
3. Claim status is derived from evidence; models propose, code decides.
4. The code enforces invariants; assumptions are tested and can be switched off.
5. Changing an assumption propagates through the dependency graph.

Meta models: Muse Spark (Meta Model API) investigates and explains; Muse Spark
Open (open weights) scores uncertainty and pre-checks handwritten input.

## Repository

```
apps/web          interface: roots map, monitor, chat
apps/api          Cloudflare Worker and Durable Objects
packages/         contracts, engine, chem, search, agent
evals/            evaluation cases, runners and results
tools/reference   SciPy reference data generator
docs/             architecture, science, validation
```

## Documentation

- [Architecture](docs/architecture.md)
- [Scientific scope](docs/science.md)
- [Validation](docs/validation.md)

## License

[MIT](LICENSE)
