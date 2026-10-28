// app.js — ממשק ה-POC: בחירת תרגיל, בדיקה חיה עם משוב קולי, עיבוד סרטון ותוצאות.
import { PoseEngine, HandEngine, CONNECTIONS, HAND_CONNECTIONS } from './engine.js';
import { Ema, Median } from './core/geometry.js';
import { computeMetrics } from './core/metrics.js';
import { ExerciseSession } from './core/exercise-engine.js';
import { PerfRecorder, evaluate, CRITERIA } from './core/perf.js';
import { EXERCISES } from './exercises.js';
import { Voice } from './voice.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

const DEBUG = location.hash === '#debug';
if (DEBUG) window.__dbg = [];
const pose = new PoseEngine();
const hand = new HandEngine();
const voice = new Voice();
let poseKey = null;
let lastTs = 0;                                   // MediaPipe דורש חותמות זמן עולות ממש
const nextTs = (t) => (lastTs = Math.max(lastTs + 1, Math.round(t)));

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== btn.dataset.panel; });
    if (btn.dataset.panel === 'panel-results') loadResults();
  });
});

// ------------------------------------------------------------------ exercise selection
let exId = EXERCISES[store.get('poseitive.ex')] ? store.get('poseitive.ex') : 'knee_squat';
let session = null;
let smoothers = {};
const exDef = () => EXERCISES[exId];
const mainFault = () => exDef().faults[0];

function renderPicker() {
  $('exPick').innerHTML = Object.entries(EXERCISES).map(([id, d]) =>
    `<button type="button" role="radio" aria-checked="${id === exId}" data-ex="${id}"><b>${d.name}</b><span>${d.patient}</span></button>`).join('');
  $('exPick').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => selectExercise(b.dataset.ex)));
}

function selectExercise(id) {
  exId = id; store.set('poseitive.ex', id);
  const d = exDef();
  renderPicker();
  renderKv($('exInfo'), [
    ['מטופל', d.patient], ['מטרה', d.goal],
    ['צילום', `${d.view === 'side' ? 'מהצד' : 'מקדימה'}. ${d.setup}`],
    ['המערכת תתריע על', d.faults.map((f) => f.text).join(' · ') + ' · ' + d.endOfRep.map((e) => e.text).join(' · ')],
  ]);
  $('setupText').textContent = `${d.name}: ${d.setup}`;
  $('hudPrimaryLbl').textContent = d.primary.label;
  // הסליידר שולט בסף של הטעות העיקרית
  const f = mainFault(), base = f.relative ? f.relative.delta : (f.above ?? f.below);
  const isRatio = base < 2;
  const rng = $('rngThr');
  rng.min = isRatio ? 0.1 : Math.max(0, base - 30); rng.max = isRatio ? 1 : base + 30; rng.step = isRatio ? 0.01 : 1; rng.value = base;
  $('lblThr').textContent = f.relative ? `רגישות: ${f.text} (מעל הבסיס האישי)` : `סף: ${f.text}`;
  $('outThr').textContent = isRatio ? (+base).toFixed(2) : `${base}°`;
  session = new ExerciseSession(d);
  smoothers = {};
  resetRepList($('repList'));
  $('hudReps').textContent = '0';
  if (d.models.includes('hand') && live.running) ensureHands($('engineStatus'));
}

$('rngThr').addEventListener('input', () => {
  const v = Number($('rngThr').value), f = mainFault();
  session.thresholds[f.id] = v;
  $('outThr').textContent = v < 2 ? v.toFixed(2) : `${v}°`;
});

