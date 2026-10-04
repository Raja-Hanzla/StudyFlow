// Backup format: building, validating and preparing a StudyFlow JSON backup.
// No Supabase and no page code in here, so it can be tested with Node.
import { DIFFICULTIES, PRIORITIES, WEEKDAYS } from "./constants.js";

export const BACKUP_VERSION = 1;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 200000;
const MAX_SHOWN_ERRORS = 12;

// ---------- Export ----------
const withoutUser = (row) => {
  if (!row) return null;
  const { user_id, ...rest } = row; // the file never contains your user id
  return rest;
};

export function buildBackup(raw, exportedAt) {
  const { id, ...profile } = raw.profile ?? {};
  return {
    app: "StudyFlow",
    version: BACKUP_VERSION,
    exportedAt,
    data: {
      profile: raw.profile ? profile : null,
      settings: withoutUser(raw.settings),
      subjects: raw.subjects.map(withoutUser),
      exams: raw.exams.map(withoutUser),
      chapters: raw.chapters.map(withoutUser),
      topics: raw.topics.map(withoutUser),
      tasks: raw.tasks.map(withoutUser),
      recallHistory: raw.recallHistory.map(withoutUser),
      studySessions: raw.studySessions.map(withoutUser),
    },
  };
}

// ---------- Validation ----------
const isStr = (v) => typeof v === "string";
const isId = (v) => isStr(v) && v.length > 0 && v.length <= 100;
const isName = (v) => isStr(v) && v.trim() !== "" && v.length <= 300;
const isColor = (v) => isStr(v) && /^#[0-9a-fA-F]{6}$/.test(v);
const isDay = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10)));
const isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));
const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const oneOf = (list) => (v) => list.includes(v);

// need = must be present and valid. may = may be missing/null, but if present must be valid.
const SCHEMAS = {
  subjects: { label: "Subject", need: { id: isId, name: isName }, may: { color: isColor, daily_minutes: int(5, 720), topics_per_day: int(1, 20), created_at: isTime } },
  exams: { label: "Exam", need: { id: isId, subject_id: isId, name: isName, exam_date: isDay }, may: { created_at: isTime } },
  chapters: { label: "Chapter", need: { id: isId, subject_id: isId, name: isName }, may: { chapter_number: int(0, 100000), created_at: isTime } },
  topics: { label: "Topic",
    need: { id: isId, chapter_id: isId, name: isName, difficulty: oneOf(DIFFICULTIES), priority: oneOf(PRIORITIES) },
    may: { status: isName, estimated_minutes: int(1, 1000), last_studied_at: isTime, last_recalled_at: isTime,
           next_recall_at: isTime, recall_stage: int(0, 50), created_at: isTime } },
  tasks: { label: "Task",
    need: { id: isId, topic_id: isId, task_type: oneOf(["study", "recall"]), scheduled_date: isDay, status: oneOf(["pending", "done", "partial", "missed"]) },
    may: { estimated_minutes: int(0, 1000), completed_at: isTime, created_at: isTime } },
  recallHistory: { label: "Recall record",
    need: { topic_id: isId, result: oneOf(["done", "partial", "missed"]), recalled_at: isTime },
    may: { id: isId, task_id: isId, recall_stage: int(0, 50), next_recall_at: isTime, created_at: isTime } },
  studySessions: { label: "Study session",
    need: { started_at: isTime, ended_at: isTime, duration_minutes: int(0, 1440) },
    may: { id: isId, topic_id: isId, created_at: isTime } },
};
const OPTIONAL_REFS = new Set(["task_id", "topic_id@studySessions"]); // missing targets are dropped, not errors

