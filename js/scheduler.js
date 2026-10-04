// =====================================================================
// StudyFlow scheduler: pure logic. No DOM, no Supabase, no clock.
// Same input -> same output (deterministic), so it is easy to test.
// planner.js loads the data and saves the results; this file only decides.
//
// THE IDEA
//   The plan is derived from each topic's state:
//     never studied        -> a STUDY task is wanted
//     studied              -> a RECALL task is wanted on its next_recall_at day
//   Wanted work ("demands") is sorted by importance and placed on the
//   earliest day with free time. What doesn't fit simply waits.
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
  RECALL_FRACTION: 0.3,       // a recall takes about 30% of a topic's study time
  FINAL_REVIEW_WINDOW: 3,     // last recalls may move up to 3 days earlier, before an exam
  DEFAULT_TOPIC_MINUTES: 30,
  DEFAULT_RECALL_MINUTES: 30, // daily recall time when the student hasn't set one
};
// How exam proximity shortens the gaps (see examMode)
const EXAM_FACTOR = { normal: 1, focus: 0.75, intensive: 0.6, final: 0.5 };
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const DIFFICULTY_RANK = { hard: 0, medium: 1, easy: 2 };
const NO_LIMIT = "9999-12-31";

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

/** Minutes available on a day: that weekday's setting, else the daily default. */
export function capacityFor(snapshot, day) {
  return snapshot.capacity?.[weekdayOf(day)] ?? snapshot.defaultMinutes ?? 60;
}
/** Minutes of RECALL time per day. It is its own pool: recalls never use up study minutes. */
export function recallCapacityFor(snapshot) {
  return snapshot.recallMinutes ?? CONFIG.DEFAULT_RECALL_MINUTES;
}
const recallMinutes = (studyMinutes) => Math.max(5, Math.round((studyMinutes * CONFIG.RECALL_FRACTION) / 5) * 5);

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
// 3. Wanted work ("demands")
// =====================================================================
/** A demand = one task the topic needs: {key, topicId, type, minutes, earliest, latest, ...} */
export function buildDemands(snapshot) {
  const { today } = snapshot;
  const exams = examsBySubject(snapshot.exams, today);
  const subjectName = new Map(snapshot.subjects.map((s) => [s.id, s.name]));
  // Tasks already finished today, and old pending tasks that are still being carried over:
  const handled = new Set(snapshot.tasks.filter((t) => t.status !== "pending" && t.date === today).map((t) => `${t.topicId}|${t.type}`));
  const carried = new Set(snapshot.tasks.filter((t) => t.status === "pending" && t.date < today).map((t) => `${t.topicId}|${t.type}`));

  const demands = [];
  const closed = new Set();

  for (const topic of snapshot.topics) {
    const info = exams.get(topic.subjectId);
    if (info && !info.upcoming) { closed.add(topic.subjectId); continue; } // all exams are in the past
    const examDate = info?.upcoming ?? null;
    const lastDay = examDate ? addDays(examDate, -1) : null;      // never plan work after this day
    if (lastDay !== null && lastDay < today) continue;            // exam is today: no new work
    const daysLeft = examDate ? diffDays(examDate, today) : null;

    const type = topic.studied ? "recall" : "study";
    const key = `${topic.id}|${type}`;
    if (carried.has(key)) continue; // an overdue task for it already exists

    let due = today;
    let overdue = false;
    let earliest;
    if (type === "study") {
      if (handled.has(key)) due = addDays(today, 1);              // partial/missed today: try tomorrow
      if (lastDay !== null && due > lastDay) continue;
      earliest = due;
    } else {
      due = topic.nextRecallDay ?? addDays(today, 1);
      if (due < today) { overdue = true; due = today; }
      if (handled.has(key) && due <= today) due = addDays(today, 1);
      // In the last week, strong easy topics are left alone: only necessary recalls remain.
      const strong = topic.difficulty === "easy" && topic.priority !== "high" && topic.stage >= 2;
      if (examMode(daysLeft) === "final" && strong) continue;
      earliest = due;
      // A recall that would fall after the exam moves into the last days before it.
      if (lastDay !== null && due > lastDay) earliest = maxDay(today, addDays(lastDay, -CONFIG.FINAL_REVIEW_WINDOW));
    }

    demands.push({
      key, topicId: topic.id, type, subjectId: topic.subjectId, examDate, examDays: daysLeft,
      minutes: type === "study" ? topic.minutes : recallMinutes(topic.minutes),
      earliest, latest: lastDay ?? NO_LIMIT, overdue,
      priority: topic.priority, difficulty: topic.difficulty,
      chapterNumber: topic.chapterNumber, name: topic.name,
    });
  }

  const notes = [...closed].map((id) => ({
    kind: "exam-passed",
    text: `${subjectName.get(id) ?? "A subject"}: the exam date has passed, so nothing is scheduled. Update the exam date on the Subjects page if this is wrong.`,
  }));
  return { demands, notes };
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

// =====================================================================
// 4. Importance order
// =====================================================================
const examBand = (days) => (days === null ? 3 : days < 7 ? 0 : days < 14 ? 1 : days <= 30 ? 2 : 3);

/**
 * Sort key for a demand: smaller = more important. Compared left to right,
 *   1 overdue first   2 closer exam   3 high priority   4 hard topics
 *   5 unfinished (study) before ordinary recalls
 * It is only used for ordering. It is never shown as a score.
 */
export function calculateTaskPriority(d) {
  return [
    d.overdue ? 0 : 1,
    examBand(d.examDays),
    PRIORITY_RANK[d.priority] ?? 1,
    DIFFICULTY_RANK[d.difficulty] ?? 1,
    d.type === "study" ? 0 : 1,
  ];
}
function compareDemands(a, b) {
  const ka = calculateTaskPriority(a);
  const kb = calculateTaskPriority(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.earliest.localeCompare(b.earliest) || a.chapterNumber - b.chapterNumber ||
    a.name.localeCompare(b.name) || a.key.localeCompare(b.key);   // fixed tie-breakers = deterministic
}

// =====================================================================
// 5. Daily capacity
// =====================================================================
/**
 * Places demands (most important first) on the earliest day that has room.
 * days: [{date, capacity, used, recallCapacity, recallUsed}] (used = time already taken, e.g. finished tasks)
 * Study tasks use the study pool (capacity/used). Recall tasks use their own pool
 * (recallCapacity/recallUsed), so recalls never take time away from studying.
 * A task bigger than the whole pool is still allowed on an empty day,
 * otherwise it could never be scheduled.
 * @returns {{placed: object[], unscheduled: object[]}}
 */
export function rebalanceDailyWorkload(demands, days) {
  const placed = [];
  const unscheduled = [];
  for (const d of [...demands].sort(compareDemands)) {
    const recall = d.type === "recall";
    const day = days.find((x) => {
      if (x.date < d.earliest || x.date > d.latest) return false;
      const cap = recall ? x.recallCapacity : x.capacity;
      const used = recall ? x.recallUsed : x.used;
      return cap > 0 && (d.minutes <= cap - used || used === 0);
    });
    if (day) {
      if (recall) day.recallUsed += d.minutes; else day.used += d.minutes;
      placed.push({ topicId: d.topicId, type: d.type, date: day.date, minutes: d.minutes });
    } else {
      unscheduled.push(d);
    }
  }
  return { placed, unscheduled };
}

/** Pending tasks that have been overdue too long. The planner counts them as missed. */
export function rescheduleMissedTasks(tasks, today) {
  return tasks.filter((t) => t.status === "pending" && diffDays(today, t.date) > CONFIG.OVERDUE_MAX_DAYS);
}

// =====================================================================
// 6. The whole schedule
// =====================================================================
/**
 * snapshot = { today, subjects, exams, topics, tasks, capacity, defaultMinutes } (see planner.js)
 * @returns {{planned: object[], unscheduled: object[], notes: object[]}}
 */
export function generateSchedule(snapshot) {
  const { today } = snapshot;
  const { demands, notes } = buildDemands(snapshot);

  const days = [];
  for (let i = 0; i < CONFIG.HORIZON_DAYS; i++) {
    const date = addDays(today, i);
    days.push({ date, capacity: capacityFor(snapshot, date), used: 0, recallCapacity: recallCapacityFor(snapshot), recallUsed: 0 });
  }
  // Today's time already taken: tasks finished today + old tasks still carried over.
  // Study tasks count against study time, recall tasks against recall time.
  const takenToday = (type) => snapshot.tasks
    .filter((t) => t.type === type && ((t.status !== "pending" && t.date === today) || (t.status === "pending" && t.date < today)))
    .reduce((sum, t) => sum + t.minutes, 0);
  days[0].used = takenToday("study");
  days[0].recallUsed = takenToday("recall");

  const { placed, unscheduled } = rebalanceDailyWorkload(demands, days);
  notes.push(...workloadNotes(snapshot, demands, days[0].used));
  const lostRecalls = unscheduled.filter((d) => d.type === "recall").length;
  if (lostRecalls > 0) {
    notes.push({
      kind: "recall-workload",
      text: `${lostRecalls} recall${lostRecalls === 1 ? "" : "s"} didn't fit in the next ${CONFIG.HORIZON_DAYS} days with ${fmtMinutes(recallCapacityFor(snapshot))} of recall time a day. Raise "Recall time" in Settings to fit them.`,
    });
  }
  return { planned: placed, unscheduled, notes };
}

/** Plain arithmetic: is there enough free time for the study that remains before each exam? */
function workloadNotes(snapshot, demands, usedToday) {
  const byExam = new Map();
  for (const d of demands) {
    if (d.type === "study" && d.examDate) byExam.set(d.examDate, (byExam.get(d.examDate) ?? 0) + d.minutes);
  }
  const notes = [];
  let needed = 0;
  for (const date of [...byExam.keys()].sort()) {
    needed += byExam.get(date);
    let available = -usedToday;
    for (let day = snapshot.today; day < date; day = addDays(day, 1)) available += capacityFor(snapshot, day);
    if (needed > Math.max(0, available)) {
      notes.push({
        kind: "workload",
        text: `Before the exam on ${date}: about ${fmtMinutes(needed)} of study remains and about ${fmtMinutes(Math.max(0, available))} is free. The most important topics are scheduled first.`,
      });
    }
  }
  return notes;
}
const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`);

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