// ------------------------------------------------------------------ voice
$('chkSound').addEventListener('change', () => { voice.enabled = $('chkSound').checked; });
function voiceStatus() {
  $('voiceStatus').textContent = !voice.supported ? 'הדפדפן לא תומך בדיבור. יושמעו צפצופים בלבד.'
    : voice.hasHebrew ? `משוב קולי בעברית פעיל (${voice.voice.name}).`
    : 'לא נמצא קול עברי במכשיר. יושמעו צפצופים. באייפון: הגדרות ← נגישות ← תוכן מוקרא ← קולות ← עברית.';
}
setTimeout(voiceStatus, 600);
$('btnVoiceTest').addEventListener('click', () => {
  voice.unlock();
  setTimeout(() => { voiceStatus(); voice.say(exDef().faults[0].say, { priority: 2, cooldownMs: 0 }); }, 150);
});

// ------------------------------------------------------------------ engines
async function ensurePose(statusEl) {
  const variant = $('selModel').value, delegate = $('selDelegate').value, key = `${variant}/${delegate}`;
  if (poseKey === key && pose.landmarker) return pose.info;
  statusEl.textContent = 'טוען את מנוע הזיהוי…'; statusEl.classList.remove('err');
  try {
    const info = await pose.init({ variant, delegate });
    poseKey = key;
    statusEl.textContent = `מנוע השלד נטען: ${info.variant}, ${info.delegate}` +
      (info.delegate !== info.requestedDelegate ? ' (GPU לא נתמך, עבר ל-CPU)' : '') + ` · ${fmt(info.loadMs)} ms`;
    return info;
  } catch (e) {
    statusEl.textContent = `טעינת המנוע נכשלה: ${e?.message || e}`; statusEl.classList.add('err'); throw e;
  }
}
async function ensureHands(statusEl) {
  if (hand.landmarker) return hand.info;
  const prev = statusEl.textContent;
  statusEl.textContent = prev + ' · טוען מודל כפות ידיים…';
  const info = await hand.init({ delegate: $('selDelegate').value });
  statusEl.textContent = prev + ` · מודל כפות ידיים נטען (${info.delegate}, ${fmt(info.loadMs)} ms)`;
  return info;
}
['selModel', 'selDelegate'].forEach((id) => $(id).addEventListener('change', () => {
  poseKey = null;
  if (live.running) ensurePose($('engineStatus')).catch(() => {});
}));

// ------------------------------------------------------------------ per-frame analysis (shared by live + video)
async function analyzeFrame(source, ts, w, h) {
  const d = exDef();
  const pr = pose.detect(source, ts);
  let inferenceMs = pr.inferenceMs, hands = null;
  if (d.models.includes('hand') && hand.landmarker) {
    const hr = hand.detect(source, ts);
    hands = hr.hands; inferenceMs += hr.inferenceMs;
  }
  let m = null;
  if (pr.landmarks) {
    m = computeMetrics({ lm: pr.landmarks, hands, w, h }, d.metrics);
    if (DEBUG) window.__dbg.push({ ts, w, h, nh: hands?.length ?? 0, raw: { ...m }, hand0: hands?.[0]?.slice(0, 10) });
    for (const k of d.metrics) {                    // החלקה קלה של כל מדד
      if (k.endsWith('Visibility')) continue;
      smoothers[k] ??= (d.robust?.includes(k) ? new Median(7) : new Ema(0.5));
      m[k] = smoothers[k].push(m[k]);
    }
  }
  return { landmarks: pr.landmarks, hands, m, inferenceMs };
}

