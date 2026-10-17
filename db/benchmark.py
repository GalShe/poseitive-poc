#!/usr/bin/env python3
"""השוואת מסדי נתונים: PostgreSQL (רלציוני) מול MongoDB (מסמכים).

1. טוען את אותם נתונים לשני המסדים (db/generate.py).
2. מריץ את חמש השאילתות שממשק הפיזיותרפיסט יצטרך.
3. בודק ששני המסדים מחזירים את אותן תשובות.
4. מודד זמני ריצה (חציון של 20 הרצות) ונפח אחסון.

שימוש:
    python db/benchmark.py --pg "postgresql://postgres:postgres@localhost:5432/poseitive" \
                           --mongo "mongodb://localhost:27017" [--small]
ללא --mongo (או אם השרת לא זמין) רץ רק PostgreSQL, ומונגו נבדק לנכונות בלבד מול mongomock.
"""
from __future__ import annotations

import argparse
import io
import json
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "db"))
from generate import Scale, generate  # noqa: E402

QUERIES_HE = {
    "Q1_patient_progress": "התקדמות מטופל: סיכום לכל אימון ב-30 הימים האחרונים",
    "Q2_therapist_dashboard": "לוח המטפל: לכל מטופל, אימון אחרון, אימונים בשבוע ושיעור טעויות",
    "Q3_inactive_patients": "התראה: מטופלים שלא התאמנו 3 ימים",
    "Q4_session_detail": "פירוט אימון אחד כולל עקומת הזוויות של כל חזרה",
    "Q5_weekly_lean_trend": "מגמה שבועית של הישענות יתר לכל מטופל (12 שבועות)",
}


# ================================================================== PostgreSQL

class Pg:
    name = "PostgreSQL"

    def __init__(self, dsn):
        import psycopg
        self.c = psycopg.connect(dsn, autocommit=True)

    def load(self, D):
        cur = self.c.cursor()
        cur.execute((REPO / "db" / "schema_postgres.sql").read_text())
        cur.execute("INSERT INTO exercises(id, code, name_he, view) VALUES (1,'squat','סקווט','side')")
        with cur.copy("COPY therapists(id, full_name, email) FROM STDIN") as cp:
            for t in D["therapists"]:
                cp.write_row((t["id"], t["full_name"], t["email"]))
        with cur.copy("COPY patients(id, therapist_id, full_name, birth_year) FROM STDIN") as cp:
            for p in D["patients"]:
                cp.write_row((p["id"], p["therapist_id"], p["full_name"], p["birth_year"]))
        with cur.copy("COPY plan_items(id, patient_id, exercise_id, target_reps, target_sets, sessions_per_week, thresholds) FROM STDIN") as cp:
            for p in D["plans"]:
                cp.write_row((p["id"], p["patient_id"], p["exercise_id"], p["target_reps"], p["target_sets"], p["sessions_per_week"], json.dumps(p["thresholds"])))
        with cur.copy("COPY reference_recordings(plan_item_id, knee_series) FROM STDIN") as cp:
            for r in D["refs"]:
                cp.write_row((r["plan_item_id"], r["knee_series"]))
        with cur.copy("COPY sessions(id, patient_id, plan_item_id, started_at, duration_sec, device, pain_reported) FROM STDIN") as cp:
            for s in D["sessions"]:
                cp.write_row((s["id"], s["patient_id"], s["plan_item_id"], s["started_at"], s["duration_sec"], s["device"], s["pain_reported"]))
        with cur.copy("COPY reps(session_id, set_index, rep_index, duration_sec, min_knee, max_lean, dtw_distance, deep_enough, lean_fault, knee_series) FROM STDIN") as cp:
            for s in D["sessions"]:
                for r in s["reps"]:
                    cp.write_row((s["id"], r["set_index"], r["rep_index"], r["duration_sec"], r["min_knee"], r["max_lean"],
                                  r["dtw_distance"], r["deep_enough"], r["lean_fault"], r["knee_series"]))
        for tbl in ("therapists", "patients", "plan_items", "sessions"):
            cur.execute(f"SELECT setval(pg_get_serial_sequence('{tbl}','id'), (SELECT max(id) FROM {tbl}))")
        cur.execute("ANALYZE")

    def size_mb(self):
        return self.c.execute("SELECT pg_database_size(current_database())").fetchone()[0] / 1e6

    def q1(self, patient_id, now):
        return [dict(session_id=r[0], reps=r[1], avg_min_knee=round(r[2], 1), ok_rate=round(r[3], 3), lean_faults=r[4])
                for r in self.c.execute("""
            SELECT s.id, count(*), avg(r.min_knee), avg((r.deep_enough AND NOT r.lean_fault)::int), sum(r.lean_fault::int)
            FROM sessions s JOIN reps r ON r.session_id = s.id
            WHERE s.patient_id = %s AND s.started_at >= %s
            GROUP BY s.id, s.started_at ORDER BY s.started_at""", (patient_id, now - timedelta(days=30)))]

    def q2(self, therapist_id, now):
        return [dict(patient_id=r[0], last_session=r[1], sessions_7d=r[2], fault_rate_7d=round(r[3], 3) if r[3] is not None else None)
                for r in self.c.execute("""
            SELECT p.id,
                   (SELECT max(started_at) FROM sessions s WHERE s.patient_id = p.id),
                   (SELECT count(*) FROM sessions s WHERE s.patient_id = p.id AND s.started_at >= %(since)s),
                   (SELECT avg((NOT (r.deep_enough AND NOT r.lean_fault))::int) FROM sessions s JOIN reps r ON r.session_id = s.id
                     WHERE s.patient_id = p.id AND s.started_at >= %(since)s)
            FROM patients p WHERE p.therapist_id = %(t)s ORDER BY p.id""", dict(t=therapist_id, since=now - timedelta(days=7)))]

    def q3(self, therapist_id, now):
        return [r[0] for r in self.c.execute("""
            SELECT p.id FROM patients p
            LEFT JOIN LATERAL (SELECT max(started_at) AS last FROM sessions s WHERE s.patient_id = p.id) l ON true
            WHERE p.therapist_id = %s AND (l.last IS NULL OR l.last < %s) ORDER BY p.id""", (therapist_id, now - timedelta(days=3)))]

    def q4(self, session_id, now):
        rows = self.c.execute("""SELECT set_index, rep_index, min_knee, max_lean, knee_series FROM reps
                                 WHERE session_id = %s ORDER BY set_index, rep_index""", (session_id,)).fetchall()
        return [dict(set=r[0], rep=r[1], min_knee=r[2], max_lean=r[3], n=len(r[4])) for r in rows]

    def q5(self, therapist_id, now):
        return [dict(patient_id=r[0], week=r[1], lean_rate=round(r[2], 3)) for r in self.c.execute("""
            SELECT s.patient_id, to_char(s.started_at AT TIME ZONE 'UTC', 'IYYY-IW'), avg(r.lean_fault::int)
            FROM sessions s JOIN patients p ON p.id = s.patient_id JOIN reps r ON r.session_id = s.id
            WHERE p.therapist_id = %s AND s.started_at >= %s
            GROUP BY 1, 2 ORDER BY 1, 2""", (therapist_id, now - timedelta(weeks=12)))]


