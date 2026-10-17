"""חילוץ שלד מסרטון: לכל פריים נשמרות 33 נקודות הציון, המדדים הביומכניים וזמן העיבוד.

התוצאה נשמרת כ-CSV ב-data/extracted/<שם הסרטון>.csv, כך שאפשר להריץ את הטסטים שוב בלי לחלץ מחדש.
"""
from __future__ import annotations

import csv
import math
import time
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

from .geometry import Ema, squat_metrics

REPO = Path(__file__).resolve().parents[2]
MODELS = REPO / "web" / "models"


def make_landmarker(variant: str = "lite"):
    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(MODELS / f"pose_landmarker_{variant}.task")),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return vision.PoseLandmarker.create_from_options(opts)


def rotate_if_needed(frame, rotate: int):
    if rotate == 90:
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    if rotate == 180:
        return cv2.rotate(frame, cv2.ROTATE_180)
    if rotate == 270:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame


def extract_video(path: Path, out_csv: Path, variant: str = "lite", rotate: int = 0, ema_alpha: float = 0.5):
    """מחלץ שלד מכל פריים. מחזיר מילון עם סיכום (מספר פריימים, fps של הסרטון, זמני עיבוד)."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    landmarker = make_landmarker(variant)
    ema_k, ema_l = Ema(ema_alpha), Ema(ema_alpha)
    rows, inf_ms = [], []
    i = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frame = rotate_if_needed(frame, rotate)
            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            t_ms = int(round(i * 1000.0 / fps))
            t0 = time.perf_counter()
            res = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), t_ms)
            dt = (time.perf_counter() - t0) * 1000
            inf_ms.append(dt)
            row = dict(frame=i, t=t_ms / 1000.0, width=w, height=h, inference_ms=round(dt, 3), detected=0)
            if res.pose_landmarks:
                lms = [dict(x=p.x, y=p.y, z=p.z, visibility=p.visibility) for p in res.pose_landmarks[0]]
                m = squat_metrics(lms, w, h)
                row.update(detected=1, side=m["side"], knee_raw=m["knee"], lean_raw=m["lean"],
                           knee=ema_k.push(m["knee"]), lean=ema_l.push(m["lean"]),
                           trunk=m["trunk"], tibia=m["tibia"], vis=m["vis"])
                for j, p in enumerate(lms):
                    row[f"x{j}"], row[f"y{j}"], row[f"v{j}"] = p["x"], p["y"], p["visibility"]
            rows.append(row)
            i += 1
    finally:
        landmarker.close()
        cap.release()

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    cols = ["frame", "t", "width", "height", "inference_ms", "detected", "side", "knee_raw", "lean_raw",
            "knee", "lean", "trunk", "tibia", "vis"] + [f"{a}{j}" for j in range(33) for a in "xyv"]
    with out_csv.open("w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=cols)
        wr.writeheader()
        for r in rows:
            wr.writerow({k: (round(v, 5) if isinstance(v, float) and math.isfinite(v) else v) for k, v in r.items()})
    inf_sorted = sorted(inf_ms)
    return dict(frames=len(rows), video_fps=fps,
                detected=sum(r["detected"] for r in rows),
                inference_ms_median=inf_sorted[len(inf_sorted) // 2] if inf_sorted else float("nan"),
                inference_ms_p95=inf_sorted[int(0.95 * (len(inf_sorted) - 1))] if inf_sorted else float("nan"))