// ------------------------------------------------------------------ drawing
function drawFrame(ctx, lm, hands, w, h, warn) {
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  const tape = getComputedStyle(document.documentElement).getPropertyValue('--tape').trim() || '#e2557a';
  ctx.lineWidth = Math.max(3, w / 160);
  ctx.strokeStyle = warn ? '#ff4d4f' : tape;
  for (const { start, end } of CONNECTIONS) {
    if (start < 11 || end < 11) continue;          // בלי נקודות הפנים
    const a = lm[start], b = lm[end];
    if ((a.visibility ?? 1) < 0.3 || (b.visibility ?? 1) < 0.3) continue;
    ctx.beginPath(); ctx.moveTo(a.x * w, a.y * h); ctx.lineTo(b.x * w, b.y * h); ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (let i = 11; i < 29; i++) {
    if ((lm[i].visibility ?? 1) < 0.3) continue;
    ctx.beginPath(); ctx.arc(lm[i].x * w, lm[i].y * h, Math.max(3, w / 200), 0, Math.PI * 2); ctx.fill();
  }
  if (hands) {
    ctx.lineWidth = Math.max(1.5, w / 400); ctx.strokeStyle = '#7fd3ff';
    for (const hd of hands) for (const { start, end } of HAND_CONNECTIONS) {
      ctx.beginPath(); ctx.moveTo(hd[start].x * w, hd[start].y * h); ctx.lineTo(hd[end].x * w, hd[end].y * h); ctx.stroke();
    }
  }
}

// ------------------------------------------------------------------ live
const live = { running: false, stream: null, perf: new PerfRecorder(), alertUntil: 0, test: null, visWarnAt: 0 };

$('btnStartCam').addEventListener('click', startCamera);
$('selCamera').addEventListener('change', () => { if (live.running) startCamera(); });

async function startCamera() {
  const status = $('engineStatus');
  voice.unlock();
  try {
    if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
    const facing = $('selCamera').value;
    live.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    const video = $('cam');
    video.srcObject = live.stream; await video.play();
    $('stage').classList.toggle('mirror', facing === 'user');
    $('camPlaceholder').hidden = true; $('hud').hidden = false;
    await ensurePose(status);
    if (exDef().models.includes('hand')) await ensureHands(status);
    $('btnTest').disabled = false; $('btnResetReps').disabled = false;
    voiceStatus();
    voice.say('מתחילים', { priority: 2, cooldownMs: 0 });
    if (!live.running) { live.running = true; loop(); }
  } catch (e) {
    status.textContent = e?.name === 'NotAllowedError' ? 'אין הרשאה למצלמה. אשרו גישה למצלמה בהגדרות הדפדפן ונסו שוב.' : `לא הצלחנו להפעיל את המצלמה: ${e?.message || e}`;
    status.classList.add('err');
  }
}

function loop() {
  const video = $('cam'), canvas = $('overlay'), ctx = canvas.getContext('2d');
  const hasRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  let lastVideoTime = -1, busy = false;
  const onFrame = async (now, meta) => {
    if (!live.running) return;
    if (busy || !pose.landmarker) { schedule(); return; }
    if (!meta) { if (video.currentTime === lastVideoTime) { schedule(); return; } lastVideoTime = video.currentTime; }
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) { schedule(); return; }
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    busy = true;
    const frameArrived = meta ? now : performance.now();
    const r = await analyzeFrame(video, nextTs(frameArrived), w, h);
    const t = performance.now();
    const ev = r.m ? session.push(r.m, t) : { liveFault: null, rep: null, lowVisibility: false };
    drawFrame(ctx, r.landmarks, r.hands, w, h, !!ev.liveFault);
    handleEvents(ev, r.m);
    const latencyKind = meta?.captureTime ? 'capture' : 'frame';
    live.perf.frame({ inferenceMs: r.inferenceMs, latencyMs: performance.now() - (meta?.captureTime ?? frameArrived), latencyKind, detected: !!r.landmarks });
    busy = false;
    schedule();
  };
  const schedule = () => (hasRvfc ? video.requestVideoFrameCallback(onFrame) : requestAnimationFrame(() => onFrame(performance.now(), null)));
  schedule();
  setInterval(() => {
    if (!live.running) return;
    $('hudFps').textContent = fmt(live.perf.liveFps());
    $('hudInf').textContent = fmt(live.perf.inferenceMs.at(-1));
    $('hudLat').textContent = fmt(live.perf.latencyMs.at(-1));
  }, 500);
}

function showAlert(text, good = false, ms = 1200) {
  const a = $('hudAlert');
  a.hidden = false; a.className = good ? 'alert good' : 'alert'; a.textContent = text;
  live.alertUntil = performance.now() + ms;
}