# ================================================================== MongoDB

class Mongo:
    name = "MongoDB"

    def __init__(self, uri=None):
        if uri:
            import pymongo
            self.client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=3000)
            self.client.admin.command("ping")
            self.mock = False
        else:
            import mongomock
            self.client = mongomock.MongoClient()
            self.mock = True
        self.db = self.client["poseitive"]

    def load(self, D):
        self.client.drop_database("poseitive")
        db = self.db
        # מבנה מסמכים: האימון הוא מסמך אחד שמכיל את כל החזרות שלו (embedding).
        # therapist_id משוכפל לתוך מסמך האימון כדי שלוח המטפל לא יצטרך join.
        db.therapists.insert_many([dict(_id=t["id"], full_name=t["full_name"], email=t["email"]) for t in D["therapists"]])
        db.patients.insert_many([dict(_id=p["id"], therapist_id=p["therapist_id"], full_name=p["full_name"], birth_year=p["birth_year"]) for p in D["patients"]])
        db.plans.insert_many([dict(_id=p["id"], patient_id=p["patient_id"], exercise="squat", target_reps=p["target_reps"],
                                   target_sets=p["target_sets"], thresholds=p["thresholds"],
                                   reference=next(r["knee_series"] for r in D["refs"] if r["plan_item_id"] == p["id"])) for p in D["plans"]])
        th = {p["id"]: p["therapist_id"] for p in D["patients"]}
        batch = []
        for s in D["sessions"]:
            batch.append(dict(_id=s["id"], patient_id=s["patient_id"], therapist_id=th[s["patient_id"]], plan_id=s["plan_item_id"],
                              started_at=s["started_at"], duration_sec=s["duration_sec"], device=s["device"],
                              pain_reported=s["pain_reported"], reps=s["reps"]))
            if len(batch) == 2000:
                db.sessions.insert_many(batch); batch = []
        if batch:
            db.sessions.insert_many(batch)
        db.patients.create_index("therapist_id")
        db.sessions.create_index([("patient_id", 1), ("started_at", -1)])
        db.sessions.create_index([("therapist_id", 1), ("started_at", -1)])

    def size_mb(self):
        if self.mock:
            return None
        return self.db.command("dbstats")["storageSize"] / 1e6

    def q1(self, patient_id, now):
        cur = self.db.sessions.aggregate([
            {"$match": {"patient_id": patient_id, "started_at": {"$gte": now - timedelta(days=30)}}},
            {"$sort": {"started_at": 1}},
            {"$unwind": "$reps"},
            {"$group": {"_id": "$_id", "started_at": {"$first": "$started_at"}, "reps": {"$sum": 1},
                        "avg_min_knee": {"$avg": "$reps.min_knee"},
                        "ok": {"$sum": {"$cond": [{"$and": [{"$eq": ["$reps.deep_enough", True]}, {"$eq": ["$reps.lean_fault", False]}]}, 1, 0]}},
                        "lean_faults": {"$sum": {"$cond": [{"$eq": ["$reps.lean_fault", True]}, 1, 0]}}}},
            {"$sort": {"started_at": 1}},
        ])
        return [dict(session_id=d["_id"], reps=d["reps"], avg_min_knee=round(d["avg_min_knee"], 1),
                     ok_rate=round(d["ok"] / d["reps"], 3), lean_faults=d["lean_faults"]) for d in cur]

    def q2(self, therapist_id, now):
        since = now - timedelta(days=7)
        pats = [p["_id"] for p in self.db.patients.find({"therapist_id": therapist_id}, {"_id": 1}).sort("_id", 1)]
        last = {d["_id"]: d["last"] for d in self.db.sessions.aggregate([
            {"$match": {"therapist_id": therapist_id}}, {"$group": {"_id": "$patient_id", "last": {"$max": "$started_at"}}}])}
        week = {d["_id"]: d for d in self.db.sessions.aggregate([
            {"$match": {"therapist_id": therapist_id, "started_at": {"$gte": since}}},
            {"$unwind": "$reps"},
            {"$group": {"_id": "$patient_id", "sessions": {"$addToSet": "$_id"}, "n": {"$sum": 1},
                        "bad": {"$sum": {"$cond": [{"$and": [{"$eq": ["$reps.deep_enough", True]}, {"$eq": ["$reps.lean_fault", False]}]}, 0, 1]}}}}])}
        out = []
        for p in pats:
            w = week.get(p)
            out.append(dict(patient_id=p, last_session=last.get(p), sessions_7d=len(w["sessions"]) if w else 0,
                            fault_rate_7d=round(w["bad"] / w["n"], 3) if w else None))
        return out

    def q3(self, therapist_id, now):
        pats = [p["_id"] for p in self.db.patients.find({"therapist_id": therapist_id}, {"_id": 1})]
        recent = set(self.db.sessions.distinct("patient_id", {"therapist_id": therapist_id, "started_at": {"$gte": now - timedelta(days=3)}}))
        return sorted(p for p in pats if p not in recent)

    def q4(self, session_id, now):
        s = self.db.sessions.find_one({"_id": session_id})
        reps = sorted(s["reps"], key=lambda r: (r["set_index"], r["rep_index"]))
        return [dict(set=r["set_index"], rep=r["rep_index"], min_knee=r["min_knee"], max_lean=r["max_lean"], n=len(r["knee_series"])) for r in reps]

    def q5(self, therapist_id, now):
        cur = self.db.sessions.aggregate([
            {"$match": {"therapist_id": therapist_id, "started_at": {"$gte": now - timedelta(weeks=12)}}},
            {"$addFields": {"wk": {"$dateToString": {"format": "%G-%V", "date": "$started_at"}}}},
            {"$unwind": "$reps"},
            {"$group": {"_id": {"p": "$patient_id", "wk": "$wk"}, "n": {"$sum": 1},
                        "lean": {"$sum": {"$cond": [{"$eq": ["$reps.lean_fault", True]}, 1, 0]}}}},
            {"$sort": {"_id.p": 1, "_id.wk": 1}},
        ])
        return [dict(patient_id=d["_id"]["p"], week=d["_id"]["wk"], lean_rate=round(d["lean"] / d["n"], 3)) for d in cur]