/** Checks a parsed JSON value. Nothing is sent anywhere. Returns { ok, errors, errorCount, backup }. */
export function validateBackup(json) {
  const errors = [];
  let errorCount = 0;
  const fail = (text) => { errorCount += 1; if (errors.length < MAX_SHOWN_ERRORS) errors.push(text); };

  if (!json || typeof json !== "object" || json.app !== "StudyFlow") {
    return { ok: false, errors: ["This is not a StudyFlow backup file."], errorCount: 1 };
  }
  if (json.version !== BACKUP_VERSION) {
    return { ok: false, errors: [`Unsupported backup version (${String(json.version)}). This app reads version ${BACKUP_VERSION}.`], errorCount: 1 };
  }
  const data = json.data;
  if (!data || typeof data !== "object") return { ok: false, errors: ["The backup has no data section."], errorCount: 1 };

  let rowCount = 0;
  for (const key of Object.keys(SCHEMAS)) {
    if (!Array.isArray(data[key])) fail(`"${key}" must be a list.`);
    else rowCount += data[key].length;
  }
  if (errorCount) return { ok: false, errors, errorCount };
  if (rowCount > MAX_ROWS) return { ok: false, errors: [`The backup is too large (${rowCount} rows).`], errorCount: 1 };

  // Field checks
  for (const [key, schema] of Object.entries(SCHEMAS)) {
    const seen = new Set();
    data[key].forEach((row, i) => {
      const where = `${schema.label} ${i + 1}`;
      if (!row || typeof row !== "object" || Array.isArray(row)) return fail(`${where}: not a valid record.`);
      for (const [field, check] of Object.entries(schema.need)) if (!check(row[field])) fail(`${where}: "${field}" is missing or not valid.`);
      for (const [field, check] of Object.entries(schema.may)) {
        if (row[field] !== undefined && row[field] !== null && !check(row[field])) fail(`${where}: "${field}" is not valid.`);
      }
      if (isId(row.id)) {
        if (seen.has(row.id)) fail(`${where}: duplicate id.`);
        seen.add(row.id);
      }
    });
  }
  // Links between records
  const idsOf = (key) => new Set(data[key].map((r) => r?.id));
  const subjectIds = idsOf("subjects"), chapterIds = idsOf("chapters"), topicIds = idsOf("topics");
  const link = (key, field, targets, name) => data[key].forEach((row, i) => {
    if (row && isId(row[field]) && !targets.has(row[field])) fail(`${SCHEMAS[key].label} ${i + 1}: its ${name} is not in the file.`);
  });
  link("exams", "subject_id", subjectIds, "subject");
  link("chapters", "subject_id", subjectIds, "subject");
  link("topics", "chapter_id", chapterIds, "chapter");
  link("tasks", "topic_id", topicIds, "topic");
  link("recallHistory", "topic_id", topicIds, "topic");

  // Profile and settings (both optional)
  const profile = data.profile ?? null;
  if (profile !== null) {
    if (typeof profile !== "object") fail("Profile is not valid.");
    else {
      if (profile.full_name !== undefined && profile.full_name !== null && !isName(profile.full_name)) fail('Profile: "full_name" is not valid.');
      if (profile.class_name !== undefined && profile.class_name !== null && !isStr(profile.class_name)) fail('Profile: "class_name" is not valid.');
      if (profile.daily_study_minutes != null && !int(10, 720)(profile.daily_study_minutes)) fail('Profile: "daily_study_minutes" must be 10 to 720.');
    }
  }
  const settings = data.settings ?? null;
  if (settings !== null) {
    if (typeof settings !== "object") fail("Settings are not valid.");
    else {
      if (settings.daily_study_minutes != null && !int(10, 720)(settings.daily_study_minutes)) fail('Settings: "daily_study_minutes" must be 10 to 720.');
      for (const day of WEEKDAYS) {
        if (settings[`${day}_minutes`] != null && !int(0, 720)(settings[`${day}_minutes`])) fail(`Settings: "${day}_minutes" must be 0 to 720.`);
      }
      if (settings.dark_mode != null && typeof settings.dark_mode !== "boolean") fail('Settings: "dark_mode" must be true or false.');
    }
  }

  if (errorCount) return { ok: false, errors, errorCount };
  return { ok: true, errors: [], errorCount: 0, backup: { exportedAt: isTime(json.exportedAt) ? json.exportedAt : null, ...data, profile, settings } };
}

export function summarize(backup) {
  return {
    subjects: backup.subjects.length, chapters: backup.chapters.length, topics: backup.topics.length,
    tasks: backup.tasks.length, recalls: backup.recallHistory.length, sessions: backup.studySessions.length,
  };
}

// ---------- Preparing rows for the database ----------
/** Copies only the listed columns. null/missing values are left out so the database defaults apply. */
const pick = (source, keys, extra) => {
  const out = { ...extra };
  for (const k of keys) if (source[k] !== undefined && source[k] !== null) out[k] = source[k];
  return out;
};

/**
 * Turns a validated backup into rows for the logged-in user.
 * Every record gets a NEW id (references are re-linked), so a backup can never clash with
 * existing rows, not even rows belonging to another account.
 */
export function prepareImport(backup, userId, newId = () => globalThis.crypto.randomUUID()) {
  const remap = (rows) => new Map(rows.map((r) => [r.id, newId()]));
  const subjectIds = remap(backup.subjects), chapterIds = remap(backup.chapters);
  const topicIds = remap(backup.topics), taskIds = remap(backup.tasks);
  const own = (id) => ({ id, user_id: userId });

  const plan = {
    subjects: backup.subjects.map((r) => pick(r, ["name", "color", "daily_minutes", "topics_per_day", "created_at"], own(subjectIds.get(r.id)))),
    exams: backup.exams.map((r) => pick(r, ["name", "exam_date", "created_at"], { ...own(newId()), subject_id: subjectIds.get(r.subject_id) })),
    chapters: backup.chapters.map((r) => pick(r, ["name", "chapter_number", "created_at"], { ...own(chapterIds.get(r.id)), subject_id: subjectIds.get(r.subject_id) })),
    topics: backup.topics.map((r) => pick(r, ["name", "difficulty", "priority", "status", "estimated_minutes", "last_studied_at",
      "last_recalled_at", "next_recall_at", "recall_stage", "created_at"], { ...own(topicIds.get(r.id)), chapter_id: chapterIds.get(r.chapter_id) })),
    tasks: backup.tasks.map((r) => pick(r, ["task_type", "scheduled_date", "estimated_minutes", "status", "completed_at", "created_at"],
      { ...own(taskIds.get(r.id)), topic_id: topicIds.get(r.topic_id) })),
    recallHistory: backup.recallHistory.map((r) => pick(r, ["result", "recall_stage", "recalled_at", "next_recall_at", "created_at"],
      { ...own(newId()), topic_id: topicIds.get(r.topic_id), ...(taskIds.has(r.task_id) ? { task_id: taskIds.get(r.task_id) } : {}) })),
    studySessions: backup.studySessions.map((r) => pick(r, ["started_at", "ended_at", "duration_minutes", "created_at"],
      { ...own(newId()), ...(topicIds.has(r.topic_id) ? { topic_id: topicIds.get(r.topic_id) } : {}) })),
    profile: null,
    settings: null,
  };
  if (backup.profile) {
    const p = pick(backup.profile, ["full_name", "daily_study_minutes"], {});
    if (isStr(backup.profile.class_name) && backup.profile.class_name.trim()) p.class_name = backup.profile.class_name.trim();
    plan.profile = p;
  }
  if (backup.settings) {
    plan.settings = pick(backup.settings, ["daily_study_minutes", "dark_mode", ...WEEKDAYS.map((d) => `${d}_minutes`)], {});
  }
  return plan;
}
