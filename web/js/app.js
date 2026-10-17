// app.js — ממשק ה-POC: בדיקה חיה, עיבוד סרטון ותוצאות.
import { PoseEngine, CONNECTIONS } from './engine.js';
import { squatMetrics, Ema, SIDES } from './core/geometry.js';
import { SquatRepCounter, ISSUE_TEXT } from './core/reps.js';
import { PerfRecorder, evaluate, CRITERIA } from './core/perf.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '–');

const engine = new PoseEngine();
let engineKey = null;            // המודל והמעבד שנטענו כרגע
let lastTs = 0;                  // MediaPipe דורש חותמות זמן עולות ממש בין קריאות
const nextTs = (t) => (lastTs = Math.max(lastTs + 1, Math.round(t)));

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== btn.dataset.panel; });
    if (btn.dataset.panel === 'panel-results') loadResults();
  });
});

// ------------------------------------------------------------------ engine
async function ensureEngine(statusEl) {
  const variant = $('selModel').value;
  const delegate = $('selDelegate').value;
  const key = `${variant}/${delegate}`;
  if (engineKey === key && engine.landmarker) return engine.info;
  statusEl.textContent = 'טוען את מנוע הזיהוי…';
  statusEl.classList.remove('err');
  try {
    const info = await engine.init({ variant, delegate });
    engineKey = key;
    statusEl.textContent = `המנוע נטען: מודל ${info.variant}, ${info.delegate}` +
      (info.delegate !== info.requestedDelegate ? ' (GPU לא נתמך במכשיר, עבר ל-CPU)' : '') +
      ` · ${fmt(info.loadMs)} ms`;
    return info;
  } catch (e) {
    statusEl.textContent = `טעינת המנוע נכשלה: ${e?.message || e}`;
    statusEl.classList.add('err');
    throw e;
  }
}
['selModel', 'selDelegate'].forEach((id) => $(id).addEventListener('change', () => {
  engineKey = null;
  if (live.running) ensureEngine($('engineStatus')).catch(() => {});
}));

// ------------------------------------------------------------------ drawing
function drawPose(ctx, lm, m, w, h, leanFlag) {
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  const tape = getComputedStyle(document.documentElement).getPropertyValue('--tape').trim() || '#e2557a';
  ctx.lineWidth = Math.max(2, w / 220);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  for (const { start, end } of CONNECTIONS) {
    const a = lm[start], b = lm[end];
    if ((a.visibility ?? 1) < 0.3 || (b.visibility ?? 1) < 0.3) continue;
    ctx.beginPath(); ctx.moveTo(a.x * w, a.y * h); ctx.lineTo(b.x * w, b.y * h); ctx.stroke();
  }
  if (!m) return;
  // הדגשת הקטעים שמהם מחושבות הזוויות: גו (ירך→כתף), ירך, שוק
  const s = SIDES[m.side];
  const P = (i) => [lm[i].x * w, lm[i].y * h];
  const seg = (i, j, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(...P(i)); ctx.lineTo(...P(j)); ctx.stroke();
  };
  const thick = Math.max(4, w / 110);
  seg(s.hip, s.shoulder, leanFlag ? '#ff4d4f' : tape, thick);
  seg(s.hip, s.knee, tape, thick);
  seg(s.knee, s.ankle, tape, thick);
  ctx.fillStyle = '#fff';
  for (const i of [s.shoulder, s.hip, s.knee, s.ankle]) {
    ctx.beginPath(); ctx.arc(...P(i), thick * 0.9, 0, Math.PI * 2); ctx.fill();
  }
}

