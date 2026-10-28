// exercise-engine.js — מנוע אחד שמריץ כל הגדרת תרגיל (exercises.js).
// מקבל בכל פריים את ערכי המדדים, ומחזיר אירועים: טעות בזמן אמת, חזרה שהסתיימה, בעיית נראות.

export class ExerciseSession {
  constructor(def, overrides = {}) {
    this.def = def;
    this.thresholds = {};               // ספים שהמשתמש שינה (למשל בסליידר)
    for (const f of def.faults) this.thresholds[f.id] = overrides[f.id] ?? (f.relative ? f.relative.delta : (f.above ?? f.below));
    this.reset();
  }

  reset() {
    this.state = 'rest';
    this.reps = [];
    this.cur = null;
    this.faultFrames = {};              // מתי התחילה כל טעות שמתקיימת כרגע (מניעת התרעות מהבהבות)
    this.lowVisFrames = 0;
    this.baselines = {};                // לטעויות עם סף יחסי: ערך הבסיס האישי שנלמד מתחילת כל חזרה
  }

  // סף אפקטיבי: מוחלט, או בסיס אישי + delta. null = עוד אין בסיס (חזרת הכיול טרם הסתיימה)
  effectiveThreshold(f) {
    if (!f.relative) return this.thresholds[f.id];
    const base = this.baselines[f.id]?.base;
    return Number.isFinite(base) ? base + this.thresholds[f.id] : null;
  }

  // האם החזרה הנוכחית היא חזרת כיול (לומדים ממנה את הבסיס האישי ולא מתריעים)
  get calibrating() {
    const n = Math.max(0, ...this.def.faults.map((f) => f.relative?.calibrateReps ?? 0));
    return this.reps.length < n;
  }

  // ערך הסף הנוכחי של טעות
  threshold(f) { return this.thresholds[f.id]; }

  isFaulty(f, v) {
    if (!Number.isFinite(v)) return false;
    const thr = this.effectiveThreshold(f);
    if (thr === null) return false;
    return f.below !== undefined ? v < thr : v > thr;
  }

  // בחזרות הכיול אוספים את ערכי המדד לאורך כל החזרה; בסופן הבסיס = אחוזון 80
  learnBaseline(m) {
    if (!this.calibrating) return;
    for (const f of this.def.faults) {
      if (!f.relative) continue;
      const b = (this.baselines[f.id] ??= { samples: [], base: NaN });
      if (Number.isFinite(m[f.metric])) b.samples.push(m[f.metric]);
    }
  }
  closeBaselines(wasCalibrating) {
    for (const b of Object.values(this.baselines)) {
      if (wasCalibrating && b.samples.length) {
        // אחוזון 80: הערך האופייני ל"סגור" גם בתנוחה הנמוכה, שם המרחק טבעית מעט גדול יותר
        const s = [...b.samples].sort((x, y) => x - y);
        b.base = s[Math.floor(0.8 * (s.length - 1))];
      }
      if (!wasCalibrating) b.samples = [];
    }
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
      this.learnBaseline(m);
      const pv = m[d.primary.metric];
      if (Number.isFinite(pv)) c.best = d.primary.better === 'higher' ? Math.max(c.best, pv) : Math.min(c.best, pv);

      // בדיקת טעויות בזמן אמת, עם דרישה ל-5 פריימים רצופים כדי לא להתריע על רעש
      let worst = null;
      for (const f of d.faults) {
        const fv = m[f.metric];
        if (Number.isFinite(fv)) c.peaks[f.id] = f.below === undefined ? Math.max(c.peaks[f.id] ?? -Infinity, fv) : Math.min(c.peaks[f.id] ?? Infinity, fv);
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
        if (t - c.start < (d.rep.minDurationMs ?? 600)) { this.cur = null; this.faultFrames = {}; if (this.calibrating) for (const b of Object.values(this.baselines)) b.samples = []; return out; }
        const rep = {
          index: this.reps.length + 1,
          durationMs: t - c.start,
          primaryBest: c.best,
          target: d.primary.target,
          faults: d.faults.filter((f) => c.faults[f.id]).map((f) => f.id),
          peaks: c.peaks,
        };
        const wasCalibrating = this.calibrating;
        this.closeBaselines(wasCalibrating);
        rep.calibration = wasCalibrating;
        rep.baselines = Object.fromEntries(Object.entries(this.baselines).map(([k, b]) => [k, b.base]));
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