function handleEvents(ev, m) {
  const d = exDef(), now = performance.now();
  $('hudPrimary').textContent = m ? `${fmt(m[d.primary.metric])}${d.primary.unit}` : '–';
  $('hudReps').textContent = String(session.reps.length);
  if (ev.lowVisibility) {
    showAlert('הגוף לא נראה במלואו', false, 800);
    voice.say(d.view === 'side' ? 'התרחקו מהמצלמה, שכל הגוף ייראה' : 'עמדו מול המצלמה, שהזרועות ייראו', { priority: 1, cooldownMs: 6000 });
  } else if (session.calibrating && session.state === 'active') {
    showAlert('חזרת כיול: בצעו את התרגיל נכון', true, 400);
  } else if (ev.liveFault) {
    showAlert(ev.liveFault.text, false, 600);
    voice.say(ev.liveFault.say, { priority: 2, cooldownMs: 2500 });
  } else if (now > live.alertUntil) {
    $('hudAlert').hidden = true;
  }
  if (ev.rep) {
    const rep = ev.rep;
    addRepToList($('repList'), rep, session);
    if (rep.calibration) {
      showAlert('הכיול הסתיים ✓', true, 1500); voice.say('הכיול הסתיים', { priority: 2, cooldownMs: 0 });
    } else if (rep.ok) {
      showAlert(`חזרה ${rep.index} ✓`, true); voice.beep(990, 110); voice.count(rep.index);
    } else {
      const ids = [...rep.faults, ...rep.endIssues];
      showAlert(ids.map((i) => session.issueText(i)).join(' · '));
      // אם כבר הותרע בזמן התנועה, בסוף החזרה מספיק לספור; אחרת אומרים מה לשפר
      if (rep.endIssues.length && !rep.faults.length) voice.say(session.issueSay(rep.endIssues[0]), { priority: 1, cooldownMs: 0 });
      else voice.count(rep.index);
    }
  }
}

function resetRepList(list) { list.innerHTML = '<li class="empty">עוד אין חזרות.</li>'; }
function addRepToList(list, rep, sess) {
  list.querySelector('.empty')?.remove();
  const d = sess.def;
  const ids = [...rep.faults, ...rep.endIssues];
  const pills = rep.calibration ? '<span class="pill warn">חזרת כיול</span>' : ids.length ? ids.map((i) => `<span class="pill bad">${sess.issueText(i)}</span>`).join(' ') : '<span class="pill ok">תקין</span>';
  const dec = (f) => ((f.relative?.delta ?? f.above ?? f.below) < 2 ? 2 : 0);
  const peaks = d.faults.map((f) => `<span class="muted">${f.text}: <b>${fmt(rep.peaks[f.id], dec(f))}</b>${f.relative && Number.isFinite(rep.baselines?.[f.id]) ? ` (בסיס ${fmt(rep.baselines[f.id], dec(f))})` : ''}</span>`).join(' ');
  const li = document.createElement('li');
  li.innerHTML = `<span class="n">${rep.index}</span><span>${d.primary.label}: <b>${fmt(rep.primaryBest)}${d.primary.unit}</b></span>${peaks}<span>${fmt(rep.durationMs / 1000, 1)} שנ׳</span> ${pills}`;
  list.prepend(li);
}

$('btnResetReps').addEventListener('click', () => { session.reset(); resetRepList($('repList')); $('hudReps').textContent = '0'; });

// ---- 30-second performance test
const TEST_SEC = 30;
let lastReport = null;
$('btnTest').addEventListener('click', () => {
  if (live.test) return;
  live.perf.reset(); session.reset(); resetRepList($('repList'));
  $('testCard').hidden = false; $('testResult').innerHTML = '';
  const bar = $('testProgress').firstElementChild, start = performance.now();
  $('btnTest').disabled = true;
  live.test = setInterval(() => {
    const el = (performance.now() - start) / 1000;
    bar.style.width = `${Math.min(100, (el / TEST_SEC) * 100)}%`;
    $('btnTest').textContent = `בודק… ${Math.max(0, Math.ceil(TEST_SEC - el))} שנ׳`;
    if (el >= TEST_SEC) finishTest();
  }, 250);
});

