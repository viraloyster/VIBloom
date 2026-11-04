# Evaluation: does a lesson improve Muse's predictions?

A small, reproducible measurement of the anticipation loop, run on November 4, 2026. It is a first measurement, not a benchmark: one model, one lesson, one
experiment question, 15 points.

## Setup

- **Question.** Does the two-variable Oregonator reduction keep the full
  model's period within 5%? (`reduction_keeps_period`, q 7.62e-5, eps 0.01.)
- **Ground truth first.** The chemistry engine settles every point before Muse
  is asked anything: s in {0.75, 1, 1.5, 2} times eps_prime in {1e-5, 5e-5,
  2e-4, 1e-3}, plus the two points of the lesson. One point (s 2, eps_prime
  1e-3) was inconclusive and is excluded.
- **Lesson.** The one in the recorded session
  (`apps/web/public/examples/period-reduction.json`): at s 1, eps_prime 2e-4
  the reduction failed (55%); at eps_prime 2e-5 it held (3.9%), consistent
  with the time-scale explanation.
- **Conditions.** Each point is predicted blind by `muse-spark-1.3` (effort
  low), with the same prompt and input the app uses, once without lessons and
  once with the lesson as the app would show it at those values. Two
  repetitions. Points the lesson was learned at ("seen") are reported apart
  from the other 14 ("new"), so recalling a seen result is not counted as
  learning.
- **Metrics.** Accuracy; Brier score on the stated confidence (0 is best, 0.25
  is a constant 50%); share citing the lesson; cost and latency per
  prediction. The schema has no abstention option; no request failed.

Reproduce with `npx vite-node packages/ideas/eval/predictions.ts -- 2 out.json`
(key in `MUSE_API_KEY`). Raw results: [eval/predictions-2026-11-04.json](eval/predictions-2026-11-04.json).

## Results

| Condition                 | Predictions | Accuracy | Brier | Mean confidence | Cited the lesson |
| ------------------------- | ----------: | -------: | ----: | --------------: | ---------------: |
| Without lesson, seen      |           4 |      50% |  0.37 |             87% |                0 |
| With lesson, seen         |           4 |     100% |  0.06 |             81% |                2 |
| Without lesson, new       |          28 |      29% |  0.51 |             85% |                0 |
| With lesson, new          |          28 |      54% |  0.21 |             67% |                0 |
| Always "fails" (baseline) |          28 |      71% |     - |               - |                - |

On the new points the true outcome was "holds" 29% of the time (only at
eps_prime 1e-5 and 2e-5).

Cost: $0.26 for all 64 predictions (about $0.004 each); 6 to 9 seconds each.

## What this shows, and what it does not

- **Without a lesson, Muse predicted "holds" every time**, with 75% to 92%
  confidence. Its accuracy is the base rate, and its Brier score (0.51) is
  worse than saying 50% everywhere.
- **With the lesson, accuracy on new points rose from 29% to 54% and the
  Brier score from 0.51 to 0.21.** Most of the Brier gain comes from lower
  confidence; the rest from switching to "fails" at large eps_prime (1e-3),
  where the gap is 380% to 440%.
- **It is still below the trivial baseline.** Always answering "fails" gets
  71%. Muse with the lesson kept predicting "holds" at eps_prime 5e-5, where
  the gap is 8.5% to 9.2%: the lesson says smaller eps_prime helps, not how
  small is small enough. That is what its "still open" line says a single
  test cannot establish.
- **On seen points it recalled the result** (100%, citing the lesson twice).
  That is memory, not learning, and is reported apart for that reason.
- **The lesson was never cited on new points**, though it changed the
  predictions: the app marks it invalidated at other values, and Muse did not
  claim to use it. Citing is self-reported and is not proof of use either way.
- **Limits.** 14 new points, two repetitions, one model, one lesson. Results
  at the same point differ between repetitions. A real calibration curve
  needs far more predictions than a demo makes.

The next step this points to: a lesson that records the measured gap at both
runs (55% and 3.9%), not just the two outcomes, so a later prediction can
interpolate where the tolerance is crossed, measured with this same script.
