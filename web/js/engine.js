// engine.js — עטיפה למנוע זיהוי השלד.
// כל שאר הקוד מדבר רק עם הממשק הזה (init / detect / close) ולא עם MediaPipe ישירות.
// כך, אם יוחלט לעבור למנוע אחר (למשל YOLO-Pose), מחליפים רק את הקובץ הזה.
// (זו פעולת המנע לסיכון "שינוי או הפסקת תמיכה במנוע הזיהוי" שבטבלה 4.3.)

import { FilesetResolver, PoseLandmarker, HandLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';

const OFFICIAL_MODEL_URL = (variant) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`;
const LOCAL_MODEL_URL = (variant) => new URL(`../models/pose_landmarker_${variant}.task`, import.meta.url).href;
const WASM_BASE = new URL('../vendor/tasks-vision/wasm', import.meta.url).href;

export class PoseEngine {
  constructor() {
    this.landmarker = null;
    this.info = null;
  }

  // variant: 'lite' | 'full', delegate: 'GPU' | 'CPU'
  async init({ variant = 'lite', delegate = 'GPU' } = {}) {
    await this.close();
    const t0 = performance.now();
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const make = (modelAssetPath, dlg) => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: dlg },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    // קודם המודל המקומי שבריפו (תמיד זמין), ואם GPU לא נתמך במכשיר – נופלים ל-CPU
    const attempts = [
      ['local', LOCAL_MODEL_URL(variant), delegate],
      ...(delegate === 'GPU' ? [['local', LOCAL_MODEL_URL(variant), 'CPU']] : []),
      ['official', OFFICIAL_MODEL_URL(variant), 'CPU'],
    ];
    let usedDelegate = null, modelSource = null, lastError = null;
    for (const [src, url, dlg] of attempts) {
      try {
        this.landmarker = await make(url, dlg);
        usedDelegate = dlg; modelSource = src;
        break;
      } catch (e) { lastError = e; }
    }
    if (!this.landmarker) throw lastError;
    this.info = {
      engine: 'MediaPipe Pose Landmarker (tasks-vision 0.10.14)',
      variant,
      requestedDelegate: delegate,
      delegate: usedDelegate,
      modelSource,
      loadMs: performance.now() - t0,
    };
    return this.info;
  }

  // מחזיר { landmarks, inferenceMs } — landmarks הוא מערך של 33 נקודות או null אם לא זוהה אדם
  detect(source, timestampMs) {
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(source, timestampMs);
    const inferenceMs = performance.now() - t0;
    return { landmarks: res.landmarks?.[0] ?? null, inferenceMs };
  }

  async close() {
    if (this.landmarker) { this.landmarker.close(); this.landmarker = null; }
  }
}

// מודל כפות ידיים (21 נקודות לכל יד). נטען רק לתרגילים שמצהירים עליו (models: ['pose','hand']),
// כדי ששאר התרגילים לא ישלמו את מחיר הביצועים.
export class HandEngine {
  constructor() { this.landmarker = null; this.info = null; }

  async init({ delegate = 'GPU' } = {}) {
    if (this.landmarker) return this.info;
    const t0 = performance.now();
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const url = new URL('../models/hand_landmarker.task', import.meta.url).href;
    const make = (dlg) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: url, delegate: dlg },
      runningMode: 'VIDEO',
      numHands: 2,
      // ספים נמוכים: כשהכפות צמודות המודל פחות בטוח, ונבדק שכיוון היד עדיין נכון גם כך
      minHandDetectionConfidence: 0.3,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
    let used = delegate;
    try { this.landmarker = await make(delegate); } catch { used = 'CPU'; this.landmarker = await make('CPU'); }
    this.info = { model: 'MediaPipe Hand Landmarker', delegate: used, loadMs: performance.now() - t0 };
    return this.info;
  }

  detect(source, timestampMs) {
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(source, timestampMs);
    return { hands: res.landmarks ?? [], inferenceMs: performance.now() - t0 };
  }

  close() { if (this.landmarker) { this.landmarker.close(); this.landmarker = null; } }
}

// חיבורי השלד לציור
export const CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;
export const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;