function deviceInfo() {
  return {
    deviceModel: $('inpDevice').value.trim() || null, userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? null,
    mobile: navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent),
    cpuCores: navigator.hardwareConcurrency ?? null, memoryGB: navigator.deviceMemory ?? null,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
  };
}

function finishTest() {
  clearInterval(live.test); live.test = null;
  $('btnTest').disabled = false; $('btnTest').textContent = 'התחל בדיקת ביצועים (30 שניות)';
  const s = live.perf.summary(), ev = evaluate(s), video = $('cam');
  lastReport = {
    kind: 'live_performance_test', version: 2, createdAt: new Date().toISOString(),
    exercise: exId, models: exDef().models, device: deviceInfo(), engine: pose.info, handEngine: hand.info,
    camera: { facing: $('selCamera').value, resolution: `${video.videoWidth}x${video.videoHeight}` },
    criteria: CRITERIA, summary: s, pass: ev, thresholds: session.thresholds, reps: session.reps,
  };
  renderKv($('testResult'), [
    ['תרגיל', exDef().name],
    ['מכשיר', lastReport.device.deviceModel || 'לא הוזן (מלאו "דגם המכשיר")'],
    ['מודלים', `${exDef().models.join(' + ')} · ${pose.info.variant} / ${pose.info.delegate}`],
    ['קצב פריימים ממוצע', `${fmt(s.fpsMean, 1)} FPS ${badge(ev.fpsPass, `≥ ${CRITERIA.minFps}`)}`],
    ['זמן עיבוד לפריים', `חציון ${fmt(s.inferenceMsMedian, 1)} ms · P95 ${fmt(s.inferenceMsP95, 1)} ms`],
    ['השהיה (P95)', `${fmt(s.latencyMsP95)} ms ${badge(ev.latencyPass, `≤ ${CRITERIA.maxLatencyMs}`)}`],
    ['סוג מדידת השהיה', s.latencyKind === 'capture' ? 'מלאה, מרגע הצילום' : 'חלקית, מרגע שהפריים הגיע לדפדפן'],
    ['אחוז פריימים עם זיהוי', `${fmt(s.detectionRate * 100)}%`],
    ['חזרות', `${session.reps.length} (תקינות: ${session.reps.filter((r) => r.ok).length})`],
  ]);
}

const badge = (pass, label) => `<span class="pill ${pass ? 'ok' : 'bad'}">${pass ? 'עובר' : 'לא עובר'} ${label}</span>`;
function renderKv(dl, rows) { dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(''); }

// ---- export
async function shareJson(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  const file = new File([text], filename, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Poseitive POC' }); return; }
    if (navigator.share) { await navigator.share({ title: 'Poseitive POC', text }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  download(text, filename, 'application/json');
}
function download(text, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const devSlug = () => ($('inpDevice').value.trim() || 'device').replace(/[^\w-]+/g, '_');
$('btnShare').addEventListener('click', () => lastReport && shareJson(lastReport, `live_${exId}_${devSlug()}_${stamp()}.json`));
$('btnDownload').addEventListener('click', () => lastReport && download(JSON.stringify(lastReport, null, 2), `live_${exId}_${devSlug()}_${stamp()}.json`, 'application/json'));
$('btnCopy').addEventListener('click', async () => {
  if (!lastReport) return;
  try { await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2)); $('btnCopy').textContent = 'הועתק'; } catch { $('btnCopy').textContent = 'ההעתקה נחסמה, השתמשו ב"הורד"'; }
  setTimeout(() => { $('btnCopy').textContent = 'העתק'; }, 2000);
});

// ------------------------------------------------------------------ video processing on device
let vidReport = null, vidFrames = [];
$('inpVideo').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  $('videoName').textContent = `${file.name} · ${exDef().name}`;
  const status = $('vidStatus');
  try { await ensurePose(status); if (exDef().models.includes('hand')) await ensureHands(status); } catch { return; }
  processVideo(file).catch((e) => { status.textContent = `העיבוד נכשל: ${e?.message || e}`; status.classList.add('err'); });
});

