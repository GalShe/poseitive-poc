"""Dynamic Time Warping. מקביל ל-web/js/core/dtw.js."""
from __future__ import annotations

import numpy as np


def dtw_distance(a, b, window: int | None = None) -> float:
    a, b = np.asarray(a, float), np.asarray(b, float)
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return float("nan")
    w = window if window is not None else max(n, m)
    prev = np.full(m + 1, np.inf)
    prev[0] = 0.0
    for i in range(1, n + 1):
        cur = np.full(m + 1, np.inf)
        j0, j1 = max(1, i - w), min(m, i + w)
        for j in range(j0, j1 + 1):
            cost = abs(a[i - 1] - b[j - 1])
            cur[j] = cost + min(prev[j], cur[j - 1], prev[j - 1])
        prev = cur
    return float(prev[m] / (n + m))


def resample(series, length: int = 100):
    s = np.asarray(series, float)
    if len(s) == 0:
        return np.array([])
    if len(s) == 1:
        return np.full(length, s[0])
    return np.interp(np.linspace(0, len(s) - 1, length), np.arange(len(s)), s)


def average_reference(series_list, length: int = 100):
    return np.mean([resample(s, length) for s in series_list], axis=0)
