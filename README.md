# VIBloom

> Every conclusion rests on assumptions. The most common assumption is that
> the assumptions are fine, and it is the one almost nobody tests.

**VIBloom turns any idea into a tree of the assumptions it rests on, tests
the ones that can be computed or run as experiments, and makes Muse predict,
fail and learn in a record anyone can replay.** Muse Spark does the thinking;
a deterministic engine checks every result it can, and the record keeps the
two apart.

- **Live app:** https://viraloyster.github.io/VIBloom/ (static, runs in your
  browser with your own Meta Model API key)
- **No key?** Choose one of the three recorded Muse sessions on the first
  screen. They replay real sessions and re-run every calculation and
  experiment in your browser.
- **For reviewers:** [what to look at, and where](#for-reviewers-where-to-look).

## The problem

Ideas fail at an assumption nobody checked: a material that is not strong
enough, a model that is wrong outside the range it was fit on, a number that
was typed in rather than measured. AI makes this sharper: a model produces a
fluent conclusion in seconds, and nothing shows which of its premises were
computed, which were cited and which were only asserted, or whether the model
learns anything when it turns out to be wrong.

VIBloom attacks that: every conclusion is tied to its roots, every root says
how it is known, and the model has to commit to predictions that code then
settles.

## What it does

1. **Decompose.** You say what you want to build. Muse Spark grows the
   assumptions under it, down toward first principles, every number with its
   unit and origin (from a source, or assumed). You can also **write or
   sketch the idea by hand** or upload a photo of paper; Muse reads it.
2. **Mark how each root is known.** Computed and reproducible, cited, argued,
   or bedrock (a law of nature). A green that rests on unchecked premises is
   shown as unverified or partial, never as holding. A check whose "result"
   is a number someone typed in stays argued.
3. **Compute what can be computed.** Muse writes comparisons in a small
   arithmetic language the engine parses and evaluates itself (no model code
   ever runs). You can write a formula by hand; Muse maps your symbols to the
   tree's parameters and the engine decides whether it computes. In
   chemistry, Muse attaches real experiments that a stiff solver runs.
4. **Predict, fail, learn.** Before an experiment runs, Muse commits to an
   outcome and a confidence. If the run contradicts it, Muse registers two
   explanations and one discriminating test before that test runs; the engine
   runs it and code decides which explanation the evidence fits. The lesson
   keeps the measured contrast, Muse's interpretation and what one test
   cannot establish, apart.
5. **Show it.** Muse designs a live illustration of each mechanism in a
   sandboxed frame, then looks at a picture of what the monitor actually
   shows and redraws once if it is wrong. Experiments appear as beakers and
   spiral-wave dishes computed from the run's exact values. The chat sees the
   monitor too, cites the roots it used, and any number it writes that was
   not in its data is flagged.

The examples on the first screen are deliberately absurd and taken seriously
(a commercial airliner made of cardboard, a tree that grows gold): the engine
must show exactly which root breaks and why, not dismiss the idea.

## A real case: a chemical clock for a class demo

A teacher writes a Belousov-Zhabotinsky recipe in a notebook (0.06 M bromate,
0.02 M malonic acid, 0.8 M acid, cerium catalyst) and wants the colour to flip
every 60 s, asking whether the simpler two-variable model can be trusted. In
the recorded session:

1. Muse reads the handwritten recipe and grows the tree: does the recipe
   oscillate, does the period hit 60 s +/- 10, can the reduction be trusted.
2. VIBloom turns the recipe into the model's parameters with cited rate
   constants and runs it: it oscillates, but every 6.5 minutes, so the
   60-second root is red with the real number.
3. With malonic acid raised to 0.2 M the clock ticks every 67 s and that root
   turns green, but the two-variable model is now 42% off: speeding the clock
   up breaks the simplification.
4. Muse had predicted the reduction would hold (78%). It proposes two
   explanations; the engine's test contradicts one and is consistent with the
   other (eliminating bromide removes the delay that times the cycle).

The monitor shows the period in seconds, a beaker changing colour at that
rhythm (real time or a stated speed-up) and both models' concentrations side
by side.

## Why chemistry first

The engine is general; the first specialisation is chemistry because it has
real mathematical depth and can be seen. VIBloom runs the Oregonator model of
the Belousov-Zhabotinsky oscillating reaction: does it oscillate at these
values, and does the simpler two-variable model keep the full model's period?
The solver is checked against an independent SciPy reference (periods agree
to a relative 5e-4; see [validation](docs/validation.md)), and a recorded run
counts only once the viewer's browser reproduces it (relative 1e-4,
measured).

## Where Muse is indispensable

Without Muse there is no tree, no formula, no prediction and no explanation:
the engine only verifies. Every task below is Muse's; the right column is what
code does with it.

| Muse (Meta Model API, `muse-spark-1.3`)                         | What the engine does                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Decomposes the idea into roots, streamed as structured JSON     | Admits only protocol-valid nodes; one value per parameter name          |
| Reads handwriting, sketches and formulas (vision)               | Accepts a handwritten formula only in the tree's own parameter names    |
| Writes each check as a comparison, or chooses an experiment     | Parses and evaluates it, or runs the stiff solver; decides pass or fail |
| Predicts before each run, with a confidence                     | Settles the prediction with the run, permanently; scores it (Brier)     |
| After a surprise, proposes two explanations and one test        | Refuses them without a contradicted prediction; runs the test; decides  |
| Designs an HTML illustration of the mechanism                   | Runs it sandboxed: no network, no storage, no key                       |
| Looks at a picture of its own drawing (vision) and redraws once | Bounds it to one redraw; records what Muse found                        |
| Answers in the chat, seeing the monitor                         | Flags any number not in the data Muse was given                         |

