// =====================================================================
// StudyFlow scheduler: pure logic. No DOM, no Supabase, no clock.
// Same input -> same output (deterministic), so it is easy to test.
// planner.js loads the data and saves the results; this file only decides.
//
// THE IDEA
//   The plan is derived from each topic's state:
//     never studied        -> a STUDY task is wanted, inside its subject's daily time
//     studied              -> a RECALL task is wanted on its next_recall_at day (no time, no limit)
//   Each subject has "minutes per day" and "topics per day". That is the only study limit.
//
// All dates are plain "YYYY-MM-DD" strings.
// =====================================================================

// ---------- Settings you can tune ----------
export const CONFIG = {
  RECALL_INTERVALS: [1, 3, 7, 14, 30],            // days between recalls, by stage
  DIFFICULTY_FACTOR: { easy: 1.25, medium: 1, hard: 0.75 }, // hard topics come back sooner
  PARTIAL_FACTOR: 0.5,        // a partial recall comes back in half the usual gap
  PARTIAL_TIME_FACTOR: 0.5,   // assumed share of the planned time spent on a "partial" task
  HORIZON_DAYS: 14,           // how many days ahead tasks are created
  OVERDUE_MAX_DAYS: 2,        // a pending task older than this is counted as missed
  DEFAULT_SUBJECT_MINUTES: 60, // a subject's study time per day, until the student sets it
  DEFAULT_TOPICS_PER_DAY: 1,
  FINAL_REVIEW_WINDOW: 3,     // last recalls may move up to 3 days earlier, before an exam
};
// How exam proximity shortens the gaps (see examMode)
const EXAM_FACTOR = { normal: 1, focus: 0.75, intensive: 0.6, final: 0.5 };
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const DIFFICULTY_RANK = { hard: 0, medium: 1, easy: 2 };

