// reps.js — ספירת חזרות סקווט ומשוב לכל חזרה.
// מכונת מצבים עם היסטרזיס: "עומד" כשהברך כמעט ישרה, "למטה" כשהברך כפופה.
// ההיסטרזיס (שני ספים שונים) מונע ספירה כפולה כשהזווית רועדת סביב סף אחד.

export const DEFAULT_SQUAT_CONFIG = {
  upAngle: 160,          // מעל זה = עמידה
  downAngle: 120,        // מתחת לזה = בתוך הסקווט
  targetDepth: 90,       // עומק היעד (ברך ב-90°)
  depthTolerance: 15,    // חזרה "עמוקה מספיק" אם הזווית המזערית ≤ 90+15
  leanThreshold: 20,     // הישענות יתר: הגו נוטה קדימה ביותר מ-20° מהשוק (סף ראשוני, יאושר מול פיזיותרפיסט)
  minVisibility: 0.5,    // פריים עם נראות נמוכה מזה לא נספר
};

export class SquatRepCounter {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_SQUAT_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.state = 'up';
    this.reps = [];
    this.current = null;
  }

  // m: התוצאה של squatMetrics (אחרי החלקה), t: זמן במילישניות
  // מחזיר אירוע כשחזרה מסתיימת, אחרת null
  push(m, t) {
    if (!m || m.minVis < this.cfg.minVisibility || !Number.isFinite(m.kneeAngle)) return null;
    const { upAngle, downAngle } = this.cfg;

    if (this.state === 'up' && m.kneeAngle < downAngle) {
      this.state = 'down';
      this.current = { start: t, minKnee: m.kneeAngle, maxLean: m.leanExcess, series: [] };
    }

    if (this.state === 'down') {
      const c = this.current;
      c.minKnee = Math.min(c.minKnee, m.kneeAngle);
      if (Number.isFinite(m.leanExcess)) c.maxLean = Math.max(c.maxLean, m.leanExcess);
      c.series.push({ t, knee: m.kneeAngle, trunk: m.trunkAngle, tibia: m.tibiaAngle });

      if (m.kneeAngle > upAngle) {
        this.state = 'up';
        const rep = this.finishRep(c, t);
        this.reps.push(rep);
        this.current = null;
        return rep;
      }
    }
    return null;
  }

  finishRep(c, t) {
    const { targetDepth, depthTolerance, leanThreshold } = this.cfg;
    const deepEnough = c.minKnee <= targetDepth + depthTolerance;
    const leanFault = c.maxLean > leanThreshold;
    const issues = [];
    if (!deepEnough) issues.push('shallow');
    if (leanFault) issues.push('forward_lean');
    return {
      index: this.reps.length + 1,
      durationMs: t - c.start,
      minKnee: c.minKnee,
      maxLean: c.maxLean,
      deepEnough,
      leanFault,
      ok: issues.length === 0,
      issues,
      series: c.series,
    };
  }

  // בדיקה רציפה בזמן התנועה (שכבת המשוב המיידית, כמתואר בפרק סקר הספרות):
  // מחזיר אזהרה אם ברגע זה יש הישענות יתר.
  liveWarning(m) {
    if (!m || this.state !== 'down') return null;
    if (m.leanExcess > this.cfg.leanThreshold) return 'forward_lean';
    return null;
  }
}

export const ISSUE_TEXT = {
  shallow: 'לא ירדת מספיק עמוק',
  forward_lean: 'הגב נשען קדימה',
};
