// Database service layer: the ONLY place that talks to Supabase tables.
// Each stage adds more functions here (getSubjects, createTopic, ...).
// RLS on the server guarantees users only ever get their own rows.
import { supabase } from "./supabase.js";

/** Loads the logged-in user's profile row (null if it doesn't exist yet). */
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Writes used by onboarding
// ---------------------------------------------------------------------
import { state } from "./state.js";
import { explainError } from "./errors.js";
import { WEEKDAYS } from "./constants.js";

/** Logs the technical error, throws a readable one. */
function fail(error) {
  console.error("Database error:", error);
  const err = new Error(`Couldn't save your changes. ${explainError(error)}`);
  err.reason = explainError(error);
  return err;
}

// user_id comes from the logged-in session. The RLS policies on the server
// still check it, so a wrong value would be rejected, never accepted.
const uid = () => state.user.id;

export async function updateProfile({ fullName, className, dailyMinutes }) {
  const { error } = await supabase.from("profiles").upsert(
    { id: uid(), full_name: fullName, class_name: className, daily_study_minutes: dailyMinutes },
    { onConflict: "id" }
  );
  if (error) throw fail(error);
}

/** Sets the same minutes for every weekday; per-day values are edited on the Settings page. */
export async function saveSettings({ dailyMinutes }) {
  const row = { user_id: uid(), daily_study_minutes: dailyMinutes };
  WEEKDAYS.forEach((day) => (row[`${day}_minutes`] = dailyMinutes));
  const { error } = await supabase.from("settings").upsert(row, { onConflict: "user_id" });
  if (error) throw fail(error);
}

export async function createSubject({ name, color }) {
  const { data, error } = await supabase
    .from("subjects").insert({ user_id: uid(), name, color }).select("id").single();
  if (error) throw fail(error);
  return data;
}

export async function createExam({ subjectId, name, examDate }) {
  const { data, error } = await supabase
    .from("exams").insert({ user_id: uid(), subject_id: subjectId, name, exam_date: examDate })
    .select("id").single();
  if (error) throw fail(error);
  return data;
}

export async function createChapter({ subjectId, name, chapterNumber }) {
  const { data, error } = await supabase
    .from("chapters")
    .insert({ user_id: uid(), subject_id: subjectId, name, chapter_number: chapterNumber })
    .select("id").single();
  if (error) throw fail(error);
  return data;
}

/** One request for many topics. topics: [{name, difficulty, priority}] */
export async function createTopics(chapterId, topics, estimatedMinutes) {
  if (!topics.length) return;
  // Rows inserted together would all get the same created_at, which would lose the
  // order the student pasted them in. We space the timestamps 1 ms apart to keep it.
  const base = Date.now();
  const rows = topics.map((t, i) => ({
    user_id: uid(), chapter_id: chapterId, name: t.name,
    difficulty: t.difficulty, priority: t.priority, estimated_minutes: estimatedMinutes,
    created_at: new Date(base + i).toISOString(),
    // status / recall_stage are left out on purpose: the database defaults apply.
  }));
  const { error } = await supabase.from("topics").insert(rows);
  if (error) throw fail(error);
}

// ---------------------------------------------------------------------
// Subjects, exams, chapters, topics
// ---------------------------------------------------------------------
function loadFail(error) {
  console.error("Database error:", error);
  const err = new Error(`Couldn't load your data. ${explainError(error)}`);
  err.reason = explainError(error);
  return err;
}

/** Generic update by id. Only the fields you pass are changed. */
async function updateRow(table, id, fields) {
  const { error } = await supabase
    .from(table).update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw fail(error);
}
async function deleteRow(table, id) {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw fail(error);
}

// ----- Subjects -----
export async function getSubjects() {
  const { data, error } = await supabase.from("subjects").select("*").order("name");
  if (error) throw loadFail(error);
  return data;
}
export async function getSubject(id) {
  const { data, error } = await supabase.from("subjects").select("*").eq("id", id).maybeSingle();
  if (error) throw loadFail(error);
  return data;
}
export const updateSubject = (id, fields) => updateRow("subjects", id, fields);
export const deleteSubject = (id) => deleteRow("subjects", id);

// ----- Exams -----
export async function getExams(subjectId = null) {
  let query = supabase.from("exams").select("*").order("exam_date");
  if (subjectId) query = query.eq("subject_id", subjectId);
  const { data, error } = await query;
  if (error) throw loadFail(error);
  return data;
}
/** One "main" exam per subject is edited here: set, change or clear its date. */
export async function saveExamDate({ subjectId, subjectName, examId, examDate }) {
  if (examDate && examId) return updateRow("exams", examId, { exam_date: examDate });
  if (examDate) return createExam({ subjectId, name: `${subjectName} exam`, examDate });
  if (examId) return deleteRow("exams", examId);
}

// ----- Chapters -----
export async function getChapters(subjectId = null) {
  let query = supabase.from("chapters").select("*").order("chapter_number");
  if (subjectId) query = query.eq("subject_id", subjectId);
  const { data, error } = await query;
  if (error) throw loadFail(error);
  return data;
}
export const updateChapter = (id, fields) => updateRow("chapters", id, fields);
export const deleteChapter = (id) => deleteRow("chapters", id);