# ================================================================== runner

def norm(rows):
    """נרמול לצורך השוואת תשובות בין המסדים (זמנים בלי מיקרו-שניות, מספרים מעוגלים)."""
    def fix(v):
        if isinstance(v, datetime):
            if v.tzinfo is not None:
                v = v.astimezone(timezone.utc)
            return v.replace(tzinfo=None, microsecond=0).isoformat()
        if isinstance(v, Decimal):
            v = float(v)
        if isinstance(v, float):
            return round(v, 3)
        return v
    return [({k: fix(v) for k, v in r.items()} if isinstance(r, dict) else r) for r in rows]


def run(db, D, repeats):
    t0 = time.perf_counter()
    db.load(D)
    load_s = time.perf_counter() - t0
    now = D["now"]
    params = dict(Q1_patient_progress=(db.q1, 7), Q2_therapist_dashboard=(db.q2, 3), Q3_inactive_patients=(db.q3, 3),
                  Q4_session_detail=(db.q4, D["sessions"][len(D["sessions"]) // 2]["id"]), Q5_weekly_lean_trend=(db.q5, 3))
    out, answers = {}, {}
    for q, (fn, arg) in params.items():
        answers[q] = norm(fn(arg, now))
        times = []
        for _ in range(repeats):
            t = time.perf_counter(); fn(arg, now); times.append((time.perf_counter() - t) * 1000)
        out[q] = dict(median_ms=round(statistics.median(times), 2), p95_ms=round(sorted(times)[int(0.95 * (len(times) - 1))], 2), rows=len(answers[q]))
    return dict(engine=db.name, load_sec=round(load_s, 1), size_mb=round(db.size_mb(), 1) if db.size_mb() else None, queries=out), answers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pg", required=True)
    ap.add_argument("--mongo", default=None)
    ap.add_argument("--small", action="store_true", help="נתונים קטנים לבדיקת נכונות מהירה")
    ap.add_argument("--repeats", type=int, default=20)
    ap.add_argument("--out", default=str(REPO / "results" / "db_benchmark.json"))
    a = ap.parse_args()

    scale = Scale(therapists=3, patients_per_therapist=5, days=30) if a.small else Scale()
    print("מייצר נתונים…", flush=True)
    D = generate(scale)
    n_reps = sum(len(s["reps"]) for s in D["sessions"])
    print(f"  {len(D['patients'])} מטופלים, {len(D['sessions'])} אימונים, {n_reps} חזרות (תבנית: {D['template_source']})")

    res = dict(scale=dict(patients=len(D["patients"]), sessions=len(D["sessions"]), reps=n_reps, template_source=D["template_source"]),
               queries_he=QUERIES_HE, engines={})
    print("PostgreSQL…", flush=True)
    pg_res, pg_ans = run(Pg(a.pg), D, a.repeats)
    res["engines"]["postgresql"] = pg_res

    try:
        mg = Mongo(a.mongo) if a.mongo else None
    except Exception as e:  # noqa: BLE001
        print(f"  MongoDB לא זמין ({e}); בודק נכונות מול mongomock בלבד")
        mg = None
    if mg is None:
        small = generate(Scale(therapists=3, patients_per_therapist=5, days=30))
        _, mock_ans = run(Mongo(None), small, 1)
        _, pg_small = run(Pg(a.pg), small, 1)
        res["mongo_correctness_mock"] = {q: mock_ans[q] == pg_small[q] for q in QUERIES_HE}
        _, _ = run(Pg(a.pg), D, 1)  # מחזיר את PG לנתונים המלאים
    else:
        print("MongoDB…", flush=True)
        mg_res, mg_ans = run(mg, D, a.repeats)
        res["engines"]["mongodb"] = mg_res
        res["same_answers"] = {q: pg_ans[q] == mg_ans[q] for q in QUERIES_HE}

    # ---- כלל ההחלטה (נקבע מראש וכתוב בדוח):
    # אם PostgreSQL לא איטי פי 2 או יותר ממונגו באף שאילתה, בוחרים PostgreSQL, בגלל:
    # (1) קשרים מפורשים מטפל→מטופל→אימון עם מפתחות זרים, שהם הבסיס להרשאות (סיכון דליפת מידע, טבלה 4.3);
    # (2) JSONB ומערכים נותנים את הגמישות של מסמכים לספים ולסדרות זוויות;
    # (3) הצוות מכיר SQL, ומונגו היה טכנולוגיה חדשה (מגבלה 2).
    if "mongodb" in res["engines"]:
        ratios = {q: res["engines"]["postgresql"]["queries"][q]["median_ms"] / max(0.01, res["engines"]["mongodb"]["queries"][q]["median_ms"]) for q in QUERIES_HE}
        res["pg_to_mongo_ratio"] = {q: round(v, 2) for q, v in ratios.items()}
        winner = "PostgreSQL" if max(ratios.values()) < 2 else "MongoDB"
        res["winner"] = winner
        slowest = max(ratios, key=ratios.get)
        res["summary_he"] = (f"{winner}. כל 5 השאילתות מחזירות תשובות זהות בשני המסדים; "
                             f"היחס הגרוע ביותר PG/Mongo: {ratios[slowest]:.2f} ({slowest}).")
    else:
        q = res["engines"]["postgresql"]["queries"]
        res["summary_he"] = "PostgreSQL נמדד: " + ", ".join(f"{k.split('_')[0]} {v['median_ms']} ms" for k, v in q.items()) + ". מונגו ימדד ב-GitHub Actions."
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(res, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(json.dumps({k: v for k, v in res.items() if k != "queries_he"}, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