Cost is part of the design: before each request the API counts the input
tokens, the session reserves the most that request could cost and stops at
the budget. A recorded session costs about $0.03 to $0.12.

## Evidence

- **Learning, measured** ([evaluation](docs/evaluation.md)). On a grid frozen
  in a commit before the run, Muse with the recorded lesson's measured
  contrast got 26 of 28 predictions right (Brier 0.090); with the lesson as
  outcomes only, 22 (Brier 0.173, no better than always answering "fails");
  with no lesson, 6 (Brier 0.555). The advantage of the numbers comes from
  three points near the tolerance, and the report says so.
- **Solver** checked against SciPy, with explicit failure codes instead of a
  silent "no oscillation" ([validation](docs/validation.md)).
- **Record**: a hash-chained log; replay recomputes every formula, refuses a
  result that does not reproduce, and re-runs experiments in the browser.
  Unknown event types are refused.
- **Tests**: 211, including regressions for every issue found in review
  (circular checks, inverted repairs, lessons without history, lost
  prediction history, confirmations that changed the record).

## For reviewers: where to look

| What                                                                 | Where                                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The rules that keep Muse honest (gates, statuses, lessons, scoring)  | [`packages/ideas/src/tree.ts`](packages/ideas/src/tree.ts)                                                             |
| Muse's prompts and JSON schemas                                      | [`packages/ideas/src/protocol.ts`](packages/ideas/src/protocol.ts)                                                     |
| Calls to the Meta Model API (streaming, vision, token count, budget) | [`packages/ideas/src/muse.ts`](packages/ideas/src/muse.ts), [`packages/ideas/src/cost.ts`](packages/ideas/src/cost.ts) |
| The arithmetic language (no `eval`)                                  | [`packages/ideas/src/expr.ts`](packages/ideas/src/expr.ts)                                                             |
| The number guard                                                     | [`packages/ideas/src/numbers.ts`](packages/ideas/src/numbers.ts)                                                       |
| The stiff solver and the Oregonator                                  | [`packages/chem/`](packages/chem/)                                                                                     |
| Tests                                                                | [`packages/ideas/src/ideas.test.ts`](packages/ideas/src/ideas.test.ts), and next to the code in each package           |
| The evaluation script and its frozen grid                            | [`packages/ideas/eval/`](packages/ideas/eval/)                                                                         |
| The app                                                              | [`apps/web/src/ideas/`](apps/web/src/ideas/)                                                                           |

## Vision

Everything has assumptions, so the engine is meant for any field: an
engineering project, a mathematical conjecture, a business plan, an argument.
Chemistry comes first; other domains follow as their experiments are added.

The long-term goal is a deep research tool built around Muse: Muse proposes,
the engine experiments, Muse is wrong in the open, and the lessons it earns
are kept with the evidence and premises they depend on. The record of
predictions, outcomes and corrections then becomes data in its own right, to
measure whether Muse is learning and to improve the models doing the
research. The tree is refined by that loop, not written once.

## Try it

- **Without a key:** open the [app](https://viraloyster.github.io/VIBloom/)
  and choose a recorded session: the handwritten BZ recipe (the real case
  above), Muse surprised by an experiment and learning from it, or the
  cardboard airliner (a handwritten formula, Muse checking its own drawing).
- **With your own Meta Model API key:** grow any idea, or write it by hand.
  The key stays in the tab (or on the device, if you ask) and is sent only to
  api.meta.ai. The session budget is a limit for the tab, not for your
  account: set a spend limit in your Meta billing settings too. Standard mode
  keeps your content out of Meta's training; contributor mode is about 20
  times cheaper and lets Meta train on it.
- **Locally:** `npm ci && npm run dev`, then open the printed address.
  `npm test` runs the tests.

## Not built yet

Directions, not features:

- Branches of a tree, to experiment without touching the main one.
- Region claims and counterexample search in the static app (they run behind
  the API in `apps/api`, `bench.html`).
- More chemistry: other oscillators and questions, more lessons, and an
  evaluation of whether lessons also help Muse choose better tests.

Built during the Meta Global AI Developer Hackathon (October 27 - November 4,
2026); the git history is the record. See [HACKATHON.md](HACKATHON.md).

## Repository

```
apps/web          static app: idea tree (index.html), chemistry bench (bench.html)
apps/api          Cloudflare Worker and Durable Objects (region claims, search)
packages/ideas    the idea tree: protocol, engine rules, Muse client, evaluation
packages/chem     stiff solver, Oregonator models, classifier
packages/         also contracts, engine (hashing, log), search, agent
tools/reference   SciPy reference data generator
docs/             architecture, science, validation, evaluation
```

## Documentation

- [Evaluation](docs/evaluation.md): does a lesson improve Muse's predictions?
- [Validation](docs/validation.md): the solver against SciPy, reproduction in the browser
- [Scientific scope](docs/science.md)
- [Architecture](docs/architecture.md)

## Credits

The canopy artwork (`apps/web/public/crown.webp`) was generated by the author
with an image model and cut out for the interface. The roots are drawn from
project data.

## License

[MIT](LICENSE)
