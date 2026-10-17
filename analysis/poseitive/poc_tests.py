"""הטסטים של שלב ה-POC. כל פונקציה סוגרת אי-ודאות אחת מטבלה 4.2 במסמך הייזום
ומחזירה מילון עם התוצאה, הקריטריון והאם עבר.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import cv2
import numpy as np
import pandas as pd

from .dtw import average_reference, dtw_distance, resample
from .reps import DEFAULT_CONFIG, SquatRepCounter

# ---------------------------------------------------------------- helpers

def load_frames(csv_path: Path) -> pd.DataFrame:
    return pd.read_csv(csv_path)


def reps_from_frames(df: pd.DataFrame, **cfg):
    counter = SquatRepCounter(**cfg)
    for r in df.itertuples():
        if not r.detected:
            continue
        counter.push(dict(knee=r.knee, lean=r.lean, vis=r.vis), r.t)
    return counter.reps


def find_holds(df: pd.DataFrame, max_knee=130.0, max_std=3.0, min_sec=1.0):
    """מוצא קטעי "החזקה" בתחתית הסקווט: הברך כפופה והזווית כמעט לא משתנה לפחות שנייה.
    בקטעים האלה ידוע הערך האמיתי (הכיסא / הגוניומטר), ולכן משם מודדים דיוק."""
    d = df[(df.detected == 1) & (df.vis >= 0.5)].copy()
    if d.empty:
        return []
    fps = 1.0 / max(1e-6, np.median(np.diff(df.t)))
    win = max(3, int(round(fps * 0.5)))
    d["std"] = d.knee_raw.rolling(win, center=True, min_periods=win // 2).std()
    d["hold"] = (d.knee_raw < max_knee) & (d["std"] < max_std)
    holds, start = [], None
    prev_t = None
    for r in d.itertuples():
        gap = prev_t is not None and r.t - prev_t > 0.2
        if r.hold and start is None:
            start = r.t
        if (not r.hold or gap) and start is not None:
            end = prev_t
            if end - start >= min_sec:
                holds.append((start, end))
            start = r.t if (r.hold and gap) else None
        prev_t = r.t
    if start is not None and prev_t - start >= min_sec:
        holds.append((start, prev_t))
    return holds


def parse_condition(name: str):
    """cond_<light>_<dist>[_front].mp4 → ('strong', '2m', 'side')"""
    m = re.match(r"cond_(strong|weak|back)_([\d.]+m)(?:_(front|side))?", name)
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3) or "side"


# ---------------------------------------------------------------- 1. accuracy under home conditions

def test_accuracy(extracted: dict[str, Path], groundtruth: dict[str, float], default_gt=90.0,
                  max_err=10.0, min_share=0.90):
    """טסט מטריצת תנאים: בכל סרטון cond_* משווים את זווית הברך בקטעי ההחזקה לערך האמיתי.
    קריטריון (טבלה 4.2): סטייה של עד 10° ב-90% מהפריימים."""
    rows = []
    all_err = []
    for name, csv_path in sorted(extracted.items()):
        cond = parse_condition(name)
        if not cond:
            continue
        df = load_frames(csv_path)
        gt = groundtruth.get(name, default_gt)
        holds = find_holds(df)
        mask = np.zeros(len(df), bool)
        for a, b in holds:
            mask |= (df.t >= a).values & (df.t <= b).values
        hold = df[mask & (df.detected == 1)]
        err = (hold.knee_raw - gt).abs().values
        all_err.extend(err.tolist())
        share = float((err <= max_err).mean()) if len(err) else float("nan")
        rows.append(dict(
            video=name, light=cond[0], distance=cond[1], view=cond[2], groundtruth=gt,
            detection_rate=round(float(df.detected.mean()), 3), holds=len(holds), hold_frames=int(len(hold)),
            mean_knee=round(float(hold.knee_raw.mean()), 2) if len(hold) else None,
            mae=round(float(err.mean()), 2) if len(err) else None,
            share_within=round(share, 3) if math.isfinite(share) else None,
            passed=bool(share >= min_share) if math.isfinite(share) else None,
        ))
    all_err = np.asarray(all_err)
    overall = float((all_err <= max_err).mean()) if len(all_err) else float("nan")
    return dict(
        criterion=f"סטייה ≤ {max_err:.0f}° ב-{min_share:.0%} מהפריימים",
        per_video=rows,
        overall_share=round(overall, 3) if math.isfinite(overall) else None,
        overall_mae=round(float(all_err.mean()), 2) if len(all_err) else None,
        passed=bool(overall >= min_share) if math.isfinite(overall) else None,
        failing_conditions=[r["video"] for r in rows if r["passed"] is False],
    )


# ---------------------------------------------------------------- 2. reference stability (one vs three)

def test_reference(extracted: dict[str, Path], max_false_alarm=0.10, k_sigma=2.0):
    """טסט יציבות ייחוס: האם הקלטת ייחוס אחת מספיקה, או שעדיף ממוצע של שלוש.
    - חזרות תקינות נלקחות מ-ref_*.
    - ייחוס יחיד = החזרה הראשונה ב-ref_1. ייחוס ממוצע = החזרה הראשונה מכל אחד מ-ref_1..ref_3.
    - שאר החזרות התקינות מחולקות לשניים: חצי לכיול הסף (ממוצע + 2 סטיות תקן), חצי לבדיקה.
    קריטריון: שיעור התרעות שווא ≤ 10% על חזרות תקינות."""
    refs = sorted(n for n in extracted if re.match(r"ref_\d+", n))
    if not refs:
        return dict(status="pending", reason="אין סרטוני ref_*")
    reps_by_video = {n: reps_from_frames(load_frames(extracted[n])) for n in refs}
    first = [(n, r[0]) for n, r in reps_by_video.items() if r]
    if not first:
        return dict(status="pending", reason="לא זוהו חזרות בסרטוני הייחוס")
    single_ref = resample(first[0][1].knee_series)
    avg_ref = average_reference([r.knee_series for _, r in first[:3]])
    used = {(n, r.index) for n, r in first[:3]}
    pool = [(n, r) for n, rs in reps_by_video.items() for r in rs if (n, r.index) not in used]
    if len(pool) < 4:
        return dict(status="pending", reason=f"נמצאו רק {len(pool)} חזרות תקינות נוספות, צריך לפחות 4")
    calib, test = pool[0::2], pool[1::2]

    def evaluate(ref):
        d_cal = np.array([dtw_distance(resample(r.knee_series), ref) for _, r in calib])
        thr = float(d_cal.mean() + k_sigma * d_cal.std())
        d_test = np.array([dtw_distance(resample(r.knee_series), ref) for _, r in test])
        fa = float((d_test > thr).mean())
        return dict(threshold=round(thr, 2), calib_mean=round(float(d_cal.mean()), 2),
                    calib_std=round(float(d_cal.std()), 2), test_distances=[round(x, 2) for x in d_test],
                    false_alarm_rate=round(fa, 3), passed=fa <= max_false_alarm)

    single, avg = evaluate(single_ref), evaluate(avg_ref)
    # בונוס: האם אותו סף מזהה את החזרות השגויות (lean_*, shallow_*)?
    faulty = [r for n in extracted if re.match(r"(lean|shallow)_\d+", n) for r in reps_from_frames(load_frames(extracted[n]))]
    if faulty:
        for res, ref in ((single, single_ref), (avg, avg_ref)):
            d = np.array([dtw_distance(resample(r.knee_series), ref) for r in faulty])
            res["faulty_detected_rate"] = round(float((d > res["threshold"]).mean()), 3)
    return dict(
        criterion=f"התרעות שווא ≤ {max_false_alarm:.0%} על חזרות תקינות",
        correct_reps_total=len(pool) + len(used), calib_reps=len(calib), test_reps=len(test),
        single_reference=single, averaged_reference=avg,
        recommendation=("ייחוס ממוצע של 3 הקלטות" if (avg["false_alarm_rate"] < single["false_alarm_rate"])
                        else "הקלטת ייחוס אחת מספיקה"),
        passed=bool(single["passed"] or avg["passed"]),
    )


# ---------------------------------------------------------------- 3. compensation (forward lean)

def test_compensation(extracted: dict[str, Path], threshold=DEFAULT_CONFIG["lean_threshold"],
                      min_detect=0.80, max_false_alarm=0.15):
    """זיהוי הישענות יתר קדימה: חזרות מ-lean_* מסומנות כשגויות, חזרות מ-ref_* ו-cond_*_side כתקינות.
    המדד לכל חזרה: הערך המרבי של (נטיית הגו − נטיית השוק). קריטריון (מטבלה 4.2, טסט הסיווג):
    זיהוי ≥ 80% מהשגויות עם ≤ 15% התרעות שווא."""
    bad = [r.max_lean for n in extracted if re.match(r"lean_\d+", n) for r in reps_from_frames(load_frames(extracted[n]))]
    good = [r.max_lean for n in extracted
            if re.match(r"ref_\d+", n) or (parse_condition(n) and parse_condition(n)[2] == "side")
            for r in reps_from_frames(load_frames(extracted[n]))]
    if not bad or not good:
        return dict(status="pending", reason="צריך גם סרטוני lean_* וגם סרטונים תקינים")
    bad, good = np.array(bad), np.array(good)
    det = float((bad > threshold).mean())
    fa = float((good > threshold).mean())
    # הסף שממקסם (זיהוי − התרעות שווא) על הנתונים שנאספו – הצעה לסף, לאישור הפיזיותרפיסט
    if bad.min() > good.max():
        # הפרדה מלאה: הסף המוצע הוא אמצע הפער בין החזרה התקינה הגבוהה ביותר לשגויה הנמוכה ביותר
        best = (good.max() + bad.min()) / 2
    else:
        cands = np.unique(np.concatenate([bad, good]))
        best = max(cands, key=lambda c: (bad > c).mean() - (good > c).mean())
    return dict(
        criterion=f"זיהוי ≥ {min_detect:.0%}, התרעות שווא ≤ {max_false_alarm:.0%}",
        threshold=threshold, faulty_reps=len(bad), correct_reps=len(good),
        detection_rate=round(det, 3), false_alarm_rate=round(fa, 3),
        lean_correct_mean=round(float(good.mean()), 1), lean_faulty_mean=round(float(bad.mean()), 1),
        suggested_threshold=round(float(best), 1),
        correct_range=[round(float(good.min()), 1), round(float(good.max()), 1)],
        faulty_range=[round(float(bad.min()), 1), round(float(bad.max()), 1)],
        passed=bool(det >= min_detect and fa <= max_false_alarm),
    )


# ---------------------------------------------------------------- 4. on-device performance (from the web app)

def test_device_performance(live_dir: Path, video_dir: Path, min_fps=15.0, max_latency=500.0):
    """מאגד את קובצי ה-JSON שהאפליקציה בטלפון מייצאת. קריטריון: ≥15 FPS והשהיה ≤ 0.5 שנייה."""
    devices = []
    for p in sorted(live_dir.glob("*.json")):
        d = json.loads(p.read_text())
        s = d["summary"]
        devices.append(dict(
            file=p.name, device=d["device"].get("deviceModel") or d["device"]["userAgent"][:60],
            model=d["engine"]["variant"], delegate=d["engine"]["delegate"], resolution=d["camera"]["resolution"],
            fps=round(s["fpsMean"], 1), inference_ms_median=round(s["inferenceMsMedian"], 1),
            latency_ms_p95=round(s["latencyMsP95"], 1) if s.get("latencyMsP95") is not None else None,
            latency_kind=s.get("latencyKind"), detection_rate=round(s["detectionRate"], 3),
            passed=bool(s["fpsMean"] >= min_fps and (s.get("latencyMsP95") or 1e9) <= max_latency),
        ))
    videos = []
    for p in sorted(video_dir.glob("*.json")):
        d = json.loads(p.read_text())
        s = d["summary"]
        videos.append(dict(file=p.name, device=d["device"].get("deviceModel") or d["device"]["userAgent"][:60],
                           model=d["engine"]["variant"], delegate=d["engine"]["delegate"],
                           inference_ms_median=round(s["inferenceMsMedian"], 1),
                           max_fps=round(s["maxFpsFromInference"], 1)))
    if not devices:
        return dict(status="pending", reason="עוד לא התקבלו תוצאות מהטלפונים", on_device_video=videos)
    return dict(criterion=f"≥ {min_fps:.0f} FPS והשהיה ≤ {max_latency:.0f} ms", devices=devices,
                on_device_video=videos, devices_tested=len({d['device'] for d in devices}),
                passed=all(d["passed"] for d in devices))


# ---------------------------------------------------------------- 5. server-side processing & network cost

def test_server_vs_device(extracted_meta: dict[str, dict], sample_video: Path | None, fps=15):
    """עיבוד בשרת לעומת עיבוד במכשיר:
    - זמן עיבוד לפריים על מעבד השרת (המכונה שעליה רץ הסקריפט).
    - כמות הנתונים שצריך להעלות לרשת: פריימים דחוסים (JPEG) לעומת נקודות שלד בלבד."""
    med = [m["inference_ms_median"] for m in extracted_meta.values() if m.get("inference_ms_median")]
    out = dict(server_inference_ms_median=round(float(np.median(med)), 1) if med else None)
    landmark_bytes = 33 * 4 * 4 + 16  # 33 נקודות × (x,y,z,visibility) float32 + כותרת
    out["landmarks_kbps"] = round(landmark_bytes * fps * 8 / 1000, 1)
    if sample_video and sample_video.exists():
        cap = cv2.VideoCapture(str(sample_video))
        sizes = {"original": [], "640px": []}
        for _ in range(60):
            ok, f = cap.read()
            if not ok:
                break
            sizes["original"].append(len(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 80])[1]))
            h, w = f.shape[:2]
            small = cv2.resize(f, (640, int(640 * h / w)))
            sizes["640px"].append(len(cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 80])[1]))
        cap.release()
        out["frames_kbps"] = {k: round(float(np.mean(v)) * fps * 8 / 1000, 0) for k, v in sizes.items() if v}
        out["upload_ratio_vs_landmarks"] = {k: round(v / out["landmarks_kbps"]) for k, v in out["frames_kbps"].items()}
    out["note"] = "בעיבוד במכשיר נשלחים לשרת רק המדדים בסיום האימון, והווידאו לא יוצא מהמכשיר (סיכון 4 בטבלה 4.3)."
    return out