// ------------------------------------------------------------------ audio feedback
let audioCtx = null;
function beep(freq = 880, ms = 140) {
  if (!$('chkSound').checked) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + ms / 1000);
  } catch { /* אין אודיו – ממשיכים בלי */ }
}
function say(text) {
  if (!$('chkSound').checked || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL'; u.rate = 1.1;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { /* לא נתמך */ }
}

// ------------------------------------------------------------------ live test
const live = {
  running: false, stream: null, counter: new SquatRepCounter(), perf: new PerfRecorder(),
  emaKnee: new Ema(0.5), emaLean: new Ema(0.5), lastWarnAt: 0,
  test: null, // { endsAt, timer }
};

$('rngLean').addEventListener('input', () => {
  $('outLean').textContent = `${$('rngLean').value}°`;
  live.counter.cfg.leanThreshold = Number($('rngLean').value);
});

$('btnStartCam').addEventListener('click', startCamera);
$('selCamera').addEventListener('change', () => { if (live.running) startCamera(); });

async function startCamera() {
  const status = $('engineStatus');
  try {
    // נדרש מגע של המשתמש כדי לאפשר אודיו בטלפון
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  } catch { /* ignore */ }
  try {
    if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
    const facing = $('selCamera').value;
    live.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    const video = $('cam');
    video.srcObject = live.stream;
    await video.play();
    $('stage').classList.toggle('mirror', facing === 'user');
    $('camPlaceholder').hidden = true;
    $('hud').hidden = false;
    await ensureEngine(status);
    $('btnTest').disabled = false;
    $('btnResetReps').disabled = false;
    if (!live.running) { live.running = true; loop(); }
  } catch (e) {
    status.textContent = e?.name === 'NotAllowedError'
      ? 'אין הרשאה למצלמה. אשרו גישה למצלמה בהגדרות הדפדפן ונסו שוב.'
      : `לא הצלחנו להפעיל את המצלמה: ${e?.message || e}`;
    status.classList.add('err');
  }
}

function loop() {
  const video = $('cam');
  const canvas = $('overlay');
  const ctx = canvas.getContext('2d');
  const hasRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  let lastVideoTime = -1;

  const onFrame = (now, meta) => {
    if (!live.running) return;
    if (!engine.landmarker) { schedule(); return; }
    // כשאין requestVideoFrameCallback מדלגים על פריים שכבר עובד
    if (!meta) {
      if (video.currentTime === lastVideoTime) { schedule(); return; }
      lastVideoTime = video.currentTime;
    }
    const frameArrived = meta ? now : performance.now();
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) { schedule(); return; }
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }

    const { landmarks, inferenceMs } = engine.detect(video, nextTs(frameArrived));
    let m = landmarks ? squatMetrics(landmarks, w, h) : null;
    if (m) {
      m = { ...m, kneeAngle: live.emaKnee.push(m.kneeAngle), leanExcess: live.emaLean.push(m.leanExcess) };
    }
    const t = performance.now();
    const rep = live.counter.push(m, t);
    const warn = live.counter.liveWarning(m);
    drawPose(ctx, landmarks, m, w, h, !!warn);
    updateHud(m, warn, rep);

    // השהיה: אם הדפדפן מספק את רגע הצילום (captureTime) – מדידה מלאה; אחרת מרגע שהפריים הגיע לדפדפן
    const drawnAt = performance.now();
    const latencyKind = meta?.captureTime ? 'capture' : 'frame';
    const latencyMs = drawnAt - (meta?.captureTime ?? frameArrived);
    live.perf.frame({ inferenceMs, latencyMs, latencyKind, detected: !!landmarks });
    schedule();
  };
  const schedule = () => (hasRvfc ? video.requestVideoFrameCallback(onFrame) : requestAnimationFrame(() => onFrame(performance.now(), null)));
  schedule();

  // עדכון נתוני הביצועים בתצוגה פעמיים בשנייה
  setInterval(() => {
    if (!live.running) return;
    const p = live.perf;
    $('hudFps').textContent = fmt(p.liveFps());
    $('hudInf').textContent = fmt(p.inferenceMs.at(-1));
    $('hudLat').textContent = fmt(p.latencyMs.at(-1));
  }, 500);
}

function updateHud(m, warn, rep) {
  $('hudKnee').textContent = m ? `${fmt(m.kneeAngle)}°` : '–';
  $('hudReps').textContent = String(live.counter.reps.length);
  const alert = $('hudAlert');
  const now = performance.now();
  if (warn) {
    alert.hidden = false; alert.className = 'alert'; alert.textContent = ISSUE_TEXT[warn];
    if (now - live.lastWarnAt > 1500) { beep(330, 220); say('גב זקוף'); live.lastWarnAt = now; }
  } else if (!alert.dataset.until || now > Number(alert.dataset.until)) {
    alert.hidden = true;
  }
  if (rep) {
    addRepToList($('repList'), rep);
    if (rep.ok) {
      alert.hidden = false; alert.className = 'alert good'; alert.textContent = `חזרה ${rep.index} ✓`;
      beep(990, 120);
    } else {
      alert.hidden = false; alert.className = 'alert'; alert.textContent = rep.issues.map((i) => ISSUE_TEXT[i]).join(' · ');
      say(rep.issues.map((i) => ISSUE_TEXT[i]).join(', '));
    }
    alert.dataset.until = String(now + 1200);
  }
}

