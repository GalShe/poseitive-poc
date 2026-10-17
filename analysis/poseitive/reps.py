"""ספירת חזרות סקווט. מקביל ל-web/js/core/reps.js (אותם ספים ואותה מכונת מצבים)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

DEFAULT_CONFIG = dict(
    up_angle=160.0,
    down_angle=120.0,
    target_depth=90.0,
    depth_tolerance=15.0,
    lean_threshold=38.0,  # כויל בבדיקה החיה הראשונה: תקין 16–29°, נשען 49°
    min_visibility=0.5,
)


@dataclass
class Rep:
    index: int
    start: float
    end: float
    min_knee: float
    max_lean: float
    deep_enough: bool
    lean_fault: bool
    knee_series: list = field(default_factory=list)
    lean_series: list = field(default_factory=list)

    @property
    def ok(self):
        return self.deep_enough and not self.lean_fault

    def as_dict(self):
        return dict(index=self.index, start=round(self.start, 3), end=round(self.end, 3),
                    duration=round(self.end - self.start, 3), min_knee=round(self.min_knee, 2),
                    max_lean=round(self.max_lean, 2), deep_enough=self.deep_enough,
                    lean_fault=self.lean_fault, ok=self.ok)


class SquatRepCounter:
    def __init__(self, **cfg):
        self.cfg = {**DEFAULT_CONFIG, **cfg}
        self.state = "up"
        self.reps: list[Rep] = []
        self._cur = None

    def push(self, m: dict | None, t: float):
        c = self.cfg
        if not m or m["vis"] < c["min_visibility"] or not math.isfinite(m["knee"]):
            return None
        if self.state == "up" and m["knee"] < c["down_angle"]:
            self.state = "down"
            self._cur = dict(start=t, knee=[], lean=[])
        if self.state == "down":
            self._cur["knee"].append(m["knee"])
            if math.isfinite(m["lean"]):
                self._cur["lean"].append(m["lean"])
            if m["knee"] > c["up_angle"]:
                self.state = "up"
                cur = self._cur
                min_knee = min(cur["knee"])
                max_lean = max(cur["lean"]) if cur["lean"] else float("nan")
                rep = Rep(
                    index=len(self.reps) + 1, start=cur["start"], end=t,
                    min_knee=min_knee, max_lean=max_lean,
                    deep_enough=min_knee <= c["target_depth"] + c["depth_tolerance"],
                    lean_fault=max_lean > c["lean_threshold"],
                    knee_series=cur["knee"], lean_series=cur["lean"],
                )
                self.reps.append(rep)
                self._cur = None
                return rep
        return None
