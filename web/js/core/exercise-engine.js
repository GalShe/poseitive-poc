// exercise-engine.js — מנוע אחד שמריץ כל הגדרת תרגיל (exercises.js).
// מקבל בכל פריים את ערכי המדדים, ומחזיר אירועים: טעות בזמן אמת, חזרה שהסתיימה, בעיית נראות.

export class ExerciseSession {
  constructor(def, overrides = {}) {
    this.def = def;
    this.thresholds = {};               // ספים שהמשתמש שינה (למשל בסליידר)
    for (const f of def.faults) this.thresholds[f.id] = overrides[f.id] ?? (f.above ?? f.below);
    this.reset();
  }

  reset() {
    this.state = 'rest';
    this.reps = [];
    this.cur = null;
    this.faultFrames = {};              // מתי התחילה כל טעות שמתקיימת כרגע (מניעת התרעות מהבהבות)
    this.lowVisFrames = 0;
  }

  // ערך הסף הנוכחי של טעות
  threshold(f) { return this.thresholds[f.id]; }

  isFaulty(f, v) {
    if (!Number.isFinite(v)) return false;
    const thr = this.threshold(f);
    return f.above !== undefined ? v > thr : v < thr;
  }

  // m: { metricName: value }, t: ms. מחזיר { liveFault, rep, lowVisibility }
  push(m, t) {
    const d = this.def;
    const out = { liveFault: null, rep: null, lowVisibility: false };
    const vis = m[d.visibility];
    if (!Number.isFinite(vis) || vis < 0.5) {
      this.lowVisFrames++;
      out.lowVisibility = this.lowVisFrames > 20;   // ~0.7 שנייה ברצף
      return out;
    }
    this.lowVisFrames = 0;

    const v = m[d.rep.metric];
    if (!Number.isFinite(v)) return out;

    if (this.state === 'rest' && v > d.rep.enterAbove) {
      this.state = 'active';
      this.cur = { start: t, best: v, faults: {}, peaks: {} };
    }

    if (this.state === 'active') {
      const c = this.cur;
      const pv = m[d.primary.metric];
      if (Number.isFinite(pv)) c.best = d.primary.better === 'higher' ? Math.max(c.best, pv) : Math.min(c.best, pv);

      // בדיקת טעויות בזמן אמת, עם דרישה ל-5 פריימים רצופים כדי לא להתריע על רעש
      let worst = null;
      for (const f of d.faults) {
        const fv = m[f.metric];
        if (Number.isFinite(fv)) c.peaks[f.id] = f.above !== undefined ? Math.max(c.peaks[f.id] ?? -Infinity, fv) : Math.min(c.peaks[f.id] ?? Infinity, fv);
        if (this.isFaulty(f, fv)) {
          // הטעות חייבת להימשך לפחות 300ms ברצף (לפי זמן ולא לפי מספר פריימים, כדי שיתנהג אותו דבר בכל קצב פריימים)
          this.faultFrames[f.id] ??= t;
          if (t - this.faultFrames[f.id] >= (f.minMs ?? 300)) {
            c.faults[f.id] = true;
            if (f.live && (!worst || (f.priority ?? 0) > (worst.priority ?? 0))) worst = f;
          }
        } else {
          delete this.faultFrames[f.id];
        }
      }
      out.liveFault = worst;

      if (v < d.rep.exitBelow) {
        this.state = 'rest';
        // תנועה קצרה מדי (רעש או תזוזה) לא נחשבת חזרה
        if (t - c.start < (d.rep.minDurationMs ?? 600)) { this.cur = null; this.faultFrames = {}; return out; }
        const rep = {
          index: this.reps.length + 1,
          durationMs: t - c.start,
          primaryBest: c.best,
          target: d.primary.target,
          faults: d.faults.filter((f) => c.faults[f.id]).map((f) => f.id),
          peaks: c.peaks,
        };
        rep.endIssues = d.endOfRep.filter((e) => e.when(rep)).map((e) => e.id);
        rep.ok = rep.faults.length === 0 && rep.endIssues.length === 0;
        this.reps.push(rep);
        this.cur = null;
        this.faultFrames = {};
        out.rep = rep;
      }
    }
    return out;
  }

  // טקסט לכל מזהה טעות (מהטעויות בזמן אמת ומבדיקות סוף החזרה)
  issueText(id) {
    return (this.def.faults.find((f) => f.id === id) ?? this.def.endOfRep.find((e) => e.id === id))?.text ?? id;
  }
  issueSay(id) {
    return (this.def.faults.find((f) => f.id === id) ?? this.def.endOfRep.find((e) => e.id === id))?.say ?? '';
  }
}