// ---------- Date helpers (UTC math on "YYYY-MM-DD", so no timezone surprises) ----------
const DAY_MS = 86400000;
const toMs = (day) => { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (day, n) => new Date(toMs(day) + n * DAY_MS).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((toMs(a) - toMs(b)) / DAY_MS); // a minus b
const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const weekdayOf = (day) => WEEKDAY_NAMES[new Date(toMs(day)).getUTCDay()];
const maxDay = (a, b) => (a > b ? a : b);
/** Stored at noon UTC so the same calendar day shows in every timezone. */
export const dayToTimestamp = (day) => (day ? `${day}T12:00:00Z` : null);

// =====================================================================
// 1. Exam proximity
// =====================================================================
/** normal: >30 days | focus: 14-30 | intensive: 7-13 | final: under 7 */
export function examMode(daysLeft) {
  if (daysLeft === null || daysLeft > 30) return "normal";
  if (daysLeft >= 14) return "focus";
  if (daysLeft >= 7) return "intensive";
  return "final";
}
/** Earliest exam on or after today for a subject (or null). */
export function nextExamDate(exams, subjectId, today) {
  const dates = exams.filter((e) => e.subjectId === subjectId && e.date >= today).map((e) => e.date).sort();
  return dates[0] ?? null;
}

// =====================================================================
// 2. Spaced repetition
// =====================================================================
/**
 * recall_stage = how many recalls have been passed so far.
 *   studied  first study finished     -> stage 0, first recall after 1 day
 *   done     recall went well         -> stage + 1, longer gap (1, 3, 7, 14, 30 days)
 *   partial  recall went so-so        -> same stage, half the usual gap
 *   missed   recall not done          -> one stage back, recall again in 1 day
 * The gap is then adapted: hard topics come back sooner, easy ones later,
 * and the closer the exam the shorter the gaps. A recall is never placed
 * after the day before the exam (nextDay becomes null if there's no room).
 * @returns {{stage:number, nextDay:string|null, gapDays:number}}
 */
export function calculateNextRecall({ result, stage, difficulty, today, examDate = null }) {
  const I = CONFIG.RECALL_INTERVALS;
  const gapAt = (s) => I[Math.min(Math.max(s, 0), I.length - 1)];

  let newStage = stage;
  let gap;
  if (result === "studied") { newStage = 0; gap = gapAt(0); }
  else if (result === "done") { newStage = stage + 1; gap = gapAt(newStage); }
  else if (result === "partial") { newStage = stage; gap = gapAt(stage) * CONFIG.PARTIAL_FACTOR; }
  else { newStage = Math.max(0, stage - 1); gap = 1; } // missed: soon

  if (result !== "missed") {
    const mode = examMode(examDate ? diffDays(examDate, today) : null);
    gap = gap * (CONFIG.DIFFICULTY_FACTOR[difficulty] ?? 1) * EXAM_FACTOR[mode];
  }
  gap = Math.max(1, Math.round(gap));

  let nextDay = addDays(today, gap);
  if (examDate) {
    const lastDay = addDays(examDate, -1);
    if (lastDay <= today) nextDay = null;           // no day left before the exam
    else if (nextDay > lastDay) nextDay = lastDay;  // final recall just before the exam
  }
  return { stage: newStage, nextDay, gapDays: gap };
}

/**
 * What changes when a task gets a result. Returns the topic fields to save,
 * the recall_history row (recall tasks only) and the task's new status.
 * result: "done" | "partial" | "missed"
 */
export function applyResult({ topic, type, result, today, examDate, nowIso }) {
  if (type === "study") {
    if (result !== "done") {
      // Partial/missed study: the topic stays "not studied yet" and comes back tomorrow
      // (buildDemands skips a topic already handled today).
      return { taskStatus: result, topicPatch: {}, history: null };
    }
    const next = calculateNextRecall({ result: "studied", stage: 0, difficulty: topic.difficulty, today, examDate });
    return {
      taskStatus: "done",
      topicPatch: { last_studied_at: nowIso, recall_stage: 0, next_recall_at: dayToTimestamp(next.nextDay) },
      history: null,
    };
  }
  const next = calculateNextRecall({ result, stage: topic.stage, difficulty: topic.difficulty, today, examDate });
  const topicPatch = { recall_stage: next.stage, next_recall_at: dayToTimestamp(next.nextDay) };
  if (result !== "missed") topicPatch.last_recalled_at = nowIso;
  return {
    taskStatus: result,
    topicPatch,
    history: { result, stage: next.stage, nextAt: topicPatch.next_recall_at },
  };
}

// =====================================================================
// 3. What is wanted
// =====================================================================
// STUDY: every subject has "minutes per day" and "topics per day". Each day the subject gets
//        that many unstudied topics (most important first) and the subject's minutes are
//        shared between them. Marking the subject done studies all of them at once.
// RECALL: a studied topic is recalled on its next_recall_at day. Recalls have NO time and NO
//        daily limit: whatever is due is scheduled on its day.
const roundTo5 = (n) => Math.max(5, Math.round(n / 5) * 5);

/** Order inside one subject: high priority, then hard, then chapter order, then name. */
function compareTopics(a, b) {
  return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
    (DIFFICULTY_RANK[a.difficulty] ?? 1) - (DIFFICULTY_RANK[b.difficulty] ?? 1) ||
    a.chapterNumber - b.chapterNumber || a.name.localeCompare(b.name) || a.id.localeCompare(b.id); // fixed tie-breakers = deterministic
}

function examsBySubject(exams, today) {
  const map = new Map();
  for (const e of [...exams].sort((a, b) => a.date.localeCompare(b.date))) {
    const entry = map.get(e.subjectId) ?? { upcoming: null };
    if (e.date >= today) entry.upcoming ??= e.date;
    map.set(e.subjectId, entry);
  }
  return map;
}

/** Recalls to place: [{topicId, type:"recall", date, minutes:0}] */
function planRecalls(snapshot, exams, handled, carried) {
  const { today } = snapshot;
  const lastPlannable = addDays(today, CONFIG.HORIZON_DAYS - 1);
  const planned = [];
  for (const topic of snapshot.topics) {
    if (!topic.studied) continue;
    const info = exams.get(topic.subjectId);
    if (info && !info.upcoming) continue;                         // all exams are in the past
    const examDate = info?.upcoming ?? null;
    const lastDay = examDate ? addDays(examDate, -1) : null;      // never plan work after this day
    if (lastDay !== null && lastDay < today) continue;            // exam is today: no new work
    const key = `${topic.id}|recall`;
    if (carried.has(key)) continue;                               // an overdue recall already exists
    const daysLeft = examDate ? diffDays(examDate, today) : null;

    let due = topic.nextRecallDay ?? addDays(today, 1);
    if (due < today) due = today;                                 // overdue: do it today
    if (handled.has(key) && due <= today) due = addDays(today, 1);
    // In the last week, strong easy topics are left alone: only necessary recalls remain.
    const strong = topic.difficulty === "easy" && topic.priority !== "high" && topic.stage >= 2;
    if (examMode(daysLeft) === "final" && strong) continue;
    // A recall that would fall after the exam moves into the last days before it.
    if (lastDay !== null && due > lastDay) due = maxDay(today, addDays(lastDay, -CONFIG.FINAL_REVIEW_WINDOW));
    if (due > lastPlannable) continue;                            // beyond the planning window: later
    planned.push({ topicId: topic.id, type: "recall", date: due, minutes: 0 });
  }
  return planned;
}

/** Study tasks to place, subject by subject. Also returns notes. */
function planStudy(snapshot, exams, handled, carried) {
  const { today } = snapshot;
  const planned = [];
  const notes = [];
  for (const subject of snapshot.subjects) {
    const info = exams.get(subject.id);
    const topics = snapshot.topics.filter((t) => t.subjectId === subject.id);
    if (info && !info.upcoming) {
      if (topics.some((t) => !t.studied)) {
        notes.push({ kind: "exam-passed", text: `${subject.name}: the exam date has passed, so nothing is scheduled. Update the exam date on the Subjects page if this is wrong.` });
      }
      continue;
    }
    const examDate = info?.upcoming ?? null;
    const lastDay = examDate ? addDays(examDate, -1) : null;
    const perDay = Math.max(1, subject.topicsPerDay ?? 1);
    const minutes = subject.dailyMinutes ?? 60;

    // Today's quota is already partly used by topics finished (or tried) today and by carried-over ones.
    const consumed = snapshot.tasks.filter((t) => t.type === "study" && t.subjectId === subject.id &&
      ((t.status !== "pending" && t.date === today) || (t.status === "pending" && t.date < today))).length;

    const queue = topics
      .filter((t) => !t.studied && !carried.has(`${t.id}|study`))
      .sort(compareTopics)
      .map((t) => ({ t, from: handled.has(`${t.id}|study`) ? 1 : 0 })); // tried today (partial/missed): from tomorrow
    const total = queue.length;
    let placedCount = 0;

    for (let i = 0; i < CONFIG.HORIZON_DAYS && queue.length; i++) {
      const date = addDays(today, i);
      if (lastDay !== null && date > lastDay) break;
      const slots = i === 0 ? Math.max(0, perDay - consumed) : perDay;
      const todays = [];
      for (let q = 0; q < queue.length && todays.length < slots; q++) {
        if (queue[q].from <= i) todays.push(q);
      }
      if (!todays.length) continue;
      const share = roundTo5(minutes / (todays.length + (i === 0 ? consumed : 0)));
      for (const q of todays) planned.push({ topicId: queue[q].t.id, type: "study", date, minutes: share });
      placedCount += todays.length;
      for (let k = todays.length - 1; k >= 0; k--) queue.splice(todays[k], 1);
    }

    // Will everything be studied before the exam at this pace?
    if (examDate) {
      let slotsLeft = 0;
      for (let day = today, i = 0; day <= lastDay; day = addDays(day, 1), i++) slotsLeft += i === 0 ? Math.max(0, perDay - consumed) : perDay;
      if (total > slotsLeft) {
        notes.push({
          kind: "workload",
          text: `${subject.name}: ${total} topic${total === 1 ? "" : "s"} still to study, but at ${perDay} a day only ${slotsLeft} fit before the exam on ${examDate}. Raise "topics per day" for this subject to finish in time.`,
        });
      }
    }
  }
  return { planned, notes };
}

/** Pending tasks that have been overdue too long. The planner counts them as missed. */
export function rescheduleMissedTasks(tasks, today) {
  return tasks.filter((t) => t.status === "pending" && diffDays(today, t.date) > CONFIG.OVERDUE_MAX_DAYS);
}

// =====================================================================
// 4. The whole schedule
// =====================================================================
/**
 * snapshot = { today, subjects:[{id,name,dailyMinutes,topicsPerDay}], exams, topics, tasks } (see planner.js)
 * tasks need: topicId, subjectId, type, date, status.
 * @returns {{planned: object[], unscheduled: object[], notes: object[]}}
 */
export function generateSchedule(snapshot) {
  const { today } = snapshot;
  const exams = examsBySubject(snapshot.exams, today);
  // Tasks already finished today, and old pending tasks that are still being carried over:
  const handled = new Set(snapshot.tasks.filter((t) => t.status !== "pending" && t.date === today).map((t) => `${t.topicId}|${t.type}`));
  const carried = new Set(snapshot.tasks.filter((t) => t.status === "pending" && t.date < today).map((t) => `${t.topicId}|${t.type}`));

  const study = planStudy(snapshot, exams, handled, carried);
  const recalls = planRecalls(snapshot, exams, handled, carried);
  return { planned: [...study.planned, ...recalls], unscheduled: [], notes: study.notes };
}

/**
 * Compares the wanted plan with the pending future tasks already saved.
 * Keeps unchanged rows, so ids stay stable and nothing is duplicated.
 * @returns {{insert: object[], update: object[], remove: string[]}}
 */
export function diffSchedule(existing, planned) {
  const wanted = new Map(planned.map((p) => [`${p.topicId}|${p.type}`, p]));
  const insert = [];
  const update = [];
  const remove = [];
  for (const task of existing) {
    const key = `${task.topicId}|${task.type}`;
    const want = wanted.get(key);
    if (!want) { remove.push(task.id); continue; }
    if (want.date !== task.date || want.minutes !== task.minutes) {
      update.push({ id: task.id, date: want.date, minutes: want.minutes });
    }
    wanted.delete(key);
  }
  for (const want of wanted.values()) insert.push(want);
  return { insert, update, remove };
}
