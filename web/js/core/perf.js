// perf.js — איסוף מדדי ביצועים: קצב פריימים, זמן עיבוד והשהיה.

export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

export class PerfRecorder {
  constructor() { this.reset(); }

  reset() {
    this.inferenceMs = [];     // זמן ריצת המודל על פריים אחד
    this.latencyMs = [];       // מרגע צילום הפריים ועד ציור המשוב על המסך
    this.frameTimes = [];      // חותמות זמן של פריימים שעובדו (לחישוב FPS)
    this.latencyKind = null;   // 'capture' = מדידה מלאה מרגע הצילום, 'frame' = מרגע שהפריים הגיע לדפדפן
    this.detected = 0;
    this.total = 0;
    this.startedAt = performance.now();
  }

  frame({ inferenceMs, latencyMs, latencyKind, detected }) {
    const now = performance.now();
    this.frameTimes.push(now);
    this.inferenceMs.push(inferenceMs);
    if (Number.isFinite(latencyMs)) this.latencyMs.push(latencyMs);
    if (latencyKind) this.latencyKind = latencyKind;
    this.total++;
    if (detected) this.detected++;
  }

  // FPS בחלון הזמן האחרון (לתצוגה חיה)
  liveFps(windowMs = 1000) {
    const now = performance.now();
    let n = 0;
    for (let i = this.frameTimes.length - 1; i >= 0 && now - this.frameTimes[i] <= windowMs; i--) n++;
    return (n * 1000) / windowMs;
  }

  summary() {
    const dur = (this.frameTimes.at(-1) - this.frameTimes[0]) / 1000;
    const fps = dur > 0 ? (this.frameTimes.length - 1) / dur : NaN;
    return {
      frames: this.total,
      durationSec: dur,
      fpsMean: fps,
      inferenceMsMedian: percentile(this.inferenceMs, 50),
      inferenceMsP95: percentile(this.inferenceMs, 95),
      latencyMsMedian: percentile(this.latencyMs, 50),
      latencyMsP95: percentile(this.latencyMs, 95),
      latencyKind: this.latencyKind,
      detectionRate: this.total ? this.detected / this.total : NaN,
    };
  }
}

// קריטריוני ההצלחה מטבלה 4.2 במסמך הייזום
export const CRITERIA = { minFps: 15, maxLatencyMs: 500 };

export function evaluate(summary) {
  return {
    fpsPass: summary.fpsMean >= CRITERIA.minFps,
    latencyPass: summary.latencyMsP95 <= CRITERIA.maxLatencyMs,
  };
}