function addRepToList(list, rep) {
  list.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  const pills = rep.ok
    ? '<span class="pill ok">תקין</span>'
    : rep.issues.map((i) => `<span class="pill bad">${ISSUE_TEXT[i]}</span>`).join(' ');
  li.innerHTML = `<span class="n">${rep.index}</span>
    <span>ברך מינ׳ <b>${fmt(rep.minKnee)}°</b></span>
    <span>גו מול שוק <b>${fmt(rep.maxLean)}°</b></span>
    <span>${fmt(rep.durationMs / 1000, 1)} שנ׳</span> ${pills}`;
  list.prepend(li);
}

$('btnResetReps').addEventListener('click', () => {
  live.counter.reset();
  $('repList').innerHTML = '<li class="empty">עוד אין חזרות. רדו לסקווט ועלו בחזרה.</li>';
  $('hudReps').textContent = '0';
});

// ---- 30-second performance test
const TEST_SEC = 30;
$('btnTest').addEventListener('click', () => {
  if (live.test) return;
  live.perf.reset();
  live.counter.reset();
  $('repList').innerHTML = '<li class="empty">הבדיקה רצה. בצעו סקווטים מול המצלמה.</li>';
  $('testCard').hidden = false;
  $('testResult').innerHTML = '';
  const bar = $('testProgress').firstElementChild;
  const start = performance.now();
  $('btnTest').disabled = true;
  live.test = setInterval(() => {
    const el = (performance.now() - start) / 1000;
    bar.style.width = `${Math.min(100, (el / TEST_SEC) * 100)}%`;
    $('btnTest').textContent = `בודק… ${Math.max(0, Math.ceil(TEST_SEC - el))} שנ׳`;
    if (el >= TEST_SEC) finishTest();
  }, 250);
});

let lastReport = null;
function deviceInfo() {
  return {
    deviceModel: $('inpDevice').value.trim() || null,
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? null,
    mobile: navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent),
    cpuCores: navigator.hardwareConcurrency ?? null,
    memoryGB: navigator.deviceMemory ?? null,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
  };
}

function finishTest() {
  clearInterval(live.test); live.test = null;
  $('btnTest').disabled = false;
  $('btnTest').textContent = 'התחל בדיקת ביצועים (30 שניות)';
  const s = live.perf.summary();
  const ev = evaluate(s);
  const video = $('cam');
  lastReport = {
    kind: 'live_performance_test',
    version: 1,
    createdAt: new Date().toISOString(),
    device: deviceInfo(),
    engine: engine.info,
    camera: { facing: $('selCamera').value, resolution: `${video.videoWidth}x${video.videoHeight}` },
    criteria: CRITERIA,
    summary: s,
    pass: ev,
    reps: live.counter.reps.map(({ series, ...r }) => r),
    leanThreshold: live.counter.cfg.leanThreshold,
  };
  renderKv($('testResult'), [
    ['מכשיר', lastReport.device.deviceModel || 'לא הוזן (מלאו "דגם המכשיר")'],
    ['מודל / מעבד', `${engine.info.variant} / ${engine.info.delegate}`],
    ['רזולוציה', lastReport.camera.resolution],
    ['קצב פריימים ממוצע', `${fmt(s.fpsMean, 1)} FPS ${badge(ev.fpsPass, `≥ ${CRITERIA.minFps}`)}`],
    ['זמן עיבוד לפריים', `חציון ${fmt(s.inferenceMsMedian, 1)} ms · P95 ${fmt(s.inferenceMsP95, 1)} ms`],
    ['השהיה (P95)', `${fmt(s.latencyMsP95)} ms ${badge(ev.latencyPass, `≤ ${CRITERIA.maxLatencyMs}`)}`],
    ['סוג מדידת השהיה', s.latencyKind === 'capture' ? 'מלאה, מרגע הצילום' : 'חלקית, מרגע שהפריים הגיע לדפדפן'],
    ['אחוז פריימים עם זיהוי', `${fmt(s.detectionRate * 100)}%`],
    ['חזרות שנספרו', String(lastReport.reps.length)],
  ]);
}

