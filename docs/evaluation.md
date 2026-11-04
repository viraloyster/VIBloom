# Evaluation: does a lesson improve Muse's predictions?

Four small, reproducible measurements of the anticipation loop, run on
November 4, 2026. They are hackathon-sized, not benchmarks: one model
(`muse-spark-1.3`, effort low), one experiment question, one or two lessons,
each point predicted twice. Repetitions of the same point are not independent
cases.

**Result in one line.** Lessons change Muse's predictions clearly: on the
fourth grid, frozen before the run, Muse was right on 67% of new predictions
with no lesson, 76% with one lesson and 85% with two. Without lessons Muse
ties always answering "holds" (67%); with two it reaches 85%, below the best
numerical fit evaluated. The two alternative fits on the same four lesson runs
reach 89% (on eps_prime and q) and 67% (on eps_prime and eps). This evaluation
does not establish how Muse attributes the change between q and eps.

## Dataset

All four evaluations are published as one dataset in
[docs/eval/dataset/](eval/dataset/), described by
[schema.json](eval/dataset/schema.json):

| File                | One entry per                                                            | Entries |
| ------------------- | ------------------------------------------------------------------------ | ------: |
| `protocols.json`    | evaluation (grid, frozen commit, lessons, conditions)                    |       4 |
| `points.jsonl`      | point of an evaluation, with the engine's outcome and gap                |     106 |
| `predictions.jsonl` | prediction (condition, repetition, outcome, confidence, citations, cost) |     604 |

Points and predictions are separate so a point counts once however many times
it was predicted; repetitions share a point id and are not independent cases.
`npm run dataset` rebuilds it from the raw results and fails if any count or
score differs from the tables in this report; a test checks the committed
files the same way.

## Fourth evaluation: two lessons, against rules that fit their numbers

The second lesson was learned in a live continuation of the first lesson's
session ([second-lesson.ts](../packages/ideas/eval/second-lesson.ts), log in
[lesson-session-2.json](../packages/ideas/eval/lesson-session-2.json), $0.04):
at q 3e-4, eps 0.03, s 1, eps_prime 1e-4 Muse predicted "fails" (70%, blind)
with the first lesson; the gap was 4.8% and the reduction held. Its test,
eps_prime 2e-4, failed at 9.3%, consistent with the explanation that expected
"fails". The two lessons therefore carry four measured runs: two at q 7.62e-5,
eps 0.01 and two at q 3e-4, eps 0.03. They moved q and eps together.

The grid ([grid-4.json](../packages/ideas/eval/grid-4.json), committed before
the run in `486eb21`): q in {1.5e-4, 3e-4, 6e-4} times eps in {0.005, 0.02}
times s in {0.8, 1.3} times eps_prime in {2e-5, 5e-5, 1.5e-4}, 36 points, all
conclusive and none shared with a lesson run; 24 hold.

| Condition (36 points x 2)                       | Right | Accuracy | Brier | Mean confidence |
| ----------------------------------------------- | ----: | -------: | ----: | --------------: |
| No lesson                                       | 48/72 |      67% | 0.252 |             87% |
| First lesson, measured contrast                 | 55/72 |      76% | 0.185 |             65% |
| Both lessons, measured contrast                 | 61/72 |      85% | 0.138 |             70% |
| Rule: fit on eps_prime, first lesson's two runs | 24/36 |      67% |     - |               - |
| Rule: fit on eps_prime and q, all four runs     | 32/36 |      89% |     - |               - |
| Rule: fit on eps_prime and eps, all four runs   | 24/36 |      67% |     - |               - |
| Always "holds"                                  | 24/36 |      67% |     - |               - |
| Always "fails"                                  | 12/36 |      33% |     - |               - |

### Reading it honestly

- **The second lesson helps Muse**: from 76% to 85%, Brier from 0.185 to
  0.138. Muse cited a lesson on 70 of 72 predictions with both.
- **Without lessons Muse ties the majority answer.** Always "holds" scores
  67% on this grid, as Muse with no lesson does.
