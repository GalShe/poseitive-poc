"""מייצר נתוני אימון לבדיקת מסדי הנתונים.

הנתונים מבוססים על חזרות אמיתיות מה-POC כשהן קיימות (data/extracted/*.csv): צורת עקומת הברך
של חזרה אמיתית נלקחת כתבנית, ולכל מטופל מוסיפים שונות (עומק, קצב, רעש, שיפור לאורך זמן).
אם עוד אין סרטונים, משתמשים בתבנית סינתטית בצורת קוסינוס.
"""
from __future__ import annotations

import random
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "analysis"))


@dataclass
class Scale:
    therapists: int = 20
    patients_per_therapist: int = 20
    days: int = 90
    adherence: float = 0.7
    sets: int = 3
    reps_per_set: int = 10
    series_len: int = 50


def load_templates():
    tpl = []
    try:
        from poseitive.dtw import resample
        from poseitive.poc_tests import load_frames, reps_from_frames
        for p in sorted((REPO / "data" / "extracted").glob("*.csv")):
            for r in reps_from_frames(load_frames(p)):
                if r.ok:
                    tpl.append(resample(r.knee_series, 50))
    except Exception:  # noqa: BLE001
        pass
    if not tpl:
        tpl = [130 + 45 * np.cos(np.linspace(0, 2 * np.pi, 50))]
    return tpl, ("poc" if len(tpl) > 1 else "synthetic")


def generate(scale: Scale = Scale(), seed: int = 7):
    rng = np.random.default_rng(seed)
    random.seed(seed)
    templates, source = load_templates()
    now = datetime(2026, 10, 1, tzinfo=timezone.utc)
    therapists, patients, plans, refs, sessions = [], [], [], [], []
    pid = plan_id = sid = 0
    for t in range(1, scale.therapists + 1):
        therapists.append(dict(id=t, full_name=f"מטפל/ת {t}", email=f"therapist{t}@example.org"))
        for _ in range(scale.patients_per_therapist):
            pid += 1
            plan_id += 1
            patients.append(dict(id=pid, therapist_id=t, full_name=f"מטופל/ת {pid}", birth_year=int(rng.integers(1945, 2005))))
            thr = dict(target_depth=90, depth_tolerance=15, lean_threshold=20)
            plans.append(dict(id=plan_id, patient_id=pid, exercise_id=1, target_reps=scale.reps_per_set,
                              target_sets=scale.sets, sessions_per_week=5, thresholds=thr))
            refs.append(dict(plan_item_id=plan_id, knee_series=[round(float(x), 1) for x in templates[0]]))
            # כל מטופל מתחיל ביכולת אחרת ומשתפר בהדרגה
            start_depth = rng.uniform(95, 125)
            lean_tendency = rng.uniform(5, 30)
            adherence = float(np.clip(rng.normal(scale.adherence, 0.15), 0.1, 1.0))
            for day in range(scale.days):
                if rng.random() > adherence:
                    continue
                sid += 1
                progress = day / scale.days
                depth = start_depth - 20 * progress
                lean = lean_tendency * (1 - 0.5 * progress)
                started = now - timedelta(days=scale.days - day, hours=float(rng.uniform(7, 21)))
                reps = []
                for s in range(1, scale.sets + 1):
                    for r in range(1, scale.reps_per_set + 1):
                        tpl = templates[int(rng.integers(len(templates)))]
                        lo, hi = tpl.min(), tpl.max()
                        target_min = depth + rng.normal(0, 4) + 1.5 * s
                        series = hi - (hi - tpl) * (hi - target_min) / max(1e-6, hi - lo) + rng.normal(0, 1.2, len(tpl))
                        max_lean = lean + rng.normal(0, 5) + 1.0 * s
                        min_knee = float(series.min())
                        reps.append(dict(set_index=s, rep_index=r, duration_sec=round(float(rng.uniform(2.0, 4.0)), 2),
                                         min_knee=round(min_knee, 1), max_lean=round(float(max_lean), 1),
                                         dtw_distance=round(float(abs(rng.normal(4, 2))), 2),
                                         deep_enough=min_knee <= 105, lean_fault=max_lean > 20,
                                         knee_series=[round(float(x), 1) for x in series]))
                sessions.append(dict(id=sid, patient_id=pid, plan_item_id=plan_id, started_at=started,
                                     duration_sec=round(sum(x["duration_sec"] for x in reps) + 60, 1),
                                     device=random.choice(["iPhone 13", "Galaxy A52", "Pixel 6"]),
                                     pain_reported=bool(rng.random() < 0.02), reps=reps))
    return dict(therapists=therapists, patients=patients, plans=plans, refs=refs, sessions=sessions,
                template_source=source, now=now)
