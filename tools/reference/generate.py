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


def main():
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
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"manifest": manifest, "problems": problems}, indent=2) + "\n")


if __name__ == "__main__":
    main()
