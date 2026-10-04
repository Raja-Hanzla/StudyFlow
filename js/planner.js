// Planner: connects the scheduler to the database.
//   refreshSchedule()  rebuild the plan and save the differences
//   completeTask / markTaskPartial / markTaskMissed   record a result, then refresh
// The scheduling decisions themselves live in scheduler.js.
import * as db from "./database.js";
import * as sch from "./scheduler.js";
import { TOPIC_STATUS, WEEKDAYS } from "./constants.js";
import { toDateString, toLocalDay } from "./utils.js";
import { state } from "./state.js";

// ---------- "Today" ----------
/** Today as the student's local calendar day, "YYYY-MM-DD". */
export const getToday = () => toDateString();

// ---------- Loading ----------
/** Reads everything the scheduler needs and converts it to the scheduler's plain shapes. */
async function loadSnapshot(today) {
  const [subjects, exams, chapters, topics, tasks, settings] = await Promise.all([
    db.getSubjects(), db.getExams(), db.getChapters(), db.getTopics(), db.getTasks(today), db.getSettings(),
  ]);
  const chapterById = new Map(chapters.map((c) => [c.id, c]));
  return {
    today,
    raw: { subjects, chapters, topics, exams },
    subjects: subjects.map((s) => ({ id: s.id, name: s.name })),
    exams: exams.map((e) => ({ subjectId: e.subject_id, date: toLocalDay(e.exam_date) })),
    topics: topics.filter((t) => chapterById.has(t.chapter_id)).map((t) => {
      const chapter = chapterById.get(t.chapter_id);
      return {
        id: t.id, chapterId: t.chapter_id, subjectId: chapter.subject_id, chapterNumber: chapter.chapter_number ?? 0,
        name: t.name, difficulty: t.difficulty, priority: t.priority,
        minutes: t.estimated_minutes || sch.CONFIG.DEFAULT_TOPIC_MINUTES,
        studied: Boolean(t.last_studied_at), stage: t.recall_stage ?? 0,
        nextRecallDay: t.next_recall_at ? toLocalDay(t.next_recall_at) : null,
      };
    }),
    tasks: tasks.map((t) => ({
      id: t.id, topicId: t.topic_id, type: t.task_type, date: toLocalDay(t.scheduled_date),
      minutes: t.estimated_minutes ?? 0, status: t.status,
    })),
    capacity: Object.fromEntries(WEEKDAYS.map((d) => [d, settings?.[`${d}_minutes`]])),
    defaultMinutes: settings?.daily_study_minutes ?? state.profile?.daily_study_minutes ?? 60,
  };
}

// ---------- Refresh ----------
// Refreshes run one after another (a queue), so two quick actions can't create duplicate tasks.
let queue = Promise.resolve();
export function refreshSchedule() {
  const run = queue.then(doRefresh);
  queue = run.catch(() => {}); // one failure must not block later refreshes
  return run;
}

async function doRefresh() {
  const today = getToday();
  let snap = await loadSnapshot(today);

  // 1. Pending tasks that are far overdue count as missed (prevents an endless backlog).
  const stale = sch.rescheduleMissedTasks(snap.tasks, today);
  for (const task of stale) await recordResult(task.id, "missed", { auto: true });
  if (stale.length) snap = await loadSnapshot(today);

  // 2. Work out the plan and save only what changed.
  const result = sch.generateSchedule(snap);
  const existing = snap.tasks.filter((t) => t.status === "pending" && t.date >= today);
  const diff = sch.diffSchedule(existing, result.planned);

  await db.deleteTasks(diff.remove);
  for (const u of diff.update) await db.updateTask(u.id, { scheduled_date: u.date, estimated_minutes: u.minutes });
  await db.insertTasks(diff.insert.map((p) => ({
    topic_id: p.topicId, task_type: p.type, scheduled_date: p.date, estimated_minutes: p.minutes, status: "pending",
  })));
  return result;
}

// ---------- Recording results ----------
const failedCommits = new Map(); // "taskId|result" -> save steps that failed half-way

/**
 * Saves a result in small steps. If one step fails (network), the same steps are
 * reused on retry and finished ones are skipped, so nothing is saved twice.
 * The task's own status is saved LAST: a task that still says "pending" is unfinished.
 */
const inFlight = new Map(); // taskId -> the save that is running right now

