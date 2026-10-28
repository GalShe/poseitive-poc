// בדיקות יחידה ללוגיקת הדפדפן (Node 18+):  node web/tests/core.test.mjs
import assert from 'node:assert/strict';
import { angleAt, inclinationFromVertical, squatMetrics } from '../js/core/geometry.js';
import { SquatRepCounter } from '../js/core/reps.js';
import { dtwDistance } from '../js/core/dtw.js';

function stick(knee, trunk, tibia = 25) {
  const r = (d) => (d * Math.PI) / 180;
  const ankle = [500, 900], shin = 220, thigh = 230, torso = 300;
  const kneeP = [ankle[0] + shin * Math.sin(r(tibia)), ankle[1] - shin * Math.cos(r(tibia))];
  const u = [(kneeP[0] - ankle[0]) / shin, (kneeP[1] - ankle[1]) / shin];
  const phi = r(180 - knee);
  const d = [Math.cos(phi) * u[0] + Math.sin(phi) * u[1], -Math.sin(phi) * u[0] + Math.cos(phi) * u[1]];
  const hip = [kneeP[0] + thigh * d[0], kneeP[1] + thigh * d[1]];
  const sh = [hip[0] + torso * Math.sin(r(trunk)), hip[1] - torso * Math.cos(r(trunk))];
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.1 }));
  [[11, sh], [23, hip], [25, kneeP], [27, ankle]].forEach(([i, p]) => { lm[i] = { x: p[0] / 1000, y: p[1] / 1000, visibility: 0.99 }; });
  return lm;
}

assert.ok(Math.abs(angleAt({ x: 0, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 0 }) - 90) < 1e-9);
assert.ok(Math.abs(inclinationFromVertical({ x: 0, y: 0 }, { x: 1, y: -1 }) - 45) < 1e-9);
for (const [k, t] of [[90, 25], [120, 40], [95, 60]]) {
  const m = squatMetrics(stick(k, t), 1000, 1000);
  assert.ok(Math.abs(m.kneeAngle - k) < 0.5 && Math.abs(m.leanExcess - (t - 25)) < 0.5, `${k}/${t}`);
}
const c = new SquatRepCounter();
let t = 0;
for (let rep = 0; rep < 3; rep++) for (const k of [175, 150, 120, 100, 90, 90, 100, 130, 165, 175]) c.push({ kneeAngle: k, leanExcess: k < 110 ? 45 : 0, trunkAngle: 0, tibiaAngle: 0, minVis: 0.9 }, (t += 100));
assert.equal(c.reps.length, 3);
assert.ok(c.reps.every((r) => r.leanFault && r.deepEnough));
const a = Array.from({ length: 60 }, (_, i) => 130 + 45 * Math.cos((2 * Math.PI * i) / 59));
const b = Array.from({ length: 120 }, (_, i) => 130 + 45 * Math.cos((2 * Math.PI * i) / 119));
assert.ok(dtwDistance(a, b) < 1);
console.log('web core tests: all passed');

// ---- מנוע התרגילים: הגדרה + סדרת מדדים סינתטית
import { ExerciseSession } from '../js/core/exercise-engine.js';
import { EXERCISES } from '../js/exercises.js';
{
  const s = new ExerciseSession(EXERCISES.shoulder_stick);
  let tt = 0, reps = [];
  const series = (lean) => [30, 60, 90, 120, 135, 135, 135, 120, 90, 60, 40, 30].map((e) => ({ shoulderElevation: e, shoulderTilt: e > 100 ? lean : 2, trunkLateral: 2, upperBodyVisibility: 0.9 }));
  for (const lean of [3, 40, 3]) for (const m of series(lean)) for (let k = 0; k < 6; k++) { const ev = s.push(m, (tt += 33)); if (ev.rep) reps.push(ev.rep); }
  assert.equal(reps.length, 3);
  assert.deepEqual(reps.map((r) => r.ok), [true, false, true]);
  assert.deepEqual(reps[1].faults, ['body_lean']);
  // רעש קצר לא נספר כחזרה
  const s2 = new ExerciseSession(EXERCISES.shoulder_stick);
  for (const e of [30, 80, 30]) s2.push({ shoulderElevation: e, shoulderTilt: 2, upperBodyVisibility: 0.9 }, (tt += 33));
  assert.equal(s2.reps.length, 0);
  console.log('exercise engine tests: all passed');
}
