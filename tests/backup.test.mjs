// Run with:  node tests/backup.test.mjs
import assert from "node:assert/strict";
import { buildBackup, validateBackup, prepareImport, summarize } from "../js/backup.js";

const raw = {
  profile: { id: "u1", full_name: "Sam", class_name: "Grade 10", daily_study_minutes: 60 },
  settings: { user_id: "u1", daily_study_minutes: 60, monday_minutes: 30, tuesday_minutes: null, dark_mode: true },
  subjects: [{ id: "s1", user_id: "u1", name: "Physics", color: "#3b5bdb" }],
  exams: [{ id: "e1", user_id: "u1", subject_id: "s1", name: "Physics exam", exam_date: "2026-12-01" }],
  chapters: [{ id: "c1", user_id: "u1", subject_id: "s1", name: "Motion", chapter_number: 2 }],
  topics: [{ id: "t1", user_id: "u1", chapter_id: "c1", name: "Velocity", difficulty: "hard", priority: "high", status: null,
             estimated_minutes: 30, last_studied_at: "2026-10-01T10:00:00+00:00", next_recall_at: "2026-10-02T12:00:00+00:00", recall_stage: 1 }],
  tasks: [{ id: "k1", user_id: "u1", topic_id: "t1", task_type: "recall", scheduled_date: "2026-10-02", estimated_minutes: 10, status: "pending", completed_at: null }],
  recallHistory: [{ id: "h1", user_id: "u1", topic_id: "t1", task_id: "k1", result: "done", recall_stage: 1, recalled_at: "2026-10-02T09:00:00Z" }],
  studySessions: [{ id: "x1", user_id: "u1", topic_id: "t1", started_at: "2026-10-01T09:30:00Z", ended_at: "2026-10-01T10:00:00Z", duration_minutes: 30 }],
};

// Round trip: export -> JSON text -> validate
const file = JSON.parse(JSON.stringify(buildBackup(raw, "2026-10-03T00:00:00Z")));
assert.ok(!JSON.stringify(file).includes("u1"), "the file must not contain the user id");
const result = validateBackup(file);
assert.ok(result.ok, result.errors.join("; "));
assert.deepEqual(summarize(result.backup), { subjects: 1, chapters: 1, topics: 1, tasks: 1, recalls: 1, sessions: 1 });

// Preparing: new ids, links kept, rows belong to the new user
let n = 0;
const plan = prepareImport(result.backup, "NEW", () => `id${++n}`);
assert.equal(plan.subjects[0].user_id, "NEW");
assert.notEqual(plan.subjects[0].id, "s1");
assert.equal(plan.chapters[0].subject_id, plan.subjects[0].id);
assert.equal(plan.topics[0].chapter_id, plan.chapters[0].id);
assert.equal(plan.tasks[0].topic_id, plan.topics[0].id);
assert.equal(plan.recallHistory[0].task_id, plan.tasks[0].id);
assert.equal(plan.studySessions[0].topic_id, plan.topics[0].id);
assert.ok(!("status" in plan.topics[0]), "null values are left out so database defaults apply");
assert.equal(plan.settings.monday_minutes, 30);
assert.ok(!("tuesday_minutes" in plan.settings));

// Rejections: nothing malformed gets through
const bad = (change) => { const f = structuredClone(file); change(f.data, f); return validateBackup(f); };
assert.ok(!validateBackup({ hello: 1 }).ok);
assert.ok(!validateBackup(null).ok);
assert.ok(!bad((d, f) => { f.version = 99; }).ok);
assert.ok(!bad((d) => { d.topics[0].difficulty = "extreme"; }).ok);
assert.ok(!bad((d) => { d.topics[0].chapter_id = "nope"; }).ok);
assert.ok(!bad((d) => { d.tasks[0].status = "finished"; }).ok);
assert.ok(!bad((d) => { d.subjects.push({ ...d.subjects[0] }); }).ok);
assert.ok(!bad((d) => { d.exams[0].exam_date = "soon"; }).ok);
assert.ok(!bad((d) => { d.settings.dark_mode = "yes"; }).ok);
assert.ok(!bad((d) => { delete d.recallHistory; }).ok);
assert.ok(bad((d) => { d.recallHistory[0].task_id = "gone"; }).ok, "a missing task link is dropped, not fatal");
console.log("All backup checks passed.");
