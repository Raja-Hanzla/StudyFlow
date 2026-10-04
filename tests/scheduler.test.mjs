// Run with:  node tests/scheduler.test.mjs      (Node 22 or newer)
import assert from "node:assert/strict";
import { calculateNextRecall, generateSchedule, applyResult, diffSchedule, rescheduleMissedTasks, addDays } from "../js/scheduler.js";

const today = "2026-10-05"; // a Monday
const topic = (id, o = {}) => ({ id, chapterId: "c", subjectId: "s1", chapterNumber: 1, name: id, difficulty: "medium",
  priority: "normal", minutes: 30, studied: false, stage: 0, nextRecallDay: null, ...o });
const snap = (topics, o = {}) => ({ today, subjects: [{ id: "s1", name: "Physics" }], exams: [], topics, tasks: [],
  capacity: {}, defaultMinutes: 60, ...o });
const perDay = (planned) => planned.reduce((m, p) => ({ ...m, [p.date]: (m[p.date] ?? 0) + p.minutes }), {});

// Spaced repetition
assert.equal(calculateNextRecall({ result: "studied", stage: 0, difficulty: "medium", today }).nextDay, addDays(today, 1));
const done = calculateNextRecall({ result: "done", stage: 0, difficulty: "medium", today });
assert.deepEqual([done.stage, done.gapDays], [1, 3]);
assert.equal(calculateNextRecall({ result: "done", stage: 2, difficulty: "medium", today }).gapDays, 14);
assert.ok(calculateNextRecall({ result: "done", stage: 1, difficulty: "hard", today }).gapDays <
          calculateNextRecall({ result: "done", stage: 1, difficulty: "easy", today }).gapDays);
const partial = calculateNextRecall({ result: "partial", stage: 2, difficulty: "medium", today });
assert.deepEqual([partial.stage, partial.gapDays], [2, 4]);
const missed = calculateNextRecall({ result: "missed", stage: 2, difficulty: "medium", today });
assert.deepEqual([missed.stage, missed.gapDays], [1, 1]);

// Exam override: never after the day before the exam
const clamped = calculateNextRecall({ result: "done", stage: 3, difficulty: "medium", today, examDate: addDays(today, 5) });
assert.ok(clamped.nextDay <= addDays(today, 4));
assert.equal(calculateNextRecall({ result: "done", stage: 3, difficulty: "medium", today, examDate: addDays(today, 1) }).nextDay, null);

// Capacity: 10 topics x 30 min, 60 min per day -> never more than 60 per day
const ten = Array.from({ length: 10 }, (_, i) => topic("t" + i));
const plan = generateSchedule(snap(ten));
assert.ok(Object.values(perDay(plan.planned)).every((m) => m <= 60));
assert.equal(plan.planned.length, 10);

// Priority: a hard high-priority topic goes first when time is short
const mixed = [topic("easy", { difficulty: "easy", priority: "low" }), topic("hard", { difficulty: "hard", priority: "high" })];
const tight = generateSchedule(snap(mixed, { defaultMinutes: 30 }));
assert.equal(tight.planned.find((p) => p.date === today).topicId, "hard");

// Deterministic
assert.deepEqual(generateSchedule(snap(ten)), generateSchedule(snap(ten)));

// No work on or after the exam; overdue recall comes first
const exam = snap([topic("a", { studied: true, nextRecallDay: addDays(today, -3), stage: 1 }), topic("b")],
  { exams: [{ subjectId: "s1", date: addDays(today, 3) }], defaultMinutes: 30 });
const examPlan = generateSchedule(exam);
assert.ok(examPlan.planned.every((p) => p.date < addDays(today, 3)));
assert.equal(examPlan.planned.find((p) => p.date === today).topicId, "a");

// Partial study today is not offered again today
const retry = generateSchedule(snap([topic("x")], { tasks: [{ id: "k", topicId: "x", type: "study", date: today, minutes: 30, status: "partial" }] }));
assert.equal(retry.planned[0].date, addDays(today, 1));

// Study done -> first recall tomorrow; diff keeps unchanged rows
const r = applyResult({ topic: topic("x"), type: "study", result: "done", today, examDate: null, nowIso: "2026-10-05T08:00:00Z" });
assert.equal(r.topicPatch.next_recall_at, "2026-10-06T12:00:00Z");
const d = diffSchedule([{ id: "1", topicId: "a", type: "study", date: today, minutes: 30 }], [{ topicId: "a", type: "study", date: today, minutes: 30 }]);
assert.deepEqual([d.insert.length, d.update.length, d.remove.length], [0, 0, 0]);

// Old pending tasks count as missed
assert.equal(rescheduleMissedTasks([{ id: "o", status: "pending", date: addDays(today, -3) }, { id: "n", status: "pending", date: addDays(today, -1) }], today).length, 1);

console.log("All scheduler checks passed.");

// Recall has its own daily pool: 60 min of study + recalls on top, never mixed
const studied = Array.from({ length: 6 }, (_, i) => topic("r" + i, { studied: true, stage: 1, nextRecallDay: today, minutes: 30 })); // recall = 10 min each
const newOnes = Array.from({ length: 2 }, (_, i) => topic("n" + i)); // 30 min each = full 60 study
const both = generateSchedule(snap([...studied, ...newOnes], { recallMinutes: 30 }));
const dayOf = (type, d) => both.planned.filter((p) => p.type === type && p.date === d).reduce((n, p) => n + p.minutes, 0);
assert.equal(dayOf("study", today), 60, "recalls must not take study minutes");
assert.equal(dayOf("recall", today), 30, "recall pool is its own 30 minutes");
assert.ok(both.planned.filter((p) => p.type === "recall").every((p, _, a) => a.length === 6), "all 6 recalls are still planned (spilling to later days)");
assert.ok(Object.keys(perDay(both.planned.filter((p) => p.type === "recall"))).every((d) => perDay(both.planned.filter((p) => p.type === "recall"))[d] <= 30));
// Recalls already done today use up the recall pool, not the study pool
const afterRecall = generateSchedule(snap([...studied, ...newOnes], { recallMinutes: 30,
  tasks: [{ id: "x", topicId: "gone", type: "recall", date: today, minutes: 30, status: "done" }] }));
assert.equal(afterRecall.planned.filter((p) => p.type === "recall" && p.date === today).length, 0);
assert.equal(afterRecall.planned.filter((p) => p.type === "study" && p.date === today).reduce((n, p) => n + p.minutes, 0), 60);
// Recalls that can't fit before the window ends produce a note
const flood = Array.from({ length: 80 }, (_, i) => topic("f" + i, { studied: true, stage: 1, nextRecallDay: today, minutes: 60 }));
assert.ok(generateSchedule(snap(flood, { recallMinutes: 10 })).notes.some((n) => n.kind === "recall-workload"));
console.log("Recall pool checks passed.");
