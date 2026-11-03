# VIBloom

> Every conclusion rests on assumptions. The most common assumption is that
> the assumptions are fine, and it is the one almost nobody tests.

VIBloom is an engine for thinking with evidence. You state what you believe,
what it rests on and what must never be violated; VIBloom keeps every
conclusion tied to those roots, tests them, and shows what breaks when one of
them changes.

The interface is a guanacaste tree. The canopy is what has been built. The
roots are the map: assumptions, invariants, sources, experiments and lessons.

## Mission

Make the assumptions behind any conclusion visible, testable and accountable,
so that people and AI models can build on each other's work knowing exactly
what it rests on.

## Vision

A place where any idea, from an engineering project to a mathematical
conjecture or a philosophical argument, can be decomposed into its premises
down to first principles, with each premise marked by how it is known:
computed and reproducible, cited from a source, or only argued. Lessons from
every failure stay attached to the premises they depend on, so knowledge
accumulates instead of being rediscovered. Over time this becomes a record of
predictions, outcomes and corrections that can also help evaluate and improve
the AI models doing the research.

Meta's models do the open intellectual work: understanding an idea in text,
handwriting, figures or documents, structuring it, predicting, designing
experiments, diagnosing surprises and explaining. Code does what can be
checked: running experiments, deriving every status from evidence and keeping
the record.

## What exists today

**Any idea, as a static web app.** The landing page asks "What do you want to
build?". Muse Spark decomposes the goal into the assumptions it rests on,
following a fixed protocol (the same axes, every number with its unit and
origin, reference or assumed), and the roots grow on screen as Muse writes
them. Opening a root asks Muse for the assumptions under it, one level closer
to first principles.

Where an assumption can be tested by arithmetic, Muse writes two expressions
and how they must compare (for example `delta_p * radius / thickness <=
strength`). VIBloom parses them with its own small arithmetic language,
evaluates them and decides pass or fail; no code written by the model is ever
executed. A root turns red only when that comparison is false. The formula and
its numbers still come from the model, and the interface says so: a correct
evaluation does not prove they model the problem well.

Each parameter exists once in the whole tree. A deeper root that needs it uses
the same value, and if Muse thinks the value is wrong it appears as a
suggestion a person can adopt, never as a silent copy. Editing a value
re-runs every check that read it, and everything resting on a broken root is
marked. If a formula fails to evaluate, Muse repairs it once, in a single
request. Everything is recorded in a hash-chained log that can be exported
and replayed.

**Chemistry, in depth.** The first specialised domain, chosen for its
mathematical depth and because it can be seen: oscillating reactions
(Belousov-Zhabotinsky, Oregonator models) with a stiff solver checked against
an independent SciPy reference.

1. A claim in natural language becomes a predicate the engine can execute.
2. A deterministic engine runs the experiments and records the evidence in a
   hash-chained log.
3. Claim status is derived from evidence; models propose, code decides.
4. The code enforces invariants; assumptions are tested and can be switched
   off.
5. Changing an assumption propagates through the dependency graph.
6. Every run can be re-computed in the browser and shown as twin beakers and
   spiral waves, drawn only from the recorded parameters.

The chemistry investigation loop (formulate, predict before each experiment,
diagnose surprises, write lessons, conclude) is implemented against Muse Spark
and tested with scripted and recorded runs. It still runs behind the API in
`apps/api` (`bench.html`); joining it to the static app is the next step.

## Try it

- Without a key: open the app and choose "Watch a recorded example". It
  replays a real Muse session; the calculations are re-run in your browser.
- With your own Meta Model API key: grow any idea. The key stays in the tab
  (or on the device, if you ask) and is sent only to api.meta.ai. Before each
  request the API counts its input tokens, and the session reserves that
  input plus the maximum output at full price, so it stops at the budget you
  set. This is a limit for the tab, not for your account: set a spend limit
  in your Meta billing settings too. Standard mode keeps your content out of Meta's training;
  contributor mode is about 20 times cheaper and lets Meta train on it.
- Locally: `npm ci && npm run dev`, then open the printed address.

A recorded session cost about $0.03 for a decomposition and one expansion.

## Not built yet

These are directions, not features:

- Views of each experiment designed by Muse and run isolated from the app.
- Specialists that review a discrepancy from different angles, and a final
  review of broad conclusions.
- Branches of a tree to experiment without touching the main one.
- The chemistry loop and the idea tree in one static app.

Status: under active development during the Meta Global AI Developer Hackathon
(October 27 - November 4, 2026). See [HACKATHON.md](HACKATHON.md).

## Repository

```
apps/web          static app: idea tree (index.html), chemistry bench (bench.html)
apps/api          Cloudflare Worker and Durable Objects
packages/         contracts, engine, chem, search, agent, ideas
evals/            evaluation cases, runners and results
tools/reference   SciPy reference data generator
docs/             architecture, science, validation
```

## Documentation

- [Architecture](docs/architecture.md)
- [Scientific scope](docs/science.md)
- [Validation](docs/validation.md)

## Credits

The canopy artwork (`apps/web/public/crown.webp`) was generated by the author
with an image model and cut out for the interface. The roots are drawn from
project data.

## License

[MIT](LICENSE)
