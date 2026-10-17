// geometry.js — חישובים ביומכניים מנקודות השלד של MediaPipe Pose (33 נקודות).
// כל הפונקציות כאן "טהורות": מקבלות נקודות ומחזירות מספרים, בלי תלות במצלמה או בדפדפן.
// אותה לוגיקה בדיוק ממומשת ב-analysis/poseitive/geometry.py כדי שהתוצאות יהיו זהות.

// אינדקסים של נקודות ציון במודל MediaPipe Pose
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

export const SIDES = {
  left: { shoulder: LM.L_SHOULDER, hip: LM.L_HIP, knee: LM.L_KNEE, ankle: LM.L_ANKLE },
  right: { shoulder: LM.R_SHOULDER, hip: LM.R_HIP, knee: LM.R_KNEE, ankle: LM.R_ANKLE },
};

// MediaPipe מחזיר קואורדינטות מנורמלות (0..1) ביחס לרוחב ולגובה.
// כדי שזווית תהיה נכונה גיאומטרית צריך להמיר לפיקסלים (אחרת וידאו 16:9 "מועך" זוויות).
export function toPx(p, width, height) {
  return { x: p.x * width, y: p.y * height, v: p.visibility ?? 1 };
}

// זווית במעלות בנקודה b, בין הקטעים b→a ו-b→c (למשל ירך–ברך–קרסול = זווית הברך).
// 180° = רגל ישרה, 90° = כפיפה של ברך בזווית ישרה.
export function angleAt(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (n === 0) return NaN;
  const cos = Math.min(1, Math.max(-1, dot / n));
  return (Math.acos(cos) * 180) / Math.PI;
}

// זווית של קטע (from→to) ביחס לאנך כלפי מעלה, במעלות (0 = זקוף לגמרי).
// בתמונה ציר y גדל כלפי מטה, ולכן "מעלה" הוא (0,-1).
export function inclinationFromVertical(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const n = Math.hypot(dx, dy);
  if (n === 0) return NaN;
  const cos = Math.min(1, Math.max(-1, -dy / n));
  return (Math.acos(cos) * 180) / Math.PI;
}

// בוחר את צד הגוף הקרוב למצלמה (בצילום מהצד): הצד שבו נקודות הירך-ברך-קרסול נראות טוב יותר.
export function pickSide(landmarks) {
  const vis = (s) => ['hip', 'knee', 'ankle', 'shoulder']
    .reduce((acc, k) => acc + (landmarks[SIDES[s][k]].visibility ?? 0), 0);
  return vis('left') >= vis('right') ? 'left' : 'right';
}

// מחשב את כל המדדים לפריים אחד.
// kneeAngle   – זווית הברך (ירך–ברך–קרסול)
// trunkAngle  – נטיית הגו מהאנך (ירך→כתף)
// tibiaAngle  – נטיית השוק מהאנך (קרסול→ברך)
// leanExcess  – כמה הגו נוטה קדימה יותר מהשוק. בסקווט תקין הגו מקביל בערך לשוק (NASM OHSA),
//               ערך חיובי גדול = הישענות יתר קדימה (תנועת פיצוי).
// minVis      – הנראות הנמוכה ביותר מבין ארבע הנקודות (לסינון פריימים לא אמינים)
export function squatMetrics(landmarks, width, height, side = null) {
  if (!landmarks || landmarks.length < 33) return null;
  const s = side || pickSide(landmarks);
  const idx = SIDES[s];
  const sh = toPx(landmarks[idx.shoulder], width, height);
  const hip = toPx(landmarks[idx.hip], width, height);
  const knee = toPx(landmarks[idx.knee], width, height);
  const ankle = toPx(landmarks[idx.ankle], width, height);
  const kneeAngle = angleAt(hip, knee, ankle);
  const trunkAngle = inclinationFromVertical(hip, sh);
  const tibiaAngle = inclinationFromVertical(ankle, knee);
  return {
    side: s,
    kneeAngle,
    trunkAngle,
    tibiaAngle,
    leanExcess: trunkAngle - tibiaAngle,
    minVis: Math.min(sh.v, hip.v, knee.v, ankle.v),
  };
}

// החלקה אקספוננציאלית פשוטה לצמצום רעש בין פריימים
export class Ema {
  constructor(alpha = 0.5) { this.alpha = alpha; this.value = null; }
  push(x) {
    if (!Number.isFinite(x)) return this.value;
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }
  reset() { this.value = null; }
}
