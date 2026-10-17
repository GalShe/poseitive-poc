"""חישובים ביומכניים מנקודות השלד. מקביל אחד-לאחד ל-web/js/core/geometry.js."""
from __future__ import annotations

import math
from dataclasses import dataclass

L_SHOULDER, R_SHOULDER = 11, 12
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANKLE, R_ANKLE = 27, 28

SIDES = {
    "left": dict(shoulder=L_SHOULDER, hip=L_HIP, knee=L_KNEE, ankle=L_ANKLE),
    "right": dict(shoulder=R_SHOULDER, hip=R_HIP, knee=R_KNEE, ankle=R_ANKLE),
}


@dataclass
class Point:
    x: float
    y: float
    v: float = 1.0


def to_px(lm, width: int, height: int) -> Point:
    """MediaPipe מחזיר קואורדינטות מנורמלות; ממירים לפיקסלים כדי שהזוויות יהיו נכונות גיאומטרית."""
    return Point(lm["x"] * width, lm["y"] * height, lm.get("visibility", 1.0))


def angle_at(a: Point, b: Point, c: Point) -> float:
    """זווית במעלות בנקודה b בין b→a ל-b→c. 180 = ישר, 90 = זווית ישרה."""
    v1 = (a.x - b.x, a.y - b.y)
    v2 = (c.x - b.x, c.y - b.y)
    n = math.hypot(*v1) * math.hypot(*v2)
    if n == 0:
        return float("nan")
    cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / n))
    return math.degrees(math.acos(cos))


def inclination_from_vertical(frm: Point, to: Point) -> float:
    """זווית הקטע frm→to מול האנך כלפי מעלה (0 = זקוף). ציר y בתמונה גדל כלפי מטה."""
    dx, dy = to.x - frm.x, to.y - frm.y
    n = math.hypot(dx, dy)
    if n == 0:
        return float("nan")
    return math.degrees(math.acos(max(-1.0, min(1.0, -dy / n))))


def pick_side(landmarks) -> str:
    def vis(side):
        return sum(landmarks[i].get("visibility", 0.0) for i in SIDES[side].values())
    return "left" if vis("left") >= vis("right") else "right"


def squat_metrics(landmarks, width: int, height: int, side: str | None = None) -> dict | None:
    """מדדים לפריים אחד: זווית ברך, נטיית גו, נטיית שוק, הישענות יתר (גו פחות שוק), נראות מזערית."""
    if not landmarks or len(landmarks) < 33:
        return None
    s = side or pick_side(landmarks)
    idx = SIDES[s]
    sh, hip, knee, ankle = (to_px(landmarks[idx[k]], width, height) for k in ("shoulder", "hip", "knee", "ankle"))
    trunk = inclination_from_vertical(hip, sh)
    tibia = inclination_from_vertical(ankle, knee)
    return dict(
        side=s,
        knee=angle_at(hip, knee, ankle),
        trunk=trunk,
        tibia=tibia,
        lean=trunk - tibia,
        vis=min(sh.v, hip.v, knee.v, ankle.v),
    )


class Ema:
    def __init__(self, alpha: float = 0.5):
        self.alpha, self.value = alpha, None

    def push(self, x: float):
        if x is None or not math.isfinite(x):
            return self.value
        self.value = x if self.value is None else self.alpha * x + (1 - self.alpha) * self.value
        return self.value