- **The best numerical fit does better (89%).** The two lessons changed q and
  eps together, so a fit has to choose a variable: fitting on q gives 89%, on
  eps 67%. That one fit predicts better on this grid does not identify which
  parameter causes the difference. Muse reaches 85%; this evaluation does not
  establish how it attributes the change between q and eps.
- **Where Muse still misses** is near the tolerance: at q 1.5e-4, eps 0.005,
  eps_prime 5e-5 the gap is 5.5% to 5.8% and it said "holds"; at q 6e-4, eps
  0.02, eps_prime 1.5e-4 the gap is 4.5% to 4.7% and it said "fails".
- **What this does not show**: that Muse would choose tests that separate q
  from eps, or that it generalises beyond this question. A lesson whose test
  changes q alone is the next measurement.

Cost: $0.98 for 216 predictions. Raw results:
[two-lesson grid](eval/predictions-2026-11-04-two-lessons.json).

## Third evaluation: every parameter varies, against a model-free rule

The grid ([grid-3.json](../packages/ideas/eval/grid-3.json)) was committed
before the run (commit `4480544`): q in {7.62e-5, 3e-4} times eps in {0.003,
0.01, 0.03} times s in {0.6, 1, 2.5} times eps_prime in {1.5e-5, 4e-5, 1e-4},
54 points. The 18 points at s 2.5 were `not_applicable` (the engine does not
conclude there) and are excluded; 36 new points remain, 20 of them "holds".
The lesson is the same as in the second evaluation (learned at q 7.62e-5,
eps 0.01, s 1, only eps_prime changed).

| Condition, new points (36 points x 2)                  | Right | Accuracy | Brier | Mean confidence |
| ------------------------------------------------------ | ----: | -------: | ----: | --------------: |
| No lesson                                              | 40/72 |      56% | 0.332 |             86% |
| Lesson, outcomes only ("binary")                       | 54/72 |      75% | 0.192 |             67% |
| Lesson with its measured contrast ("quantitative")     | 60/72 |      83% | 0.158 |             67% |
| Model-free rule: log-log interpolation of the two gaps | 28/36 |      78% |     - |               - |
| Always "holds"                                         | 20/36 |      56% | 0.444 |               - |
| Always "fails"                                         | 16/36 |      44% | 0.556 |               - |
| Constant P(holds) = 0.286, from the first grid         |     - |      44% | 0.320 |               - |

Off the lesson's line (33 points that differ from the lesson in more than
eps_prime): quantitative 82%, the interpolation rule 76%, binary 76%, no
lesson 58%. On the line (3 points): quantitative and the rule 100%.

### Reading it honestly

- **Without a lesson Muse is near a coin** on this grid (56%) and
  overconfident (86%).
- **The lesson does the heavy lifting.** Most of the gain over no lesson is
  available to a rule that only interpolates the lesson's two numbers. Muse
  with the measured contrast beats that rule by about 2 points out of 33 off
  the lesson's line; with two repetitions per point that is not a reliable
  difference.
- **Where both go wrong is the same place.** At q 3e-4 the gap is smaller
  than at the lesson's q, so several points hold (gaps 2.1% to 4.8%) where
  the lesson suggests they fail. Both the rule and Muse carry the lesson too
  far there. The lesson never varied q, and nothing in it says how q moves the
  gap.
- **What this says about Muse's role.** Muse's measured value here is in
  producing the lesson (the explanations and the discriminating test) and in
  using it at all; as a predictor given the lesson it is only slightly better
  than interpolation. A lesson that varied q, or a second lesson, is what this
  grid asks for next.

Cost: $1.02 for 228 predictions; 6 to 11 seconds each. Raw results:
[third grid](eval/predictions-2026-11-04-grid3.json).

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

The second evaluation varied only s and eps_prime; it is kept as run.

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
[second grid](eval/predictions-2026-11-04-grid2.json),
[third grid](eval/predictions-2026-11-04-grid3.json),
[two-lesson grid](eval/predictions-2026-11-04-two-lessons.json).

## What would make this stronger

- More lessons, learned from different surprises, and more questions than
  `reduction_keeps_period`.
- Grids drawn at random within ranges fixed in advance, with more points near
  each tolerance.
- The next step for the loop itself: measure whether the quantitative lesson
  also helps Muse choose a better discriminating test, not only predict.
