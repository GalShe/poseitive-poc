// מריץ את מנוע התרגילים (אותו קוד שרץ בטלפון) על נקודות שלד שחולצו מסרטון, ומדפיס את החזרות והטעויות.
// שימוש: node web/tests/replay.mjs <frames.json> <exerciseId> <fromSec> <toSec>
import { readFileSync } from 'node:fs';
import { computeMetrics } from '../js/core/metrics.js';
import { ExerciseSession } from '../js/core/exercise-engine.js';
import { Ema, Median } from '../js/core/geometry.js';
import { EXERCISES } from '../js/exercises.js';

export function replay(frames, exId, from = 0, to = Infinity) {
  const d = EXERCISES[exId], s = new ExerciseSession(d), sm = {}, live = [];
  for (const f of frames) {
    if (f.t < from || f.t >= to || !f.lm) continue;
    const m = computeMetrics({ lm: f.lm, hands: d.models.includes('hand') ? f.hands : null, w: f.w, h: f.h }, d.metrics);
    for (const k of d.metrics) { if (k.endsWith('Visibility')) continue; sm[k] ??= (d.robust?.includes(k) ? new Median(7) : new Ema(0.5)); m[k] = sm[k].push(m[k]); }
    const ev = s.push(m, f.t * 1000);
    if (ev.liveFault && live.at(-1)?.id !== ev.liveFault.id) live.push({ t: f.t, id: ev.liveFault.id });
    if (!ev.liveFault && live.length && live.at(-1).id !== null) live.push({ t: f.t, id: null });
  }
  return { reps: s.reps, live: live.filter((x) => x.id) };
}

if (process.argv[1].endsWith('replay.mjs') && process.argv[2]) {
  const [file, ex, a, b] = process.argv.slice(2);
  const { reps, live } = replay(JSON.parse(readFileSync(file, 'utf8')), ex, +a || 0, +b || Infinity);
  for (const r of reps) console.log(`rep ${r.index} t=${(r.durationMs / 1000).toFixed(1)}s best=${r.primaryBest.toFixed(0)} faults=[${r.faults}] end=[${r.endIssues}] peaks=${JSON.stringify(Object.fromEntries(Object.entries(r.peaks).map(([k, v]) => [k, +v.toFixed(2)])))}`);
  console.log('live alerts at:', live.map((x) => `${x.t.toFixed(1)}s ${x.id}`).join(', ') || 'none');
}