// ----- Topics -----
/** chapterIds = null loads every topic; pass an array to load only those chapters. */
export async function getTopics(chapterIds = null) {
  if (chapterIds && !chapterIds.length) return [];
  return fetchAll(() => {
    let query = supabase.from("topics").select("*").order("created_at").order("name").order("id");
    if (chapterIds) query = query.in("chapter_id", chapterIds);
    return query;
  });
}
export const updateTopic = (id, fields) => updateRow("topics", id, fields);
export const deleteTopic = (id) => deleteRow("topics", id);

// ---------------------------------------------------------------------
// Tasks, recall history, study sessions, settings
// ---------------------------------------------------------------------
export async function getSettings() {
  const { data, error } = await supabase.from("settings").select("*").eq("user_id", uid()).maybeSingle();
  if (error) throw loadFail(error);
  return data;
}

/** All pending tasks (any date) plus every task scheduled from `today` on. */
export function getTasks(today) {
  return fetchAll(() => supabase
    .from("study_tasks").select("*").or(`status.eq.pending,scheduled_date.gte.${today}`).order("id"));
}
export async function insertTasks(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("study_tasks").insert(rows.map((r) => ({ user_id: uid(), ...r })));
  if (error) throw fail(error);
}
export const updateTask = (id, fields) => updateRow("study_tasks", id, fields);
export async function deleteTasks(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from("study_tasks").delete().in("id", ids);
  if (error) throw fail(error);
}
export async function insertRecallHistory(row) {
  const { error } = await supabase.from("recall_history").insert({ user_id: uid(), ...row });
  if (error) throw fail(error);
}
export async function insertStudySession(row) {
  const { error } = await supabase.from("study_sessions").insert({ user_id: uid(), ...row });
  if (error) throw fail(error);
}

// ----- Study time -----
/** Study sessions that ended at or after `fromIso` (an ISO timestamp). */
export function getStudySessions(fromIso) {
  return fetchAll(() => supabase.from("study_sessions").select("*").gte("ended_at", fromIso).order("id"));
}

// ----- Calendar -----
/** Every task scheduled between two days (inclusive), any status. */
export function getTasksInRange(fromDay, toDay) {
  return fetchAll(() => supabase
    .from("study_tasks").select("*").gte("scheduled_date", fromDay).lte("scheduled_date", toDay).order("id"));
}

// ----- Statistics -----
/**
 * Supabase returns at most 1000 rows per request. This asks for pages of 1000
 * until everything has arrived. makeQuery must build a NEW query on every call
 * and should end with .order("id") so the pages never overlap.
 */
async function fetchAll(makeQuery) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw loadFail(error);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/** How many tasks have a status (optionally one type, or scheduled before a day). Counts only, no rows. */
export async function countTasks({ status, type = null, before = null }) {
  let query = supabase.from("study_tasks").select("id", { count: "exact", head: true }).eq("status", status);
  if (type) query = query.eq("task_type", type);
  if (before) query = query.lt("scheduled_date", before);
  const { count, error } = await query;
  if (error) throw loadFail(error);
  return count ?? 0;
}

/** Every recall result ever recorded (oldest first). */
export function getRecallHistory() {
  return fetchAll(() => supabase.from("recall_history").select("topic_id,result,recalled_at").order("recalled_at").order("id"));
}

// ---------------------------------------------------------------------
// Settings, export, import, reset
// ---------------------------------------------------------------------
/** Changes only the settings columns you pass (creates the row if it's missing). */
export async function updateSettings(fields) {
  const { error } = await supabase.from("settings")
    .upsert({ user_id: uid(), ...fields, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw fail(error);
}

/** Changes only the profile columns you pass. */
export async function updateProfileFields(fields) {
  const { error } = await supabase.from("profiles")
    .update({ ...fields, updated_at: new Date().toISOString() }).eq("id", uid());
  if (error) throw fail(error);
}

/** Everything that belongs to the logged-in user (RLS allows nothing else). */
export async function getAllForExport() {
  const mine = (table) => fetchAll(() => supabase.from(table).select("*").eq("user_id", uid()).order("id"));
  const [profileResult, settings, subjects, exams, chapters, topics, tasks, recallHistory, studySessions] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", uid()).maybeSingle(),
    getSettings(), mine("subjects"), mine("exams"), mine("chapters"), mine("topics"),
    mine("study_tasks"), mine("recall_history"), mine("study_sessions"),
  ]);
  if (profileResult.error) throw loadFail(profileResult.error);
  return { profile: profileResult.data, settings, subjects, exams, chapters, topics, tasks, recallHistory, studySessions };
}

const IMPORT_TABLES = ["subjects", "exams", "chapters", "topics", "study_tasks", "recall_history", "study_sessions"];

/** Inserts rows in batches. Upsert by id, so repeating a batch after a network failure can't duplicate it. */
export async function upsertRows(table, rows) {
  if (!IMPORT_TABLES.includes(table)) throw new Error(`Unknown table: ${table}`);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw fail(error);
  }
}

// Children first, so foreign keys never block a delete.
const STUDY_TABLES = ["study_sessions", "recall_history", "study_tasks", "topics", "chapters", "exams", "subjects"];

/** Deletes all study data (not the account, profile or settings) and checks that nothing is left. */
export async function deleteAllStudyData() {
  for (const table of STUDY_TABLES) {
    const { error } = await supabase.from(table).delete().eq("user_id", uid());
    if (error) throw fail(error);
    const { count, error: countError } = await supabase.from(table).select("id", { count: "exact", head: true });
    if (countError) throw loadFail(countError);
    if (count) throw new Error(`Couldn't remove everything from ${table}. Check that its Row Level Security policies allow deleting your own rows.`);
  }
}
