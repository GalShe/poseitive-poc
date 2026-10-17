"""בדיקות יחידה ללוגיקה: גיאומטריה, ספירת חזרות, DTW והטסטים של ה-POC על נתונים סינתטיים.
הרצה: python -m pytest analysis/tests -q
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poseitive.dtw import dtw_distance, resample  # noqa: E402
from poseitive.geometry import Point, angle_at, inclination_from_vertical, squat_metrics  # noqa: E402
from poseitive.reps import SquatRepCounter  # noqa: E402
from poseitive import poc_tests as T  # noqa: E402


def stick_figure(knee_deg, trunk_deg, tibia_deg=25.0, w=1000, h=1000):
    """בונה שלד צידי סינתטי (צד שמאל) עם זווית ברך ונטיית גו נתונות, בקואורדינטות מנורמלות."""
    ankle = np.array([500.0, 900.0])
    shin, thigh, torso = 220.0, 230.0, 300.0
    t = math.radians(tibia_deg)
    knee = ankle + shin * np.array([math.sin(t), -math.cos(t)])
    # כיוון הירך: מסובבים את כיוון קרסול→ברך כך שהזווית בברך תהיה knee_deg
    u = (knee - ankle) / shin
    phi = math.radians(180 - knee_deg)
    rot = np.array([[math.cos(phi), math.sin(phi)], [-math.sin(phi), math.cos(phi)]])
    hip = knee + thigh * (rot @ u)
    tr = math.radians(trunk_deg)
    shoulder = hip + torso * np.array([math.sin(tr), -math.cos(tr)])
    lms = [dict(x=0.5, y=0.5, z=0.0, visibility=0.1) for _ in range(33)]
    for idx, p in ((11, shoulder), (23, hip), (25, knee), (27, ankle)):
        lms[idx] = dict(x=p[0] / w, y=p[1] / h, z=0.0, visibility=0.99)
    return lms


def test_angle_basics():
    assert abs(angle_at(Point(0, -1), Point(0, 0), Point(1, 0)) - 90) < 1e-9
    assert abs(angle_at(Point(0, -1), Point(0, 0), Point(0, 1)) - 180) < 1e-9
    assert abs(inclination_from_vertical(Point(0, 0), Point(0, -1))) < 1e-9
    assert abs(inclination_from_vertical(Point(0, 0), Point(1, -1)) - 45) < 1e-9


def test_squat_metrics_recovers_angles():
    for knee, trunk in ((90, 25), (120, 40), (170, 5), (95, 60)):
        m = squat_metrics(stick_figure(knee, trunk), 1000, 1000)
        assert m["side"] == "left"
        assert abs(m["knee"] - knee) < 0.5, (knee, m["knee"])
        assert abs(m["trunk"] - trunk) < 0.5
        assert abs(m["lean"] - (trunk - 25)) < 0.5


def test_aspect_ratio_matters():
    # אותה תנוחה בסרטון 16:9: אם לא ממירים לפיקסלים הזווית הייתה יוצאת שגויה
    lms = stick_figure(90, 25, w=1000, h=1000)
    sq = [dict(l, x=l["x"] * 1000 / 1600) for l in lms]  # אותן נקודות פיקסל, מנורמלות לרוחב 1600
    m = squat_metrics(sq, 1600, 1000)
    assert abs(m["knee"] - 90) < 0.5


def synthetic_session(n_reps=5, fps=30, min_knee=90, lean_peak=5.0, hold=1.5, rest=0.8, noise=1.0, seed=0):
    rng = np.random.default_rng(seed)
    rows, t = [], 0.0
    def add(knee, lean):
        nonlocal t
        rows.append(dict(t=t, detected=1, knee=knee + rng.normal(0, noise * 0.3), knee_raw=knee + rng.normal(0, noise),
                         lean=lean + rng.normal(0, 1.0), vis=0.95))
        t += 1 / fps
    for _ in range(n_reps):
        for k in np.linspace(175, min_knee, int(fps * 1.2)):
            add(k, lean_peak * (175 - k) / (175 - min_knee))
        for _ in range(int(fps * hold)):
            add(min_knee, lean_peak)
        for k in np.linspace(min_knee, 175, int(fps * 1.0)):
            add(k, lean_peak * (175 - k) / (175 - min_knee))
        for _ in range(int(fps * rest)):
            add(175, 0)
    return pd.DataFrame(rows)


def test_rep_counter_counts_and_flags():
    df = synthetic_session(n_reps=4, lean_peak=35)
    reps = T.reps_from_frames(df)
    assert len(reps) == 4
    assert all(r.lean_fault for r in reps)
    assert all(r.deep_enough for r in reps)
    shallow = T.reps_from_frames(synthetic_session(n_reps=3, min_knee=115))
    assert len(shallow) == 3 and not any(r.deep_enough for r in shallow)


def test_dtw_tempo_invariant():
    base = 130 + 45 * np.cos(np.linspace(0, 2 * np.pi, 60))
    slow = 130 + 45 * np.cos(np.linspace(0, 2 * np.pi, 120))
    shallow = 150 + 25 * np.cos(np.linspace(0, 2 * np.pi, 60))
    assert dtw_distance(base, slow) < 1.0
    assert dtw_distance(base, shallow) > 5 * dtw_distance(base, slow)
    assert len(resample(base, 100)) == 100


def test_find_holds_and_accuracy(tmp_path):
    df = synthetic_session(n_reps=3, min_knee=92)
    p = tmp_path / "cond_strong_2m.csv"
    df.to_csv(p, index=False)
    holds = T.find_holds(df)
    assert len(holds) == 3
    res = T.test_accuracy({"cond_strong_2m": p}, {})
    assert res["passed"] is True
    assert abs(res["per_video"][0]["mean_knee"] - 92) < 1.5


def test_compensation_and_reference(tmp_path):
    ex = {}
    for i in range(1, 4):
        p = tmp_path / f"ref_{i}.csv"; synthetic_session(5, lean_peak=5, seed=i).to_csv(p, index=False); ex[f"ref_{i}"] = p
    for i in range(1, 3):
        p = tmp_path / f"lean_{i}.csv"; synthetic_session(5, lean_peak=35, seed=10 + i).to_csv(p, index=False); ex[f"lean_{i}"] = p
    comp = T.test_compensation(ex)
    assert comp["detection_rate"] == 1.0 and comp["false_alarm_rate"] == 0.0 and comp["passed"]
    ref = T.test_reference(ex)
    assert ref["correct_reps_total"] == 15
    assert "single_reference" in ref and "averaged_reference" in ref