async function recordResult(taskId, result, options = {}) {
  // A second click (or a duplicate handler) while the first save is still running joins it
  // instead of recording the same task twice.
  if (inFlight.has(taskId)) return inFlight.get(taskId);
  const running = saveResult(taskId, result, options).finally(() => inFlight.delete(taskId));
  inFlight.set(taskId, running);
  return running;
}

async function saveResult(taskId, result, { durationMinutes = null, auto = false } = {}) {
  const key = `${taskId}|${result}`;
  let commit = failedCommits.get(key);
  if (!commit) commit = await prepareCommit(taskId, result, { durationMinutes, auto });
  try {
    await commit();
    failedCommits.delete(key);
  } catch (err) {
    failedCommits.set(key, commit);
    throw err;
  }
}

async function prepareCommit(taskId, result, { durationMinutes, auto }) {
  const today = getToday();
  const snap = await loadSnapshot(today);
  const task = snap.tasks.find((t) => t.id === taskId);
  const topic = snap.topics.find((t) => t.id === task?.topicId);
  if (!task || !topic) throw new Error("This task no longer exists. Refresh the page.");

  const now = new Date();
  const nowIso = now.toISOString();
  const outcome = sch.applyResult({
    topic, type: task.type, result, today, nowIso,
    examDate: sch.nextExamDate(snap.exams, topic.subjectId, today),
  });
  if (task.type === "study" && result === "done" && TOPIC_STATUS.studied) outcome.topicPatch.status = TOPIC_STATUS.studied;

  // Time spent: given by a timer later, otherwise the plan (half of it for "partial").
  const spent = result === "missed" ? 0
    : durationMinutes ?? Math.round(task.minutes * (result === "partial" ? sch.CONFIG.PARTIAL_TIME_FACTOR : 1));

  const steps = [];
  if (Object.keys(outcome.topicPatch).length) steps.push(() => db.updateTopic(topic.id, outcome.topicPatch));
  if (outcome.history) {
    steps.push(() => db.insertRecallHistory({
      topic_id: topic.id, task_id: task.id, result: outcome.history.result,
      recall_stage: outcome.history.stage, recalled_at: nowIso, next_recall_at: outcome.history.nextAt,
    }));
  }
  if (spent > 0 && !auto) {
    steps.push(() => db.insertStudySession({
      topic_id: topic.id, started_at: new Date(now - spent * 60000).toISOString(),
      ended_at: nowIso, duration_minutes: spent,
    }));
  }
  steps.push(() => db.updateTask(task.id, {
    status: outcome.taskStatus, completed_at: result === "missed" ? null : nowIso,
  }));

  let next = 0;
  return async () => { while (next < steps.length) { await steps[next](); next += 1; } };
}

export async function completeTask(taskId, options) { await recordResult(taskId, "done", options); await refreshSchedule(); }
export async function markTaskPartial(taskId, options) { await recordResult(taskId, "partial", options); await refreshSchedule(); }
export async function markTaskMissed(taskId, options) { await recordResult(taskId, "missed", options); await refreshSchedule(); }

// ---------- Reading the plan (for pages) ----------
/** Tasks with their topic / chapter / subject names, ready to display. */
export async function loadView() {
  const today = getToday();
  const snap = await loadSnapshot(today);
  const subject = new Map(snap.raw.subjects.map((s) => [s.id, s]));
  const chapter = new Map(snap.raw.chapters.map((c) => [c.id, c]));
  const topic = new Map(snap.raw.topics.map((t) => [t.id, t]));
  const tasks = snap.tasks.map((t) => {
    const tp = topic.get(t.topicId);
    if (!tp) return null;
    const ch = chapter.get(tp.chapter_id);
    const su = subject.get(ch?.subject_id);
    return { ...t, topicName: tp.name, chapterName: ch?.name, subjectName: su?.name, color: su?.color,
             difficulty: tp.difficulty, priority: tp.priority };
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.topicName.localeCompare(b.topicName));
  const exams = snap.raw.exams
    .map((e) => ({ date: toLocalDay(e.exam_date), subjectName: subject.get(e.subject_id)?.name ?? "" }))
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  // Real counts only: studied = studied at least once, recalled = passed at least one recall.
  const stats = {
    total: snap.topics.length,
    studied: snap.topics.filter((t) => t.studied).length,
    recalled: snap.topics.filter((t) => t.stage >= 1).length,
    subjects: snap.raw.subjects.length,
  };
  return { today, tasks, exams, stats, capacityToday: sch.capacityFor(snap, today) };
}
