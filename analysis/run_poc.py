#!/usr/bin/env python3
"""מריץ את כל טסטי ה-POC ומפיק את קובצי התוצאות.

שימוש:
    python analysis/run_poc.py                # מעבד את כל הסרטונים ב-data/videos ומריץ את הטסטים
    python analysis/run_poc.py --model full   # עם המודל המדויק יותר
    python analysis/run_poc.py --rotate 90    # אם הסרטונים צולמו לרוחב ונשמרו מסובבים

קלטים (ראו docs/POC_PROTOCOL.md):
    data/videos/*.mp4|*.mov      הסרטונים, לפי שמות הקבצים שבפרוטוקול
    data/groundtruth.csv          (לא חובה) video,angle – הזווית האמיתית שנמדדה בגוניומטר
    results/live/*.json           תוצאות "בדיקת ביצועים" מהאפליקציה בטלפון
    results/video/*.json          תוצאות "עיבוד סרטון" מהאפליקציה בטלפון
    results/db_benchmark.json     תוצאות השוואת מסדי הנתונים (db/benchmark.py)
פלטים:
    results/poc_results.json      כל המספרים
    results/summary.json          הטבלה שמוצגת בלשונית "תוצאות POC" באתר (מועתק גם ל-web/results)
    results/report.md             דוח קריא + גרפים ב-results/figures
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from poseitive import poc_tests as T  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
VIDEOS = REPO / "data" / "videos"
EXTRACTED = REPO / "data" / "extracted"
RESULTS = REPO / "results"
FIG = RESULTS / "figures"


def extract_all(model: str, rotate: int, force: bool):
    out, meta = {}, {}
    meta_path = EXTRACTED / f"_meta_{model}.json"
    old_meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    vids = sorted(p for p in VIDEOS.glob("*") if p.suffix.lower() in {".mp4", ".mov", ".m4v", ".avi", ".webm"})
    for v in vids:
        name = v.stem.lower()
        csv_path = EXTRACTED / f"{name}.{model}.csv"
        if csv_path.exists() and not force and name in old_meta:
            meta[name] = old_meta[name]
        else:
            from poseitive.extract import extract_video  # טעינה רק כשצריך (MediaPipe כבד)
            print(f"  מחלץ שלד: {v.name} …", flush=True)
            meta[name] = extract_video(v, csv_path, variant=model, rotate=rotate)
            print(f"    {meta[name]['frames']} פריימים, זיהוי ב-{meta[name]['detected']}, "
                  f"{meta[name]['inference_ms_median']:.1f} ms לפריים")
        out[name] = csv_path
    # סרטונים שכבר חולצו בעבר ונמחקו (הווידאו לא נשמר בריפו מטעמי פרטיות) – משתמשים ב-CSV שנשאר
    for csv_path in sorted(EXTRACTED.glob(f"*.{model}.csv")):
        name = csv_path.name[: -len(f".{model}.csv")]
        if name not in out:
            out[name] = csv_path
            meta[name] = old_meta.get(name, {})
    EXTRACTED.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=2))
    return out, meta, vids


def load_groundtruth():
    p = REPO / "data" / "groundtruth.csv"
    if not p.exists():
        return {}
    with p.open() as f:
        return {r["video"].strip().lower().rsplit(".", 1)[0]: float(r["angle"]) for r in csv.DictReader(f)}


def status(res):
    if not isinstance(res, dict) or res.get("status") == "pending":
        return "pending"
    if res.get("passed") is None:
        return "pending"
    return "pass" if res["passed"] else "fail"


def pct(x):
    return f"{x * 100:.0f}%" if isinstance(x, (int, float)) else "–"


def build_summary(R):
    acc, ref, comp, perf, srv, db = (R.get(k, {}) for k in ("accuracy", "reference", "compensation", "device", "server", "db"))
    items = []

    # 1. real-time on device
    if status(perf) == "pending":
        perf_res = "ממתין לתוצאות מהטלפונים (לשונית בדיקה חיה)"
    else:
        perf_res = "; ".join(f"{d['device']}: {d['fps']} FPS, השהיה {d['latency_ms_p95']} ms" for d in perf["devices"])
    items.append(dict(id="realtime", title="חילוץ שלד ומשוב בזמן אמת על סמארטפון", criterion="≥ 15 FPS, השהיה ≤ 0.5 שנ׳",
                      result=perf_res, status=status(perf),
                      decision="מנוע MediaPipe Pose Lite במכשיר" if status(perf) == "pass" else None))
    # 2. capture conditions
    acc_res = (f"{pct(acc.get('overall_share'))} מהפריימים בטווח, MAE {acc.get('overall_mae')}°"
               if status(acc) != "pending" else "ממתין לסרטוני cond_*")
    if acc.get("failing_conditions"):
        acc_res += f"; נכשל ב: {', '.join(acc['failing_conditions'])}"
    items.append(dict(id="conditions", title="זיהוי שלד יציב בתנאי צילום ביתיים", criterion="סטייה ≤ 10° ב-90% מהפריימים",
                      result=acc_res, status=status(acc),
                      decision="הנחיות צילום ובדיקת מיקום לפני אימון לפי התנאים שעברו" if status(acc) != "pending" else None))
    # 3. classification via reference (preliminary)
    if status(ref) != "pending" and "faulty_detected_rate" in ref.get("averaged_reference", {}):
        cls_res = f"ראשוני: זוהו {pct(ref['averaged_reference']['faulty_detected_rate'])} מהחזרות השגויות (DTW על זווית הברך)"
        cls_status = "partial"
    else:
        cls_res, cls_status = "מתוכנן לדוח ההנדסי (03.03.27)", "open"
    items.append(dict(id="classification", title="הבחנה בין ביצוע תקין לשגוי (DTW + זוויות)",
                      criterion="זיהוי ≥ 80% מהשגויים, התרעות שווא ≤ 15%", result=cls_res, status=cls_status, decision=None))
    # 4. compensation
    comp_res = (f"זיהוי {pct(comp.get('detection_rate'))}, התרעות שווא {pct(comp.get('false_alarm_rate'))} "
                f"(סף {comp.get('threshold')}°, סף מוצע {comp.get('suggested_threshold')}°)"
                if status(comp) != "pending" else "ממתין לסרטוני lean_*")
    items.append(dict(id="compensation", title="זיהוי תנועת פיצוי: הישענות יתר קדימה בסקווט",
                      criterion="זיהוי ≥ 80%, התרעות שווא ≤ 15%. אישור פיזיותרפיסט", result=comp_res,
                      status=status(comp), decision="מדד גו מול שוק מצילום צידי" if status(comp) == "pass" else None))
    # 5. reference stability
    if status(ref) != "pending":
        ref_res = (f"ייחוס יחיד: {pct(ref['single_reference']['false_alarm_rate'])} התרעות שווא; "
                   f"ממוצע של 3: {pct(ref['averaged_reference']['false_alarm_rate'])}")
    else:
        ref_res = "ממתין לסרטוני ref_*"
    items.append(dict(id="reference", title="הקלטת ייחוס אחת מול ממוצע של שלוש", criterion="התרעות שווא ≤ 10%",
                      result=ref_res, status=status(ref), decision=ref.get("recommendation")))
    # 6. physio agreement
    items.append(dict(id="physio", title="התאמת המדדים להערכת פיזיותרפיסט", criterion="מתאם בין ציון המערכת לדירוג המטפל",
                      result="דורש פיזיותרפיסט. מתוכנן לשלב הבא", status="open", decision=None))
    # 7. where to process
    if srv.get("server_inference_ms_median") is not None:
        fr = srv.get("frames_kbps", {})
        srv_res = (f"שרת: {srv['server_inference_ms_median']} ms לפריים. העלאת וידאו: ~{fr.get('640px', '–')} kbps "
                   f"לעומת {srv['landmarks_kbps']} kbps לנקודות שלד")
    else:
        srv_res = "ממתין לסרטונים"
    loc_status = "pass" if status(perf) == "pass" and srv.get("server_inference_ms_median") is not None else (
        "partial" if srv.get("server_inference_ms_median") is not None else "pending")
    items.append(dict(id="location", title="מיקום העיבוד: מכשיר, שרת או שילוב", criterion="השהיה, נתוני רשת, פרטיות",
                      result=srv_res, status=loc_status,
                      decision="עיבוד במכשיר; לשרת נשלחים רק מדדים" if loc_status == "pass" else None))
    # 8. app technology
    web_ok = status(perf) == "pass"
    items.append(dict(id="apptech", title="טכנולוגיית האפליקציה (ווב / Flutter / Kotlin)",
                      criterion="ביצועים מספיקים בפלטפורמה שנבחרה",
                      result=("אפליקציית ווב עמדה בקריטריון על המכשירים שנבדקו. ווב היא הדרך האיטית ביותר להריץ את המנוע, ולכן התוצאה מחמירה"
                              if web_ok else "ממתין לבדיקת הביצועים בטלפונים"),
                      status="pass" if web_ok else "pending",
                      decision="אפליקציית ווב (PWA) עם MediaPipe Tasks for Web" if web_ok else None))
    # 9. database
    if db.get("winner"):
        db_res = db.get("summary_he", "")
        db_status = "pass"
    elif db.get("engines"):
        db_res, db_status = db.get("summary_he", ""), "partial"
    else:
        db_res, db_status = "ממתין להרצת db/benchmark.py", "pending"
    items.append(dict(id="database", title="מסד נתונים: רלציוני מול מסמכים", criterion="שאילתות ממשק המטפל, פשטות, ביצועים",
                      result=db_res, status=db_status, decision=db.get("winner")))
    return dict(updatedAt=datetime.now(timezone.utc).isoformat(), items=items)


def make_figures(extracted, R):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return []
    FIG.mkdir(parents=True, exist_ok=True)
    figs = []
    for name, p in sorted(extracted.items()):
        df = T.load_frames(p)
        fig, ax = plt.subplots(figsize=(9, 3))
        ax.plot(df.t, df.knee_raw, lw=0.8, alpha=0.4, label="knee (raw)")
        ax.plot(df.t, df.knee, lw=1.6, label="knee (smoothed)")
        ax.plot(df.t, df.lean.clip(lower=0), lw=1.2, label="trunk - tibia")
        ax.axhline(90, ls="--", c="gray", lw=0.8)
        ax.axhline(T.DEFAULT_CONFIG["lean_threshold"], ls=":", c="red", lw=0.8)
        for a, b in T.find_holds(df):
            ax.axvspan(a, b, color="green", alpha=0.12)
        ax.set_ylim(0, 190); ax.set_xlabel("seconds"); ax.set_ylabel("degrees"); ax.set_title(name)
        ax.legend(loc="lower right", fontsize=7)
        fig.tight_layout()
        out = FIG / f"{name}.png"
        fig.savefig(out, dpi=110); plt.close(fig)
        figs.append(out)
    return figs


def write_report(R, summary, figs):
    lines = ["# Poseitive: תוצאות שלב ה-POC", "", f"עודכן: {summary['updatedAt']}", "",
             "| אי-ודאות | קריטריון | תוצאה | מצב | החלטה |", "|---|---|---|---|---|"]
    for it in summary["items"]:
        lines.append(f"| {it['title']} | {it['criterion']} | {it['result']} | {it['status']} | {it['decision'] or '–'} |")
    acc = R.get("accuracy", {})
    if acc.get("per_video"):
        lines += ["", "## דיוק לפי תנאי צילום", "", "| סרטון | תאורה | מרחק | זיהוי | ממוצע זווית | MAE | בטווח 10° | עבר |", "|---|---|---|---|---|---|---|---|"]
        for r in acc["per_video"]:
            lines.append(f"| {r['video']} | {r['light']} | {r['distance']} | {pct(r['detection_rate'])} | {r['mean_knee']} | {r['mae']} | {pct(r['share_within'])} | {r['passed']} |")
    if figs:
        lines += ["", "## גרפים", ""] + [f"![{f.stem}](figures/{f.name})" for f in figs]
    lines += ["", "המספרים המלאים: `results/poc_results.json`."]
    (RESULTS / "report.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="lite", choices=["lite", "full"])
    ap.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270])
    ap.add_argument("--force", action="store_true", help="לחלץ מחדש גם סרטונים שכבר עובדו")
    args = ap.parse_args()

    RESULTS.mkdir(exist_ok=True)
    print("1/3 חילוץ שלד מהסרטונים")
    extracted, meta, vids = extract_all(args.model, args.rotate, args.force)
    print("2/3 הרצת הטסטים")
    R = dict(model=args.model, videos=meta)
    R["accuracy"] = T.test_accuracy(extracted, load_groundtruth())
    R["reference"] = T.test_reference(extracted)
    R["compensation"] = T.test_compensation(extracted)
    R["device"] = T.test_device_performance(RESULTS / "live", RESULTS / "video")
    sample = next((v for v in vids if v.stem.lower().startswith("cond_strong")), vids[0] if vids else None)
    R["server"] = T.test_server_vs_device(meta, sample)
    dbp = RESULTS / "db_benchmark.json"
    R["db"] = json.loads(dbp.read_text()) if dbp.exists() else {}
    print("3/3 כתיבת תוצאות")
    (RESULTS / "poc_results.json").write_text(json.dumps(R, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    summary = build_summary(R)
    for target in (RESULTS / "summary.json", REPO / "web" / "results" / "summary.json"):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    figs = make_figures(extracted, R)
    write_report(R, summary, figs)
    if FIG.exists():
        shutil.copytree(FIG, REPO / "web" / "results" / "figures", dirs_exist_ok=True)
    for it in summary["items"]:
        print(f"  [{it['status']:>8}] {it['title']}: {it['result']}")


if __name__ == "__main__":
    main()
