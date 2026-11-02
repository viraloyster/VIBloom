"""Reference solutions from SciPy for the chem package tests.

Usage: python tools/reference/generate.py
Writes packages/chem/fixtures/reference.json with a manifest of versions and
settings. The equations here are written independently of the TypeScript code.
"""

import json
import platform
import sys
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp
from scipy.signal import find_peaks

RTOL = 1e-10
ATOL = 1e-14
OUT = Path(__file__).resolve().parents[2] / "packages" / "chem" / "fixtures" / "reference.json"


def robertson(t, y):
    a, b, c = y
    return [-0.04 * a + 1e4 * b * c, 0.04 * a - 1e4 * b * c - 3e7 * b * b, 3e7 * b * b]


VDP_EPS = 1e-3


def van_der_pol(t, y):
    u, v = y
    return [v, ((1 - u * u) * v - u) / VDP_EPS]


PROBLEMS = [
    {
        "name": "robertson",
        "equations": "a' = -0.04 a + 1e4 b c; b' = 0.04 a - 1e4 b c - 3e7 b^2; c' = 3e7 b^2",
        "f": robertson,
        "y0": [1.0, 0.0, 0.0],
        "times": [0.4, 4.0, 40.0, 400.0],
    },
    {
        "name": "van_der_pol",
        "equations": "u' = v; v' = ((1 - u^2) v - u) / eps, eps = 1e-3",
        "f": van_der_pol,
        "y0": [2.0, 0.0],
        "times": [0.5, 1.0, 1.5, 2.0],
    },
]


Q = 7.62e-5
FIELD = {"q": Q, "eps": 9.9e-3, "eps_prime": 1.98e-5}
BRIZARD_BERRY = {"q": Q, "eps": 1e-3, "eps_prime": 2e-6}
HORIZON = 300.0


def oregonator_full(p):
    q, eps, ep, s = p["q"], p["eps"], p["eps_prime"], p["s"]

    def f(t, u):
        x, y, z = u
        return [(q * y - x * y + x * (1 - x)) / eps, (-q * y - x * y + s * z) / ep, x - z]

    return f


def oregonator_reduced(p):
    q, eps, s = p["q"], p["eps"], p["s"]

    def f(t, u):
        x, z = u
        return [(x * (1 - x) - s * z * (x - q) / (x + q)) / eps, x - z]

    return f


OREGONATOR = [
    {"model": "reduced", "params": {**FIELD, "s": 1.0}},
    {"model": "full", "params": {**FIELD, "s": 1.0}},
    {"model": "full", "params": {**FIELD, "eps_prime": 1e-4, "s": 1.0}},
    {"model": "full", "params": {**FIELD, "eps_prime": 1e-4, "s": 2.2}},
    {"model": "reduced", "params": {**BRIZARD_BERRY, "s": 1.0}},
    {"model": "full", "params": {**BRIZARD_BERRY, "s": 1.0}},
]


def oregonator_period(case):
    p = case["params"]
    x0, z0 = 0.5, 0.5
    if case["model"] == "full":
        f, u0 = oregonator_full(p), [x0, p["s"] * z0 / (p["q"] + x0), z0]
    else:
        f, u0 = oregonator_reduced(p), [x0, z0]
    sol = solve_ivp(f, (0.0, HORIZON), u0, method="Radau", rtol=RTOL, atol=ATOL,
                    dense_output=True, max_step=1.0)
    if not sol.success:
        sys.exit(f"oregonator {case}: {sol.message}")
    t = np.arange(HORIZON / 2, HORIZON, 1e-3)
    logx = np.log10(sol.sol(t)[0])
    idx, _ = find_peaks(logx, prominence=0.5)
    gaps = np.diff(t[idx])
    return {**case, "ic": "far", "horizon": HORIZON, "peaks": int(len(idx)),
            "period": float(gaps.mean())}


def main():
    oregonator = [oregonator_period(c) for c in OREGONATOR]
    problems = []
    for p in PROBLEMS:
        sol = solve_ivp(
            p["f"], (0.0, p["times"][-1]), p["y0"], method="Radau",
            t_eval=p["times"], rtol=RTOL, atol=ATOL,
        )
        if not sol.success:
            sys.exit(f"{p['name']}: {sol.message}")
        problems.append({
            "name": p["name"],
            "equations": p["equations"],
            "y0": p["y0"],
            "times": p["times"],
            "values": np.asarray(sol.y).T.tolist(),
        })
    manifest = {
        "generator": "tools/reference/generate.py",
        "method": "scipy.integrate.solve_ivp Radau",
        "rtol": RTOL,
        "atol": ATOL,
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "oregonator_period": "mean gap between peaks of log10 x with prominence 0.5, "
        "second half of the horizon, sampled every 1e-3",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"manifest": manifest, "problems": problems, "oregonator": oregonator}, indent=2) + "\n")


if __name__ == "__main__":
    main()
