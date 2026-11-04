# Scientific scope

## Question

When does the two-variable reduction of the Oregonator preserve the
oscillations of the three-variable model, and when does it not?

## Models

Three-variable Oregonator (Oregonator-3), as written in [1], with fast time t:

```
x' = y (q - x) + x (1 - x)
e y' = s z - y (q + x)
z' = d (x - z)
```

Two-variable reduction (Oregonator-2), obtained by setting `e y' = 0`, so that
`y = s z / (q + x)`:

```
x' = x (1 - x) + s z (q - x) / (q + x)
z' = d (x - z)
```

`x`, `y`, `z` are scaled concentrations of HBrO2, Br- and the oxidized
catalyst. `s` is the stoichiometric factor (also written `f`).

## Time scaling used in this repository

The engine uses slow time `tau = d t`. With `eps = d` and `eps_prime = e d`:

```
eps dx/dtau = q y - x y + x (1 - x)
eps_prime dy/dtau = -q y - x y + s z
dz/dtau = x - z
```

This is the scaling of Field's Scholarpedia review [2], which [1] relates to
its own normalization as `(eps, eps_prime) = (d, d e)`.

## Parameters

| Parameter | Value                      | Source                                           |
| --------- | -------------------------- | ------------------------------------------------ |
| `q`       | 7.62e-5                    | [1], adapted from [2]                            |
| `e`       | 2e-3                       | [1]                                              |
| `d`       | 1e-3 in [1]; 9.9e-3 in [2] | [1] uses 1e-3 to improve its asymptotic analysis |
| `s`       | swept, 0.4 to 2.8          | free parameter                                   |

With the values of [2], `eps = 9.9e-3` and `eps_prime = 1.98e-5`.

## From a real recipe

A tree that names a recipe (`bromate`, `malonic_acid`, `acid`, in M) gets `q`,
`eps`, `eps_prime` and `time_scale_s` from it
(`packages/chem/src/recipe.ts`), with the FKN Oregonator steps of [2]:

```
eps       = k5 [MA] / (k3 [BrO3-])
eps_prime = 2 k4 k5 [MA] / (k2 k3 [BrO3-])
q         = 2 k1 k4 / (k2 k3)
tau       = k5 [MA] t,  so  time_scale_s = 1 / (k5 [MA])
```

The rate constants are Field's [2], each a coefficient times the proton
concentration: k1 = 2 [H+]^2, k2 = 3e6 [H+], k3 = 42 [H+], k4 = 3000 [H+],
k5 = 1 (M, s). For 0.06 M bromate, 0.02 M malonic acid and 0.8 M acid they
give the scaled values of [2] (the `FIELD_2007` set) to within 0.2%. Doubling
the acid doubles `q` and halves `eps` and `eps_prime`; tests check both the
reference recipe and that dependence. `s` (the stoichiometric factor f) is not
set by the recipe and stays an assumption of the tree. Every run records the
version of this conversion (`RECIPE_VERSION`); a run made under another
version is shown as stale.

A period in seconds is the model period times `time_scale_s`. The Oregonator
is semi-quantitative: these seconds are the model's, and a real beaker can
differ. For the cited recipe the full model gives about 6.5 minutes; with 0.2
M malonic acid, about 67 seconds, where the two-variable reduction is already
42% off. With 0.3 M bromate at that malonic acid concentration the gap falls
to 6.4% (the recorded session's discriminating test).

At fixed acid, eps and eps_prime are both proportional to the ratio of
malonic acid to bromate and q depends on the acid alone, so the gap between
the two models is the same for every recipe with the same ratio; the recipe
map shows it as equal gaps along its diagonals. The period in seconds is the
dimensionless period, set by that ratio, times `time_scale_s = 1/(k5 MA)`, so
at a fixed ratio it falls as one over the malonic acid. Reaching a shorter
period while keeping the reduction therefore means raising malonic acid and
bromate together.

## Initial conditions

Initial conditions are assumptions of every claim. The reduced model has no `y`
state; when both models are compared, the full model starts on the slow
manifold, `y0 = s z0 / (q + x0)`. The named conditions are `far`
(`x0 = z0 = 0.5`), `mid` (`x0 = 0.05, z0 = 0.2`) and `near` (1% above the fixed
point).

## Observables

- Oscillation: after discarding the first half of the horizon, `log10 x` swings
  more than one decade, with at least four peaks and a period coefficient of
  variation below 5%.
- Period: mean interval between peaks in the analysed window, in units of `tau`.
- Period error: `(T_full - T_reduced) / T_reduced`, defined only when both
  models oscillate.

## Reference case

[1] reports, for `s = 1`, `q = 7.62e-5`, `e = 2e-3`, `d = 1e-3`, periods of 7110
(Oregonator-2) and 7160 (Oregonator-3) in its fast time, and the onset of the
Oregonator-3 limit cycle at `s` slightly above 0.50047.

Reproduction. The periods are checked by `npm test`
(`packages/chem/src/classify.test.ts`); the onset was measured during the design
phase and is not automated yet.

| Quantity                     | [1]           | This work                  | Difference        |
| ---------------------------- | ------------- | -------------------------- | ----------------- |
| Oregonator-2 period, `s = 1` | 7110          | 7087                       | -0.3%             |
| Oregonator-3 period, `s = 1` | 7160          | 7150                       | -0.1%             |
| Oregonator-3 onset           | above 0.50047 | between 0.50055 and 0.5006 | about 1e-4 in `s` |

The onset lies in a canard explosion, which is exponentially sensitive. Linear
stability places the Hopf point of the full model at `s = 0.50073`, so the
onset found by simulation is subcritical. The remaining difference is open.

## Limitations

- Agreement between models is agreement between models, not with experiments.
- A finite simulation does not prove that a limit cycle exists.
- Eigenvalues of the Jacobian give local stability only. At `s = 2.2` and
  `eps_prime = 1e-4` the full model settles to the steady state from `near` and
  oscillates from `far` under the classification protocol. This is observed
  behaviour, not a proof that both attractors exist.

## References

1. A. J. Brizard and S. M. Berry, "Asymptotic Limit-cycle Analysis of
   Oscillating Chemical Reactions", arXiv:2105.01234 (2021).
2. R. J. Field, "Oregonator", Scholarpedia 2, 1386 (2007).
3. R. J. Field and R. M. Noyes, J. Chem. Phys. 60, 1877 (1974).
4. J. J. Tyson and P. C. Fife, J. Chem. Phys. 73, 2224 (1980).
