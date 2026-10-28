// metrics.js — ספריית מדדים. כל מדד הוא פונקציה טהורה שמקבלת נקודות שלד (ואם יש, נקודות כפות ידיים)
// ומחזירה מספר. הגדרות התרגילים (exercises.js) מתייחסות למדדים לפי שם, כך שתרגיל חדש לא דורש קוד חדש
// כל עוד המדדים שהוא צריך כבר קיימים כאן.
import { angleAt, inclinationFromVertical, pickSide, SIDES, toPx } from './geometry.js';

const deg = (r) => (r * 180) / Math.PI;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ctx = { lm: 33 נקודות שלד מנורמלות, hands: מערך ידיים (21 נקודות כל אחת) או null, w, h }
export function computeMetrics(ctx, names) {
  const P = (i) => toPx(ctx.lm[i], ctx.w, ctx.h);
  const out = {};
  const side = pickSide(ctx.lm);
  const S = SIDES[side];
  const sw = dist(P(11), P(12)) || 1; // רוחב כתפיים – לנרמול מרחקים לגודל הגוף ולמרחק מהמצלמה

  const lib = {
    // ---------- גפה תחתונה (צילום מהצד) ----------
    // כפיפת ברך במונחים קליניים: 0 = רגל ישרה, 90 = ברך כפופה בזווית ישרה
    kneeFlexion: () => 180 - angleAt(P(S.hip), P(S.knee), P(S.ankle)),
    // נטיית הגו מהאנך (ירך→כתף). "בריחה אחורה עם הישבן" מגדילה אותה
    trunkLean: () => inclinationFromVertical(P(S.hip), P(S.shoulder)),
    // הגו מול השוק (NASM): הישענות יתר כשהגו נוטה הרבה יותר מהשוק
    trunkVsTibia: () => inclinationFromVertical(P(S.hip), P(S.shoulder)) - inclinationFromVertical(P(S.ankle), P(S.knee)),
    sideVisibility: () => Math.min(...[S.shoulder, S.hip, S.knee, S.ankle].map((i) => ctx.lm[i].visibility ?? 1)),

    // ---------- כתף (צילום מקדימה) ----------
    // הרמת הזרוע: הזווית בכתף בין הגו (כתף→ירך) לזרוע (כתף→מרפק). נלקחת הזרוע המורמת יותר
    shoulderElevation: () => Math.max(angleAt(P(23), P(11), P(13)), angleAt(P(24), P(12), P(14))),
    // הטיית קו הכתפיים מהאופק. בהרמה תקינה ~0°; כשהגוף נוטה הצידה היא גדלה
    shoulderTilt: () => {
      const a = Math.abs(deg(Math.atan2(P(12).y - P(11).y, P(12).x - P(11).x)));
      return Math.min(a, 180 - a);
    },
    // נטיית הגו הצידה: הקו בין אמצע האגן לאמצע הכתפיים מול האנך
    trunkLateral: () => {
      const mh = { x: (P(23).x + P(24).x) / 2, y: (P(23).y + P(24).y) / 2 };
      const ms = { x: (P(11).x + P(12).x) / 2, y: (P(11).y + P(12).y) / 2 };
      return inclinationFromVertical(mh, ms);
    },
    upperBodyVisibility: () => Math.min(...[11, 12, 13, 14, 23, 24].map((i) => ctx.lm[i].visibility ?? 1)),

    // ---------- שורש כף יד, כפות צמודות (צילום מקדימה) ----------
    // כשהכפות צמודות וזקופות, היד אנכית, ולכן כפיפת שורש כף היד ≈ 90° פחות זווית האמה מהאופק.
    // אמה אופקית (ידיים למטה) → ~90° כפיפה לאחור. זו הערכה, בתנאי שהכפות צמודות והאצבעות למעלה.
    wristExtension: () => {
      const f = (wr, el) => deg(Math.atan2(Math.abs(P(wr).y - P(el).y), Math.abs(P(wr).x - P(el).x)));
      return 90 - (f(15, 13) + f(16, 14)) / 2;
    },
    // מרחק בין בסיסי כפות הידיים (נקודות שורש כף היד), מנורמל לרוחב הכתפיים
    palmHeelGap: () => dist(P(15), P(16)) / sw,
    // מרחק בין האצבעות (נקודות האצבע המורה במודל השלד)
    palmTipGap: () => dist(P(19), P(20)) / sw,
    // כיוון האצבעות לפי מודל כפות הידיים: 90 = למעלה, 0 = אופקי (קדימה/הצידה), שלילי = למטה.
    // כשהכפות צמודות המודל רואה לרוב "יד אחת", אבל הכיוון שלה עדיין נכון (נבדק על סרטון הפיזיותרפיסט).
    // לפעמים המודל מזהה "יד" נוספת שגויה; לכן משתמשים רק בידיים שהבסיס שלהן ליד שורשי כפות הידיים של השלד,
    // ולוקחים את הכיוון הגבוה ביותר: אם האצבעות באמת מצביעות קדימה, כל הידיים יראו זאת.
    fingerDirection: () => {
      if (!ctx.hands?.length) return NaN;
      const mid = { x: (P(15).x + P(16).x) / 2, y: (P(15).y + P(16).y) / 2 };
      const vals = ctx.hands
        .filter((hd) => dist(toPx(hd[0], ctx.w, ctx.h), mid) < 0.6 * sw)
        .map((hd) => {
          const a = toPx(hd[0], ctx.w, ctx.h), b = toPx(hd[9], ctx.w, ctx.h);
          return deg(Math.atan2(-(b.y - a.y), Math.abs(b.x - a.x)));
        });
      return vals.length ? Math.max(...vals) : NaN;
    },
    armsVisibility: () => Math.min(...[11, 12, 13, 14, 15, 16].map((i) => ctx.lm[i].visibility ?? 1)),
  };

  for (const n of names) {
    try { out[n] = lib[n] ? lib[n]() : NaN; } catch { out[n] = NaN; }
  }
  out._side = side;
  return out;
}

export const METRIC_NAMES = [
  'kneeFlexion', 'trunkLean', 'trunkVsTibia', 'sideVisibility',
  'shoulderElevation', 'shoulderTilt', 'trunkLateral', 'upperBodyVisibility',
  'wristExtension', 'palmHeelGap', 'palmTipGap', 'fingerDirection', 'armsVisibility',
];
