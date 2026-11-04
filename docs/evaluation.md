# Evaluation: does a lesson improve Muse's predictions?

Two small, reproducible measurements of the anticipation loop, run on November
4, 2026. They are hackathon-sized, not benchmarks: one model
(`muse-spark-1.3`, effort low), one lesson, one experiment question, 14 new
points per grid, each predicted twice. Repetitions of the same point are not
independent cases.

**Result in one line.** Given the lesson as a measured contrast, Muse got 26
of 28 predictions right on a grid it had never seen (Brier 0.090), against 22
of 28 for the same lesson without its numbers (Brier 0.173), 22 of 28 for
always answering "fails" and a Brier of 0.173 for a constant probability
estimated on an earlier grid. The whole difference between the two kinds of
lesson comes from three points, the ones closest to the tolerance.

## What is measured

- **Question.** Does the two-variable Oregonator reduction keep the full
  model's period within 5%? (`reduction_keeps_period`, q 7.62e-5, eps 0.01.)
- **Ground truth first.** The chemistry engine settles every point before Muse
  is asked anything. Points the engine cannot conclude on are excluded.
- **The lesson.** The one in the session frozen with the evaluation
  (`packages/ideas/eval/lesson-session.json`; the app's example has since
  been re-recorded with every prediction made before its run): at s 1, eps_prime 2e-4
  the reduction was 55% off; at eps_prime 2e-5 it was 3.9% off, consistent
  with the time-scale explanation.
- **Blind predictions.** The same prompt and input the app uses. The lesson's
  own two points ("seen") are reported apart from the others ("new"):
  recalling a result is memory, not learning.
- **Metrics.** Accuracy; Brier score on the stated confidence (0 is best; a
  constant 50% scores 0.25); how often the lesson was cited; cost; latency.
  The schema has no abstention option; no request failed.

Reproduce with
`npx vite-node packages/ideas/eval/predictions.ts -- packages/ideas/eval/grid-2.json 2 out.json`
(key in `MUSE_API_KEY`).

## Second evaluation: three conditions on a frozen grid

The grid ([grid-2.json](../packages/ideas/eval/grid-2.json)) was committed
before the run (commit `679008b`) and shares no point with the first one: s in
{0.8, 1.2, 1.8} times eps_prime in {1.5e-5, 3e-5, 1e-4, 4e-4, 2e-3}, 15
points, 14 conclusive (s 1.8, eps_prime 2e-3 was `not_applicable`). The truth
was "holds" at 3 of the 14.

| Condition, new points (14 points x 2)              | Right | Accuracy | Brier | Mean confidence | Cited the lesson |
| -------------------------------------------------- | ----: | -------: | ----: | --------------: | ---------------: |
| No lesson                                          |  6/28 |      21% | 0.555 |             85% |                0 |
| Lesson, outcomes only ("binary")                   | 22/28 |      79% | 0.173 |             72% |               28 |
| Lesson with its measured contrast ("quantitative") | 26/28 |      93% | 0.090 |             75% |               28 |
| Always "fails"                                     | 11/14 |      79% | 0.214 |               - |                - |
| Constant P(holds) = 0.286, from the first grid     |     - |      79% | 0.173 |               - |                - |

On the lesson's own two points every condition with the lesson was right 4 of
4 (no lesson: 2 of 4).

Where the conditions differ, point by point:

| eps_prime | Real gap (s 0.8 / 1.2 / 1.8) | No lesson | Binary  | Quantitative |
| --------- | ---------------------------- | --------- | ------- | ------------ |
| 1.5e-5    | 3.0% / 3.1% / 3.4%: holds    | 6/6 right | 6/6     | 6/6          |
| 3e-5      | 5.4% / 5.6% / 5.9%: fails    | 0/6       | **0/6** | **4/6**      |
| 1e-4      | 18% to 19%: fails            | 0/6       | 6/6     | 6/6          |
| 4e-4      | 143% to 164%: fails          | 0/6       | 6/6     | 6/6          |
| 2e-3      | 729% to 800%: fails          | 0/4       | 4/4     | 4/4          |

Cost: $0.41 for 102 predictions (about $0.004 each); 6 to 11 seconds each.

### Reading it honestly

- **Without a lesson Muse predicted "holds" every time**, at 75% to 92%
  confidence: worse than a coin in Brier terms (0.555).
- **The binary lesson moves Muse exactly to the base rate.** Its accuracy ties
  always "fails" and its Brier ties the constant probability. It learned the
  direction (smaller eps_prime helps) but not where the tolerance is crossed:
  it said "holds" at every point with eps_prime 3e-5.
- **The measured contrast is what beats both baselines**, and only through the
  three points at eps_prime 3e-5, where the real gap is 5.4% to 5.9% against a
  5% tolerance. Knowing "55% at 2e-4, 3.9% at 2e-5" let Muse place the
  crossing; it called them "fails" 4 times out of 6, at a modest 62% to 65%.
  Elsewhere both lessons were right on every prediction.
- **Three points are a narrow base.** The grid was chosen by us, before the
  run, around the physics we expected; a grid with more points near the
  tolerance, other values of q and eps, and other questions would test this
  properly.
- **How the lesson is framed changed its use.** In the first evaluation the
  app showed the lesson as "invalidated" at other values and Muse never cited
  it. Here it is shown as evidence learned at other values whose
  applicability is not checked, and Muse cited it on every prediction. The
  grids differ, so this is an observation, not a measured effect.
- **The baseline probability is predictive, not retrospective.** It was
  estimated on the first grid (4 of 14 held) and applied to this one.

## First evaluation (earlier the same day)

Before the lesson carried its numbers, with the lesson shown as
"invalidated" at other values. The grid was s in {0.75, 1, 1.5, 2} times
eps_prime in {1e-5, 5e-5, 2e-4, 1e-3}: 16 points plus the lesson's 2 minus 1
shared = 17 proposed, 16 conclusive (s 2, eps_prime 1e-3 was
`not_applicable`), 14 of them new.

| Condition, new points (14 points x 2)   | Right | Accuracy | Brier |
| --------------------------------------- | ----: | -------: | ----: |
| No lesson                               |  8/28 |      29% | 0.510 |
| Lesson (binary, "invalidated")          | 15/28 |      54% | 0.211 |
| Always "fails"                          | 10/14 |      71% | 0.286 |
| Constant P(holds) = 0.286, in hindsight |     - |      71% | 0.204 |

The constant probability here is retrospective (it is this grid's own share),
so it is only a reference. That result is what led to giving Muse the measured
contrast and to the clearer applicability.

Raw results: [first grid](eval/predictions-2026-11-04.json),
[second grid](eval/predictions-2026-11-04-grid2.json).

## What would make this stronger

- More lessons, learned from different surprises, and more questions than
  `reduction_keeps_period`.
- Grids drawn at random within ranges fixed in advance, with more points near
  each tolerance.
- The next step for the loop itself: measure whether the quantitative lesson
  also helps Muse choose a better discriminating test, not only predict.
