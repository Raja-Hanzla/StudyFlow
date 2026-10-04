// Statistics for the Progress and Insights pages.
// Everything is counted from your saved data. Nothing is estimated or predicted.
import * as db from "./database.js";
import * as planner from "./planner.js";
import { addDays, diffDays, weekdayOf } from "./scheduler.js";
import { toLocalDay } from "./utils.js";

const WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WEEKS = 8; // the weekly charts show the last 8 weeks, this week included
const mondayOf = (day) => addDays(day, -WEEK.indexOf(weekdayOf(day)));
const weekLabel = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export async function loadStats() {
  const today = planner.getToday();
  const firstMonday = addDays(mondayOf(today), -7 * (WEEKS - 1));
  const fromIso = new Date(`${firstMonday}T00:00:00`).toISOString();

  const [subjects, chapters, topics, exams, sessions, history, done, partial, missed, pending, overdue] = await Promise.all([
    db.getSubjects(), db.getChapters(), db.getTopics(), db.getExams(), db.getStudySessions(fromIso), db.getRecallHistory(),
    db.countTasks({ status: "done" }), db.countTasks({ status: "partial" }), db.countTasks({ status: "missed" }),
    db.countTasks({ status: "pending" }), db.countTasks({ status: "pending", before: today }),
  ]);

  // ----- Weeks -----
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const start = addDays(firstMonday, 7 * i);
    return { start, end: addDays(start, 6), label: weekLabel(start), minutes: 0, recalls: { done: 0, partial: 0, missed: 0 } };
  });
  const weekOf = (day) => {
    const i = Math.floor(diffDays(day, firstMonday) / 7);
    return i >= 0 && i < WEEKS ? weeks[i] : null;
  };
  for (const s of sessions) {
    const w = weekOf(toLocalDay(s.ended_at));
    if (w) w.minutes += s.duration_minutes || 0;
  }
  for (const h of history) {
    const w = weekOf(toLocalDay(h.recalled_at));
    if (w && w.recalls[h.result] !== undefined) w.recalls[h.result] += 1;
  }

  // ----- Topics per subject (studied once it has been studied, recalled once a recall passed) -----
  const chapterById = new Map(chapters.map((c) => [c.id, c]));
  const bySubject = new Map(subjects.map((s) => [s.id, { id: s.id, name: s.name, total: 0, studied: 0, recalled: 0 }]));
  const rows = [];
  for (const t of topics) {
    const subjectId = chapterById.get(t.chapter_id)?.subject_id;
    const entry = bySubject.get(subjectId);
    if (!entry) continue;
    const studied = Boolean(t.last_studied_at);
    const recalled = studied && (t.recall_stage ?? 0) >= 1;
    entry.total += 1;
    if (studied) entry.studied += 1;
    if (recalled) entry.recalled += 1;
    rows.push({ id: t.id, subjectId, difficulty: t.difficulty, stage: t.recall_stage ?? 0, studied, recalled,
                studiedDay: studied ? toLocalDay(t.last_studied_at) : null });
  }
  const subjectStats = [...bySubject.values()].sort((a, b) => a.name.localeCompare(b.name));
  const total = rows.length;
  const studied = rows.filter((r) => r.studied).length;
  const recalled = rows.filter((r) => r.recalled).length;

  // ----- Trend: cumulative counts at the end of each week -----
  const exists = new Set(rows.map((r) => r.id));
  const firstSuccess = new Map(); // topic -> day of its first successful recall (history is oldest first)
  for (const h of history) {
    if (h.result === "done" && exists.has(h.topic_id) && !firstSuccess.has(h.topic_id)) firstSuccess.set(h.topic_id, toLocalDay(h.recalled_at));
  }
  const trend = weeks.map((w) => {
    const cutoff = w.end < today ? w.end : today;
    return {
      label: w.label,
      studied: rows.filter((r) => r.studiedDay && r.studiedDay <= cutoff).length,
      recalled: [...firstSuccess.values()].filter((day) => day <= cutoff).length,
    };
  });

  return {
    today, weeks, trend, subjects: subjectStats,
    topics: { total, studied, recalled },
    tasks: { done, partial, missed, overdue, upcoming: Math.max(0, pending - overdue) },
    minutesThisWeek: weeks.at(-1).minutes,
    recalls: { doneTotal: history.filter((h) => h.result === "done").length, doneThisWeek: weeks.at(-1).recalls.done },
    hard: {
      notStudied: rows.filter((r) => r.difficulty === "hard" && !r.studied).length,
      earlyRecall: rows.filter((r) => r.difficulty === "hard" && r.studied && r.stage < 3).length,
    },
    exams: exams.map((e) => ({ date: toLocalDay(e.exam_date), subjectName: subjects.find((s) => s.id === e.subject_id)?.name ?? "" }))
      .filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
