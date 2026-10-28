// exercises.js — הגדרות התרגילים. כל תרגיל הוא נתונים בלבד: איזה מדדים, איך נספרת חזרה, מה היעד, אילו טעויות
// ומה להגיד עליהן. מנוע אחד (core/exercise-engine.js) מריץ כל הגדרה. זה הבסיס ל"צ'אט" בהמשך:
// מודל שפה יפיק הגדרה בפורמט הזה מתיאור מילולי של הפיזיותרפיסט, והמטפל יאשר אותה.
//
// הספים כאן ראשוניים: נקבעו מסרטון ההדגמה של הפיזיותרפיסט (28.10.26, כל טעות הודגמה פעם אחת).
// במערכת הסופית הם ייקבעו לכל מטופל מהקלטת הייחוס שלו (ממצא ה-POC).

export const EXERCISES = {
  knee_squat: {
    name: 'סקווט עם תמיכה',
    patient: 'לאחר החלפת מפרק ברך',
    goal: 'שיפור טווח התנועה בברך',
    view: 'side',
    models: ['pose'],
    setup: 'הטלפון מהצד, בגובה המותן, 2–3 מטר. אוחזים במשהו יציב (שולחן, משענת כיסא). כל הגוף בפריים.',
    metrics: ['kneeFlexion', 'trunkLean', 'sideVisibility'],
    visibility: 'sideVisibility',
    primary: { metric: 'kneeFlexion', label: 'כפיפת ברך', unit: '°', better: 'higher', target: 110 },
    // חזרה מתחילה כשהברך מתכופפת מעבר ל-35°, ונגמרת כשהיא חוזרת מתחת ל-20°
    rep: { metric: 'kneeFlexion', enterAbove: 35, exitBelow: 20 },
    faults: [
      {
        id: 'hips_back', metric: 'trunkLean', above: 53, live: true,
        text: 'בריחה אחורה עם הישבן', say: 'כופפו ברכיים, בלי לברוח אחורה',
        note: 'בהדגמה: תקין 35°–47°, בריחה 59°–64° (נטיית גו מהאנך)',
      },
    ],
    endOfRep: [
      { id: 'shallow', when: (rep) => rep.primaryBest < rep.target, text: 'לא כופף מספיק', say: 'נסו לרדת עמוק יותר' },
    ],
  },

  shoulder_stick: {
    name: 'הרמת זרוע עם מקל',
    patient: 'לאחר שבר בכתף',
    goal: 'שיפור טווח ההרמה בכתף',
    view: 'front',
    models: ['pose'],
    setup: 'הטלפון מקדימה, 2–3 מטר. אוחזים מקל (מטאטא) בשתי הידיים. היד הבריאה דוחפת את המקל ומרימה את הזרוע הפגועה הצידה.',
    metrics: ['shoulderElevation', 'shoulderTilt', 'trunkLateral', 'upperBodyVisibility'],
    visibility: 'upperBodyVisibility',
    primary: { metric: 'shoulderElevation', label: 'הרמת זרוע', unit: '°', better: 'higher', target: 110 },
    rep: { metric: 'shoulderElevation', enterAbove: 70, exitBelow: 50 },
    faults: [
      {
        id: 'body_lean', metric: 'shoulderTilt', above: 15, live: true,
        text: 'הגוף נוטה הצידה', say: 'בלי להטות את הגוף, רק הזרוע עולה',
        note: 'בהדגמה: תקין 2°–5°, נטייה 45° (הטיית קו הכתפיים)',
      },
    ],
    endOfRep: [
      { id: 'low', when: (rep) => rep.primaryBest < rep.target, text: 'הרמה חלקית', say: 'נסו להרים קצת יותר גבוה' },
    ],
  },

  wrist_prayer: {
    name: 'כפות צמודות והורדה',
    patient: 'לאחר שבר בשורש כף היד',
    goal: 'שיפור כפיפת שורש כף היד לאחור',
    view: 'front',
    models: ['pose', 'hand'],
    setup: 'הטלפון מקדימה, 1.5–2 מטר, פלג גוף עליון בפריים. כפות ידיים צמודות מול החזה, אצבעות למעלה, ומורידים לאט כשהכפות נשארות צמודות. החזרה הראשונה היא חזרת כיול: בצעו אותה נכון.',
    metrics: ['wristExtension', 'palmHeelGap', 'palmTipGap', 'fingerDirection', 'armsVisibility'],
    robust: ['fingerDirection'],   // מודל כפות הידיים רועש כשהכפות צמודות: מסנן חציון במקום החלקה רגילה
    visibility: 'armsVisibility',
    primary: { metric: 'wristExtension', label: 'כפיפת שורש כף יד (הערכה)', unit: '°', better: 'higher', target: 75 },
    rep: { metric: 'wristExtension', enterAbove: 62, exitBelow: 52 },
    faults: [
      {
        // סף יחסי: המרחק "התקין" בין שורשי כפות הידיים שונה מאדם לאדם (מבנה גוף, מרחק מהמצלמה).
        // לכן החזרה הראשונה היא חזרת כיול: המערכת לומדת ממנה את הבסיס האישי, ומתריעה כשהמרחק עולה ביותר מ-delta מעליו.
        id: 'palms_open', metric: 'palmHeelGap', relative: { delta: 0.12, calibrateReps: 1 }, live: true, priority: 1,
        text: 'כפות הידיים נפתחות', say: 'הצמידו את כפות הידיים',
        note: 'בהדגמה: תקין 0.23–0.28, פתיחה 0.41–0.47 (ביחס לרוחב הכתפיים), כלומר עלייה של 0.15–0.2 מעל הבסיס',
      },
      {
        id: 'fingers_down', metric: 'fingerDirection', below: 60, live: true, priority: 2,
        text: 'האצבעות לא מצביעות למעלה', say: 'אצבעות כלפי מעלה',
        note: 'בהדגמה: תקין 77°–85°, אצבעות קדימה ‎-3° עד 48°',
      },
    ],
    endOfRep: [
      { id: 'not_low', when: (rep) => rep.primaryBest < rep.target, text: 'לא הורדת מספיק', say: 'נסו להוריד עוד קצת' },
    ],
  },

  free_squat: {
    name: 'סקווט חופשי (בדיקת ה-POC)',
    patient: 'בדיקה טכנית',
    goal: 'התרגיל ששימש לבדיקות ה-POC',
    view: 'side',
    models: ['pose'],
    setup: 'הטלפון מהצד, 2–3 מטר, כל הגוף בפריים.',
    metrics: ['kneeFlexion', 'trunkVsTibia', 'sideVisibility'],
    visibility: 'sideVisibility',
    primary: { metric: 'kneeFlexion', label: 'כפיפת ברך', unit: '°', better: 'higher', target: 75 },
    rep: { metric: 'kneeFlexion', enterAbove: 60, exitBelow: 20 },
    faults: [
      {
        id: 'forward_lean', metric: 'trunkVsTibia', above: 38, live: true,
        text: 'הגב נשען קדימה', say: 'גב זקוף', note: 'כויל ב-POC: תקין 17.7°–25.6°, נשען 37.6°–45.8°',
      },
    ],
    endOfRep: [
      { id: 'shallow', when: (rep) => rep.primaryBest < rep.target, text: 'לא ירדת מספיק עמוק', say: 'רדו עמוק יותר' },
    ],
  },
};
