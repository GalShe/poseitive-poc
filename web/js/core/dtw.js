// dtw.js — Dynamic Time Warping להשוואת חזרה של מטופל לחזרת ייחוס.
// DTW מיישר שני רצפים גם אם בוצעו בקצב שונה, כך שמטופל שמתרגל לאט יותר לא "נענש".
// הרצפים כאן הם רצפי זוויות (למשל זווית הברך לאורך החזרה).

export function dtwDistance(a, b, window = null) {
  const n = a.length, m = b.length;
  if (!n || !m) return NaN;
  const w = window ?? Math.max(n, m);
  const INF = Number.POSITIVE_INFINITY;
  let prev = new Float64Array(m + 1).fill(INF);
  let cur = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(INF);
    const jStart = Math.max(1, i - w), jEnd = Math.min(m, i + w);
    for (let j = jStart; j <= jEnd; j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      cur[j] = cost + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  // נרמול לפי אורך המסלול כדי שחזרות ארוכות לא יקבלו מרחק גדול רק בגלל האורך
  return prev[m] / (n + m);
}

// דגימה מחדש לאורך קבוע — שימושי לבניית ייחוס ממוצע מכמה הקלטות
export function resample(series, len = 100) {
  if (series.length === 0) return [];
  if (series.length === 1) return new Array(len).fill(series[0]);
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const pos = (i * (series.length - 1)) / (len - 1);
    const lo = Math.floor(pos), hi = Math.min(series.length - 1, lo + 1);
    const f = pos - lo;
    out[i] = series[lo] * (1 - f) + series[hi] * f;
  }
  return out;
}

export function averageReference(seriesList, len = 100) {
  const rs = seriesList.map((s) => resample(s, len));
  return rs[0].map((_, i) => rs.reduce((acc, r) => acc + r[i], 0) / rs.length);
}