const badge = (pass, label) => `<span class="pill ${pass ? 'ok' : 'bad'}">${pass ? 'עובר' : 'לא עובר'} ${label}</span>`;
function renderKv(dl, rows) {
  dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---- export (share / copy / download)
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
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const devSlug = () => ($('inpDevice').value.trim() || 'device').replace(/[^\w-]+/g, '_');

$('btnShare').addEventListener('click', () => lastReport && shareJson(lastReport, `live_${devSlug()}_${stamp()}.json`));
$('btnDownload').addEventListener('click', () => lastReport && download(JSON.stringify(lastReport, null, 2), `live_${devSlug()}_${stamp()}.json`, 'application/json'));
$('btnCopy').addEventListener('click', async () => {
  if (!lastReport) return;
  try { await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2)); $('btnCopy').textContent = 'הועתק'; }
  catch { $('btnCopy').textContent = 'ההעתקה נחסמה, השתמשו ב"הורד"'; }
  setTimeout(() => { $('btnCopy').textContent = 'העתק'; }, 2000);
});

// ------------------------------------------------------------------ video processing on device
let vidReport = null, vidFrames = [];
$('inpVideo').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  $('videoName').textContent = file.name;
  const status = $('vidStatus');
  try { await ensureEngine(status); } catch { return; }
  processVideo(file).catch((e) => { status.textContent = `העיבוד נכשל: ${e?.message || e}`; status.classList.add('err'); });
});

async function processVideo(file) {
  const video = $('vid');
  const canvas = $('vidOverlay');
  const ctx = canvas.getContext('2d');
  const status = $('vidStatus');
  const bar = $('vidProgress').firstElementChild;
  video.src = URL.createObjectURL(file);
  await new Promise((r) => { video.onloadedmetadata = r; });
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;

  const counter = new SquatRepCounter({ leanThreshold: Number($('rngLean').value) });
  const perf = new PerfRecorder();
  const emaK = new Ema(0.5), emaL = new Ema(0.5);
  vidFrames = [];
  $('vidRepList').innerHTML = '';
  status.classList.remove('err');

  // עוברים על הסרטון פריים אחר פריים בעזרת seek, כדי שכל פריים יעובד גם במכשיר איטי.
  // זמן העיבוד שנמדד הוא זמן ריצת המודל בלבד, ולכן משקף את יכולת המעבד של המכשיר.
  const STEP = 1 / 30;
  const dur = video.duration;
  const seekTo = (t) => new Promise((resolve) => {
    // seek לאותו מיקום לא מפעיל אירוע seeked, ולכן מחכים רק כשבאמת זזים, ועם הגבלת זמן
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) { resolve(); return; }
    const timer = setTimeout(resolve, 2000);
    video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
    video.currentTime = t;
  });
  if (video.readyState < 2) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
  for (let t = 0; t < dur; t += STEP) {
    await seekTo(t);
    const w = video.videoWidth, h = video.videoHeight;
    const { landmarks, inferenceMs } = engine.detect(video, nextTs(performance.now()));
    let m = landmarks ? squatMetrics(landmarks, w, h) : null;
    if (m) m = { ...m, kneeAngle: emaK.push(m.kneeAngle), leanExcess: emaL.push(m.leanExcess) };
    const rep = counter.push(m, t * 1000);
    if (rep) addRepToList($('vidRepList'), rep);
    drawPose(ctx, landmarks, m, w, h, !!counter.liveWarning(m));
    perf.frame({ inferenceMs, latencyMs: NaN, detected: !!landmarks });
    vidFrames.push({ t: +t.toFixed(3), detected: landmarks ? 1 : 0, side: m?.side ?? '', knee: m?.kneeAngle, trunk: m?.trunkAngle, tibia: m?.tibiaAngle, lean: m?.leanExcess, vis: m?.minVis, inferenceMs });
    bar.style.width = `${(t / dur) * 100}%`;
    status.textContent = `מעבד… ${fmt((t / dur) * 100)}%`;
  }
  bar.style.width = '100%';
  const s = perf.summary();
  const maxFps = 1000 / s.inferenceMsMedian;
  vidReport = {
    kind: 'video_on_device', version: 1, createdAt: new Date().toISOString(),
    file: { name: file.name, sizeBytes: file.size, durationSec: dur, resolution: `${video.videoWidth}x${video.videoHeight}` },
    device: deviceInfo(), engine: engine.info,
    summary: { frames: s.frames, inferenceMsMedian: s.inferenceMsMedian, inferenceMsP95: s.inferenceMsP95, maxFpsFromInference: maxFps, detectionRate: s.detectionRate },
    reps: counter.reps.map(({ series, ...r }) => r),
  };
  status.textContent = `הסתיים: ${s.frames} פריימים עובדו.`;
  $('vidResultCard').hidden = false;
  renderKv($('vidResult'), [
    ['זמן עיבוד לפריים', `חציון ${fmt(s.inferenceMsMedian, 1)} ms · P95 ${fmt(s.inferenceMsP95, 1)} ms`],
    ['קצב מקסימלי אפשרי', `${fmt(maxFps, 1)} FPS ${badge(maxFps >= CRITERIA.minFps, `≥ ${CRITERIA.minFps}`)}`],
    ['אחוז פריימים עם זיהוי', `${fmt(s.detectionRate * 100)}%`],
    ['חזרות', String(counter.reps.length)],
    ['חזרות עם הישענות יתר', String(counter.reps.filter((r) => r.leanFault).length)],
  ]);
  drawChart($('kneeChart'), vidFrames, counter.cfg.leanThreshold);
}