async function processVideo(file) {
  const video = $('vid'), canvas = $('vidOverlay'), ctx = canvas.getContext('2d'), status = $('vidStatus');
  const bar = $('vidProgress').firstElementChild, d = exDef();
  video.src = URL.createObjectURL(file);
  await new Promise((r) => { video.onloadedmetadata = r; });
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const sess = new ExerciseSession(d, { ...session.thresholds });
  const perf = new PerfRecorder();
  smoothers = {}; vidFrames = [];
  $('vidRepList').innerHTML = ''; status.classList.remove('err');
  const seekTo = (t) => new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) { resolve(); return; }
    const timer = setTimeout(resolve, 2000);
    video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
    video.currentTime = t;
  });
  if (video.readyState < 2) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
  const STEP = 1 / 30, dur = video.duration;
  for (let t = 0; t < dur; t += STEP) {
    await seekTo(t);
    const w = video.videoWidth, h = video.videoHeight;
    const r = await analyzeFrame(video, nextTs(performance.now()), w, h);
    const evn = r.m ? sess.push(r.m, t * 1000) : {};
    if (evn.rep) addRepToList($('vidRepList'), evn.rep, sess);
    drawFrame(ctx, r.landmarks, r.hands, w, h, !!evn.liveFault);
    perf.frame({ inferenceMs: r.inferenceMs, latencyMs: NaN, detected: !!r.landmarks });
    const row = { t: +t.toFixed(3), detected: r.landmarks ? 1 : 0, inferenceMs: r.inferenceMs };
    for (const k of d.metrics) row[k] = r.m?.[k];
    vidFrames.push(row);
    bar.style.width = `${(t / dur) * 100}%`;
    status.textContent = `מעבד… ${fmt((t / dur) * 100)}%`;
  }
  bar.style.width = '100%';
  const s = perf.summary(), maxFps = 1000 / s.inferenceMsMedian;
  vidReport = {
    kind: 'video_on_device', version: 2, createdAt: new Date().toISOString(), exercise: exId,
    file: { name: file.name, sizeBytes: file.size, durationSec: dur, resolution: `${video.videoWidth}x${video.videoHeight}` },
    device: deviceInfo(), engine: pose.info, handEngine: hand.info,
    summary: { frames: s.frames, inferenceMsMedian: s.inferenceMsMedian, inferenceMsP95: s.inferenceMsP95, maxFpsFromInference: maxFps, detectionRate: s.detectionRate },
    thresholds: sess.thresholds, reps: sess.reps,
  };
  status.textContent = `הסתיים: ${s.frames} פריימים עובדו.`;
  $('vidResultCard').hidden = false;
  renderKv($('vidResult'), [
    ['תרגיל', d.name],
    ['זמן עיבוד לפריים', `חציון ${fmt(s.inferenceMsMedian, 1)} ms · P95 ${fmt(s.inferenceMsP95, 1)} ms`],
    ['קצב מקסימלי אפשרי', `${fmt(maxFps, 1)} FPS ${badge(maxFps >= CRITERIA.minFps, `≥ ${CRITERIA.minFps}`)}`],
    ['אחוז פריימים עם זיהוי', `${fmt(s.detectionRate * 100)}%`],
    ['חזרות', `${sess.reps.length} (תקינות: ${sess.reps.filter((r) => r.ok).length})`],
    ...d.faults.map((f) => [f.text, `${sess.reps.filter((r) => r.faults.includes(f.id)).length} חזרות`]),
  ]);
  drawChart($('kneeChart'), vidFrames, d, sess);
}

