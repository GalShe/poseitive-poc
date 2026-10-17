-- Poseitive: סכמה רלציונית (PostgreSQL)
-- ישויות: פיזיותרפיסט → מטופלים → תוכנית אימון (תרגילים + ספים) → אימונים → חזרות.
-- סדרת הזוויות של כל חזרה נשמרת כמערך (REAL[]) באותה שורה, ולא כשורה לכל פריים,
-- כי ממשק המטפל מציג גרף של חזרה שלמה ולא שואל על פריימים בודדים.

DROP TABLE IF EXISTS reps, sessions, reference_recordings, plan_items, exercises, patients, therapists CASCADE;

CREATE TABLE therapists (
  id          SERIAL PRIMARY KEY,
  full_name   TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id            SERIAL PRIMARY KEY,
  therapist_id  INT NOT NULL REFERENCES therapists(id),   -- הרשאה: מטפל רואה רק את המטופלים שלו
  full_name     TEXT NOT NULL,
  birth_year    INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON patients(therapist_id);

CREATE TABLE exercises (
  id        SERIAL PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,            -- 'squat'
  name_he   TEXT NOT NULL,
  view      TEXT NOT NULL CHECK (view IN ('side', 'front'))
);

-- תרגיל בתוכנית של מטופל מסוים, עם הספים שהמטפל הגדיר לו
CREATE TABLE plan_items (
  id               SERIAL PRIMARY KEY,
  patient_id       INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  exercise_id      INT NOT NULL REFERENCES exercises(id),
  target_reps      INT NOT NULL,
  target_sets      INT NOT NULL,
  sessions_per_week INT NOT NULL DEFAULT 5,
  thresholds       JSONB NOT NULL,           -- {"target_depth":90,"lean_threshold":20,...} — גמיש לכל תרגיל
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON plan_items(patient_id);

CREATE TABLE reference_recordings (
  id            SERIAL PRIMARY KEY,
  plan_item_id  INT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  knee_series   REAL[] NOT NULL,             -- רצף הזוויות של ביצוע הייחוס (אחרי דגימה מחדש)
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            BIGSERIAL PRIMARY KEY,
  patient_id    INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  plan_item_id  INT NOT NULL REFERENCES plan_items(id),
  started_at    TIMESTAMPTZ NOT NULL,
  duration_sec  REAL NOT NULL,
  device        TEXT,
  pain_reported BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ON sessions(patient_id, started_at DESC);

CREATE TABLE reps (
  session_id    BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  rep_index     INT NOT NULL,
  set_index     INT NOT NULL,
  duration_sec  REAL NOT NULL,
  min_knee      REAL NOT NULL,
  max_lean      REAL NOT NULL,
  dtw_distance  REAL,
  deep_enough   BOOLEAN NOT NULL,
  lean_fault    BOOLEAN NOT NULL,
  knee_series   REAL[] NOT NULL,
  PRIMARY KEY (session_id, set_index, rep_index)
);
