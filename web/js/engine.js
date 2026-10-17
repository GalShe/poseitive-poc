// engine.js — עטיפה למנוע זיהוי השלד.
// כל שאר הקוד מדבר רק עם הממשק הזה (init / detect / close) ולא עם MediaPipe ישירות.
// כך, אם יוחלט לעבור למנוע אחר (למשל YOLO-Pose), מחליפים רק את הקובץ הזה.
// (זו פעולת המנע לסיכון "שינוי או הפסקת תמיכה במנוע הזיהוי" שבטבלה 4.3.)

import { FilesetResolver, PoseLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';

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

// חיבורי השלד לציור
export const CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;
