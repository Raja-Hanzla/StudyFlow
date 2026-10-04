// Run with:  node tests/scheduler.test.mjs      (Node 22 or newer)
import assert from "node:assert/strict";
import { calculateNextRecall, generateSchedule, applyResult, diffSchedule, rescheduleMissedTasks, addDays } from "../js/scheduler.js";

const today = "2026-10-05"; // a Monday
const topic = (id, o = {}) => ({ id, chapterId: "c", subjectId: "s1", chapterNumber: 1, name: id, difficulty: "medium",
  priority: "normal", minutes: 30, studied: false, stage: 0, nextRecallDay: null, ...o });
const subj = (o = {}) => ({ id: "s1", name: "Physics", dailyMinutes: 60, topicsPerDay: 1, ...o });
const snap = (topics, o = {}) => ({ today, subjects: [subj()], exams: [], topics, tasks: [], ...o });
const task = (o) => ({ id: "k" + Math.random(), subjectId: "s1", minutes: 30, ...o });
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

const on = (res, type, day) => res.planned.filter((p) => p.type === type && p.date === day);
const day = (n) => addDays(today, n);

// Subject time: 3 topics a day share 60 minutes (20 each), the rest follow on the next days
const ten = Array.from({ length: 10 }, (_, i) => topic("t" + i));
const three = generateSchedule(snap(ten, { subjects: [subj({ topicsPerDay: 3 })] }));
assert.equal(on(three, "study", today).length, 3);
assert.deepEqual(on(three, "study", today).map((p) => p.minutes), [20, 20, 20]);
assert.equal(on(three, "study", day(3)).length, 1);          // 10 topics = 3 + 3 + 3 + 1
assert.equal(three.planned.filter((p) => p.type === "study").length, 10);

// Order inside a subject: high priority and hard topics first, then chapter order
const mixed = [topic("easy", { difficulty: "easy", priority: "low" }), topic("hard", { difficulty: "hard", priority: "high" })];
assert.equal(on(generateSchedule(snap(mixed)), "study", today)[0].topicId, "hard");

// One topic a day gets the whole subject time; two subjects both get their own time on the same day
const two = generateSchedule(snap([topic("p1"), topic("c1", { subjectId: "s2" })],
  { subjects: [subj(), subj({ id: "s2", name: "Chemistry", dailyMinutes: 45, topicsPerDay: 1 })] }));
assert.equal(on(two, "study", today).length, 2);
assert.equal(on(two, "study", today).find((p) => p.topicId === "p1").minutes, 60);
assert.equal(on(two, "study", today).find((p) => p.topicId === "c1").minutes, 45);

// Marking the subject done today uses its quota: next topics start tomorrow
const doneToday = generateSchedule(snap([topic("a", { studied: true, nextRecallDay: day(1) }), topic("b"), topic("c")],
  { tasks: [task({ topicId: "a", type: "study", date: today, status: "done" })] }));
assert.equal(on(doneToday, "study", today).length, 0);
assert.equal(on(doneToday, "study", day(1)).length, 1);
assert.equal(on(doneToday, "study", day(1))[0].topicId, "b");
// ...but with 2 topics a day, one more fits today (and shares the time with the finished one)
const room = generateSchedule(snap([topic("a", { studied: true, nextRecallDay: day(1) }), topic("b")],
  { subjects: [subj({ topicsPerDay: 2 })], tasks: [task({ topicId: "a", type: "study", date: today, status: "done" })] }));
assert.deepEqual(on(room, "study", today).map((p) => [p.topicId, p.minutes]), [["b", 30]]);

// Recalls: no time, no limit — all 40 due today are scheduled today
const many = Array.from({ length: 40 }, (_, i) => topic("r" + i, { studied: true, stage: 1, nextRecallDay: today }));
const lots = generateSchedule(snap(many));
assert.equal(on(lots, "recall", today).length, 40);
assert.ok(on(lots, "recall", today).every((p) => p.minutes === 0));
// ...and they never use up the study time
const withStudy = generateSchedule(snap([...many, topic("new")]));
assert.equal(on(withStudy, "study", today).length, 1);

// Deterministic
assert.deepEqual(generateSchedule(snap(ten)), generateSchedule(snap(ten)));

// No work on or after the exam; overdue recall is placed today
const exam = snap([topic("a", { studied: true, nextRecallDay: addDays(today, -3), stage: 1 }), topic("b")],
  { exams: [{ subjectId: "s1", date: addDays(today, 3) }] });
const examPlan = generateSchedule(exam);
assert.ok(examPlan.planned.every((p) => p.date < addDays(today, 3)));
assert.equal(on(examPlan, "recall", today)[0].topicId, "a");
// Not enough days before the exam at this pace -> a note
const crunch = generateSchedule(snap(ten, { exams: [{ subjectId: "s1", date: day(4) }] }));
assert.ok(crunch.notes.some((n) => n.kind === "workload" && n.text.includes("Physics")));
assert.equal(crunch.planned.filter((p) => p.type === "study").length, 4);   // days 0..3, one topic each

// Partial study today is not offered again today (and counts as today's session)
const retry = generateSchedule(snap([topic("x")], { tasks: [task({ topicId: "x", type: "study", date: today, status: "partial" })] }));
assert.equal(retry.planned[0].date, day(1));

// Study done -> first recall tomorrow; diff keeps unchanged rows
const r = applyResult({ topic: topic("x"), type: "study", result: "done", today, examDate: null, nowIso: "2026-10-05T08:00:00Z" });
assert.equal(r.topicPatch.next_recall_at, "2026-10-06T12:00:00Z");
const d = diffSchedule([{ id: "1", topicId: "a", type: "study", date: today, minutes: 30 }], [{ topicId: "a", type: "study", date: today, minutes: 30 }]);
assert.deepEqual([d.insert.length, d.update.length, d.remove.length], [0, 0, 0]);

// Old pending tasks count as missed
assert.equal(rescheduleMissedTasks([{ id: "o", status: "pending", date: addDays(today, -3) }, { id: "n", status: "pending", date: addDays(today, -1) }], today).length, 1);

console.log("All scheduler checks passed.");