function drawChart(canvas, frames, leanThr) {
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight || 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const padL = 36, padR = 10, padT = 10, padB = 22;
  const tMax = frames.at(-1)?.t || 1;
  const X = (t) => padL + (t / tMax) * (W - padL - padR);
  const Y = (a) => padT + (1 - (a - 0) / 190) * (H - padT - padB);
  ctx.font = '11px Assistant, sans-serif'; ctx.fillStyle = col('--muted'); ctx.strokeStyle = col('--line'); ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (const a of [0, 45, 90, 135, 180]) {
    ctx.beginPath(); ctx.moveTo(padL, Y(a)); ctx.lineTo(W - padR, Y(a)); ctx.stroke();
    ctx.fillText(`${a}°`, padL - 4, Y(a) + 4);
  }
  ctx.textAlign = 'center';
  for (let s = 0; s <= tMax; s += Math.max(1, Math.round(tMax / 8))) ctx.fillText(`${s}s`, X(s), H - 6);
  // יעד 90°
  ctx.setLineDash([5, 4]); ctx.strokeStyle = col('--muted');
  ctx.beginPath(); ctx.moveTo(padL, Y(90)); ctx.lineTo(W - padR, Y(90)); ctx.stroke(); ctx.setLineDash([]);
  const line = (key, color, f = (v) => v) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    let pen = false;
    for (const fr of frames) {
      const v = fr[key];
      if (!Number.isFinite(v)) { pen = false; continue; }
      const x = X(fr.t), y = Y(f(v));
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  };
  line('knee', col('--accent'));
  line('lean', col('--bad'), (v) => Math.max(0, v));
  ctx.setLineDash([2, 3]); ctx.strokeStyle = col('--bad');
  ctx.beginPath(); ctx.moveTo(padL, Y(leanThr)); ctx.lineTo(W - padR, Y(leanThr)); ctx.stroke(); ctx.setLineDash([]);
}

$('btnVidShare').addEventListener('click', () => vidReport && shareJson(vidReport, `video_${devSlug()}_${stamp()}.json`));
$('btnVidCsv').addEventListener('click', () => {
  if (!vidFrames.length) return;
  const cols = Object.keys(vidFrames[0]);
  const csv = [cols.join(','), ...vidFrames.map((f) => cols.map((c) => (Number.isFinite(f[c]) ? (+f[c]).toFixed(3) : f[c] ?? '')).join(','))].join('\n');
  download(csv, `frames_${stamp()}.csv`, 'text/csv');
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