function drawChart(canvas, frames, d, sess) {
  const css = getComputedStyle(document.documentElement), col = (n) => css.getPropertyValue(n).trim();
  const dpr = devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight || 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  const padL = 36, padR = 10, padT = 10, padB = 22, tMax = frames.at(-1)?.t || 1;
  const X = (t) => padL + (t / tMax) * (W - padL - padR);
  const Y = (a) => padT + (1 - Math.max(0, Math.min(180, a)) / 180) * (H - padT - padB);
  ctx.font = '11px Assistant, sans-serif'; ctx.fillStyle = col('--muted'); ctx.strokeStyle = col('--line'); ctx.lineWidth = 1; ctx.textAlign = 'right';
  for (const a of [0, 45, 90, 135, 180]) { ctx.beginPath(); ctx.moveTo(padL, Y(a)); ctx.lineTo(W - padR, Y(a)); ctx.stroke(); ctx.fillText(`${a}°`, padL - 4, Y(a) + 4); }
  ctx.textAlign = 'center';
  for (let s = 0; s <= tMax; s += Math.max(1, Math.round(tMax / 8))) ctx.fillText(`${s}s`, X(s), H - 6);
  const line = (key, color, scale = 1) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); let pen = false;
    for (const fr of frames) { const v = fr[key]; if (!Number.isFinite(v)) { pen = false; continue; } const x = X(fr.t), y = Y(v * scale); if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true; }
    ctx.stroke();
  };
  const dash = (v, color) => { ctx.setLineDash([4, 4]); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke(); ctx.setLineDash([]); };
  line(d.primary.metric, col('--accent')); dash(d.primary.target, col('--muted'));
  const f = d.faults[0], scale = (f.relative?.delta ?? f.above ?? f.below) < 2 ? 100 : 1;   // יחסים מוצגים ×100
  line(f.metric, col('--bad'), scale);
  const thr = sess.effectiveThreshold(f); if (thr !== null) dash(thr * scale, col('--bad'));
  $('chartLegend').innerHTML = `<span class="sw knee"></span>${d.primary.label} <span class="sw target"></span>יעד ${d.primary.target}° <span class="sw lean"></span>${f.text}${scale > 1 ? ' (×100)' : ''}`;
}

$('btnVidShare').addEventListener('click', () => vidReport && shareJson(vidReport, `video_${exId}_${devSlug()}_${stamp()}.json`));
$('btnVidCsv').addEventListener('click', () => {
  if (!vidFrames.length) return;
  const cols = Object.keys(vidFrames[0]);
  const csv = [cols.join(','), ...vidFrames.map((f) => cols.map((c) => (Number.isFinite(f[c]) ? (+f[c]).toFixed(3) : f[c] ?? '')).join(','))].join('\n');
  download(csv, `frames_${exId}_${stamp()}.csv`, 'text/csv');
});

// ------------------------------------------------------------------ results tab
const STATUS_TEXT = { pass: ['עבר', 'ok'], fail: ['לא עבר', 'bad'], partial: ['חלקי', 'warn'], pending: ['ממתין לנתונים', 'pending'], open: ['פתוח – שלב הבא', 'pending'] };
let resultsLoaded = false;
async function loadResults() {
  if (resultsLoaded) return;
  const tbody = $('resultsTable').querySelector('tbody');
  try {
    const res = await fetch('results/summary.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    $('resultsUpdated').textContent = `עודכן: ${new Date(data.updatedAt).toLocaleString('he-IL')}`;
    tbody.innerHTML = data.items.map((it) => {
      const [txt, cls] = STATUS_TEXT[it.status] || [it.status, 'pending'];
      return `<tr><td><b>${it.title}</b></td><td>${it.criterion}</td><td>${it.result ?? '–'}</td><td><span class="pill ${cls}">${txt}</span></td><td>${it.decision ?? '–'}</td></tr>`;
    }).join('');
    resultsLoaded = true;
  } catch {
    $('resultsUpdated').textContent = 'קובץ התוצאות עוד לא קיים. הוא נוצר אחרי הרצת סקריפטי הניתוח (analysis/).';
  }
}

// ------------------------------------------------------------------ boot
selectExercise(exId);
