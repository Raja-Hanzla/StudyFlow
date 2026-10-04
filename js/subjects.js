// Subjects page.   #/subjects            -> list of subjects
//                  #/subjects/<id>       -> one subject: chapters and topics
import * as db from "./database.js";
import { parseTopicLines } from "./bulk.js";
import { openForm, confirmDialog, withSaving, tracked, errorCard } from "./ui.js";
import { refreshSchedule } from "./planner.js";
import { showToast } from "./utils.js";
import { escapeHtml, freshRoot, refreshIcons, daysUntil, formatShortDate } from "./utils.js";
import { DIFFICULTIES, PRIORITIES, SUBJECT_COLORS, DEFAULT_DIFFICULTY, DEFAULT_PRIORITY } from "./constants.js";

// ---------- Small helpers ----------
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");
const statusLabel = (s) => cap(String(s || "").replace(/_/g, " ")) || "—";
const options = (list, selected) =>
  list.map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>${cap(v)}</option>`).join("");

/** "60 min a day · 2 topics a day" */
const planText = (s) => `${s.daily_minutes ?? 60} min a day · ${s.topics_per_day ?? 1} topic${(s.topics_per_day ?? 1) === 1 ? "" : "s"} a day`;

/** A subject's "main" exam: the next upcoming one, otherwise the most recent. */
function pickExam(exams) {
  const sorted = [...exams].sort((a, b) => a.exam_date.localeCompare(b.exam_date));
  return sorted.find((e) => daysUntil(e.exam_date) >= 0) || sorted.at(-1) || null;
}
function examText(exam) {
  if (!exam) return "No exam date set";
  const days = daysUntil(exam.exam_date);
  const when = formatShortDate(exam.exam_date);
  if (days > 0) return `Exam ${when} · ${days} day${days === 1 ? "" : "s"} remaining`;
  if (days === 0) return `Exam today (${when})`;
  return `Exam was on ${when}`;
}


// ---------- Entry point (called by the router) ----------
export function renderSubjects(container, params = []) {
  const el = document.createElement("div"); // fresh element each time, so listeners never pile up
  container.replaceChildren(el);
  return params[0] ? showSubject(el, params[0]) : showList(el);
}

// =====================================================================
// Subject list
// =====================================================================
async function showList(el) {
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;
  let subjects, exams, chapters, topics;
  try {
    [subjects, exams, chapters, topics] = await Promise.all([
      db.getSubjects(), db.getExams(), db.getChapters(), db.getTopics(),
    ]);
  } catch (err) {
    return errorCard(el, "Couldn't load your subjects.", err, () => showList(el));
  }

  const cards = subjects.map((s) => {
    const chapterIds = new Set(chapters.filter((c) => c.subject_id === s.id).map((c) => c.id));
    const subjectTopics = topics.filter((t) => chapterIds.has(t.chapter_id));
    const studied = subjectTopics.filter((t) => t.last_studied_at).length;
    const percent = subjectTopics.length ? Math.round((studied / subjectTopics.length) * 100) : 0;
    const exam = pickExam(exams.filter((e) => e.subject_id === s.id));
    return `
      <a class="subject-card" href="#/subjects/${escapeHtml(s.id)}" style="--subject:${escapeHtml(s.color || "#3b5bdb")}">
        <h2><span class="subject-dot"></span>${escapeHtml(s.name)}</h2>
        <p class="muted">${escapeHtml(examText(exam))}</p>
        <p class="muted">${chapterIds.size} chapter(s) · ${subjectTopics.length} topic(s)</p>
        <p class="muted small">${planText(s)}</p>
        <div class="progress" role="progressbar" aria-label="Topics studied" aria-valuemin="0"
             aria-valuemax="${subjectTopics.length}" aria-valuenow="${studied}"><span style="width:${percent}%"></span></div>
        <p class="muted small">${studied} of ${subjectTopics.length} topics studied at least once</p>
      </a>`;
  });

  el.innerHTML = `
    <div class="section-head"><h2>Your subjects</h2>
      <button class="btn btn-primary" data-action="add-subject">Add subject</button></div>
    ${subjects.length ? `<div class="subject-grid">${cards.join("")}</div>`
      : `<section class="card"><p>No subjects added yet.</p></section>`}`;

  el.querySelector("[data-action=add-subject]").addEventListener("click", () =>
    subjectForm({ existing: subjects, exam: null, subject: null, refresh: () => showList(el) }));
}

/** Add or edit a subject (with its exam date). */
function subjectForm({ subject, exam, existing, refresh }) {
  let createdId = null; // remembers a subject we already created, so a retry can't duplicate it
  openForm({
    title: subject ? "Edit subject" : "Add subject",
    fields: [
      { name: "name", label: "Subject name", value: subject?.name || "" },
      { name: "color", label: "Color", type: "color", value: subject?.color || SUBJECT_COLORS[existing.length % SUBJECT_COLORS.length] },
      { name: "examDate", label: "Exam date (optional)", type: "date", value: exam?.exam_date || "" },
      { name: "dailyMinutes", label: "Study time per day for this subject (minutes)", type: "number", attrs: 'min="5" max="720" step="5"', value: subject?.daily_minutes ?? 60 },
      { name: "topicsPerDay", label: "New topics per day (they share that time)", type: "number", attrs: 'min="1" max="20" step="1"', value: subject?.topics_per_day ?? 1 },
    ],
    onSubmit: async (v) => {
      const name = v.name.trim();
      if (!name) throw new Error("Enter a subject name.");
      if (existing.some((s) => s.id !== subject?.id && s.name.toLowerCase() === name.toLowerCase()))
        throw new Error("You already have a subject with that name.");
      const dailyMinutes = Number(v.dailyMinutes);
      const topicsPerDay = Number(v.topicsPerDay);
      if (!Number.isInteger(dailyMinutes) || dailyMinutes < 5 || dailyMinutes > 720) throw new Error("Study time per day must be between 5 and 720 minutes.");
      if (!Number.isInteger(topicsPerDay) || topicsPerDay < 1 || topicsPerDay > 20) throw new Error("Topics per day must be between 1 and 20.");
      await tracked(async () => {
        if (subject) await db.updateSubject(subject.id, { name, color: v.color, daily_minutes: dailyMinutes, topics_per_day: topicsPerDay });
        else if (!createdId) createdId = (await db.createSubject({ name, color: v.color, dailyMinutes, topicsPerDay })).id;
        await db.saveExamDate({ subjectId: subject?.id ?? createdId, subjectName: name, examId: exam?.id ?? null, examDate: v.examDate });
      });
      showToast(subject ? "Subject updated." : "Subject added.");
      refresh();
    },
  });
}

// =====================================================================
// One subject: chapters and topics
// =====================================================================
async function showSubject(host, subjectId) {
  const el = freshRoot(host); // new element per draw, so click handlers never stack up
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;
  let subject, exams, chapters, topics;
  try {
    [subject, exams, chapters] = await Promise.all([db.getSubject(subjectId), db.getExams(subjectId), db.getChapters(subjectId)]);
    topics = subject ? await db.getTopics(chapters.map((c) => c.id)) : [];
  } catch (err) {
    return errorCard(el, "Couldn't load this subject.", err, () => showSubject(host, subjectId));
  }
  if (!subject) {
    el.innerHTML = `<section class="card"><p>This subject doesn't exist.</p><a href="#/subjects">Back to subjects</a></section>`;
    return;
  }

  // After any change the schedule is rebuilt in the background, then the page redraws.
  const refresh = () => {
    refreshSchedule().catch(() => showToast("Couldn't update your schedule. It will retry next time you open the app."));
    showSubject(host, subjectId);
  };
  const exam = pickExam(exams);
  const topicsOf = (chapterId) => topics.filter((t) => t.chapter_id === chapterId);
  const topicById = (id) => topics.find((t) => t.id === id);
  const chapterById = (id) => chapters.find((c) => c.id === id);

  el.innerHTML = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="#/subjects">Subjects</a> / ${escapeHtml(subject.name)}</nav>
    <section class="card subject-head" style="--subject:${escapeHtml(subject.color || "#3b5bdb")}">
      <div><h2><span class="subject-dot"></span>${escapeHtml(subject.name)}</h2>
        <p class="muted">${escapeHtml(examText(exam))}</p>
        <p class="muted">${planText(subject)}</p></div>
      <div class="head-actions">
        <button class="btn" data-action="edit-subject">Edit subject</button>
        <button class="btn btn-danger" data-action="delete-subject">Delete subject</button>
      </div>
    </section>
    <div class="section-head"><h2>Chapters</h2>
      <button class="btn btn-primary" data-action="add-chapter">Add chapter</button></div>
    ${chapters.length ? chapters.map((c) => chapterHtml(c, topicsOf(c.id))).join("")
      : `<section class="card"><p>No chapters yet.</p></section>`}`;
  refreshIcons();

  // ----- Clicks -----
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const chapterId = btn.closest("[data-chapter]")?.dataset.chapter;
    const topicId = btn.closest("[data-topic]")?.dataset.topic;
    const action = btn.dataset.action;

    if (action === "edit-subject") subjectForm({ subject, exam, existing: [subject], refresh });
    if (action === "delete-subject") deleteSubject();
    if (action === "add-chapter") chapterForm(null);
    if (action === "edit-chapter") chapterForm(chapterById(chapterId));
    if (action === "delete-chapter") deleteChapter(chapterById(chapterId));
    if (action === "add-topic") topicForm(null, chapterId);
    if (action === "edit-topic") topicForm(topicById(topicId), chapterId);
    if (action === "bulk-topics") bulkForm(chapterId);
    if (action === "delete-topic") deleteTopic(topicById(topicId));
  });

  // ----- Difficulty / priority dropdowns save as soon as they change -----
  el.addEventListener("change", (e) => {
    const select = e.target.closest("select[data-field]");
    if (!select) return;
    const topic = topicById(select.closest("[data-topic]").dataset.topic);
    const { field } = select.dataset;
    const value = select.value;
    withSaving(() => db.updateTopic(topic.id, { [field]: value }), () => { topic[field] = value; });
  });

  // ----- Forms and deletes -----
  function chapterForm(chapter) {
    const nextNumber = Math.max(0, ...chapters.map((c) => c.chapter_number || 0)) + 1;
    openForm({
      title: chapter ? "Edit chapter" : "Add chapter",
      fields: [
        { name: "name", label: "Chapter name", value: chapter?.name || "" },
        { name: "number", label: "Chapter number", type: "number", attrs: 'min="1"', value: chapter?.chapter_number ?? nextNumber },
      ],
      onSubmit: async (v) => {
        const name = v.name.trim();
        const number = Number(v.number);
        if (!name) throw new Error("Enter a chapter name.");
        if (!Number.isInteger(number) || number < 1) throw new Error("Chapter number must be 1 or higher.");
        await tracked(() => chapter
          ? db.updateChapter(chapter.id, { name, chapter_number: number })
          : db.createChapter({ subjectId, name, chapterNumber: number }));
        showToast(chapter ? "Chapter updated." : "Chapter added.");
        refresh();
      },
    });
  }

  function topicForm(topic, chapterId) {
    openForm({
      title: topic ? "Edit topic" : "Add topic",
      fields: [
        { name: "name", label: "Topic name", value: topic?.name || "" },
        { name: "difficulty", label: "Difficulty", type: "select", options: DIFFICULTIES, value: topic?.difficulty || DEFAULT_DIFFICULTY },
        { name: "priority", label: "Priority", type: "select", options: PRIORITIES, value: topic?.priority || DEFAULT_PRIORITY },
      ],
      onSubmit: async (v) => {
        const name = v.name.trim();
        if (!name) throw new Error("Enter a topic name.");
        await tracked(() => topic
          ? db.updateTopic(topic.id, { name, difficulty: v.difficulty, priority: v.priority })
          : db.createTopics(chapterId, [{ name, difficulty: v.difficulty, priority: v.priority }]));
        showToast(topic ? "Topic updated." : "Topic added.");
        refresh();
      },
    });
  }

  function bulkForm(chapterId) {
    const existing = new Set(topicsOf(chapterId).map((t) => t.name.toLowerCase()));
    const parse = (v) => parseTopicLines(v.text || "", v).filter((t) => !existing.has(t.name.toLowerCase()));
    openForm({
      title: "Add many topics",
      intro: "Paste one topic per line. To set one topic's values, write <code>Velocity | hard | high</code>.",
      submitLabel: "Add topics",
      fields: [
        { name: "text", label: "Topics", type: "textarea", rows: 8 },
        { name: "difficulty", label: "Default difficulty", type: "select", options: DIFFICULTIES, value: DEFAULT_DIFFICULTY },
        { name: "priority", label: "Default priority", type: "select", options: PRIORITIES, value: DEFAULT_PRIORITY },
      ],
      onInput: (v) => { const n = parse(v).length; return n ? `${n} topic(s) will be added.` : ""; },
      onSubmit: async (v) => {
        const list = parse(v);
        if (!list.length) throw new Error("Add at least one new topic.");
        await tracked(() => db.createTopics(chapterId, list));
        showToast(list.length === 1 ? "Topic added." : `${list.length} topics added.`);
        refresh();
      },
    });
  }

  async function deleteTopic(topic) {
    if (!await confirmDialog({ title: "Delete topic?", message: `“${topic.name}” and its schedule will be removed.` })) return;
    withSaving(() => db.deleteTopic(topic.id), () => { showToast("Topic deleted."); refresh(); });
  }
  async function deleteChapter(chapter) {
    const n = topicsOf(chapter.id).length;
    if (!await confirmDialog({ title: "Delete chapter?", message: `“${chapter.name}” and its ${n} topic(s) will be removed.` })) return;
    withSaving(() => db.deleteChapter(chapter.id), () => { showToast("Chapter deleted."); refresh(); });
  }
  async function deleteSubject() {
    const message = `“${subject.name}” with ${chapters.length} chapter(s) and ${topics.length} topic(s) will be removed. This can't be undone.`;
    if (!await confirmDialog({ title: "Delete subject?", message })) return;
    withSaving(() => db.deleteSubject(subject.id), () => {
      showToast("Subject deleted.");
      refreshSchedule().catch(() => {});
      location.hash = "#/subjects";
    });
  }
}

// ---------- HTML for one chapter and its topics ----------
function chapterHtml(chapter, topics) {
  return `
    <details class="chapter card" open data-chapter="${escapeHtml(chapter.id)}">
      <summary><strong>Chapter ${chapter.chapter_number ?? ""} — ${escapeHtml(chapter.name)}</strong>
        <span class="muted small">${topics.length} topic(s)</span></summary>
      <div class="toolbar">
        <button class="btn" data-action="add-topic">Add topic</button>
        <button class="btn" data-action="bulk-topics">Add many topics</button>
        <button class="btn" data-action="edit-chapter">Edit chapter</button>
        <button class="btn btn-danger" data-action="delete-chapter">Delete chapter</button>
      </div>
      ${topics.length ? topics.map(topicHtml).join("") : `<p class="muted">No topics in this chapter yet.</p>`}
    </details>`;
}

function topicHtml(t) {
  const studied = t.last_studied_at ? `Studied ${formatShortDate(t.last_studied_at)}` : "Not studied yet";
  const overdue = t.next_recall_at && daysUntil(t.next_recall_at) < 0;
  const recall = t.next_recall_at
    ? `Next recall: ${formatShortDate(t.next_recall_at)}${overdue ? " (overdue)" : ""}` : "No recall scheduled";
  const id = escapeHtml(t.id);
  return `
    <div class="topic-row" data-topic="${id}">
      <div class="topic-main"><strong>${escapeHtml(t.name)}</strong>
        <span class="muted small">${escapeHtml(statusLabel(t.status))} · ${studied}</span></div>
      <label class="sr-only" for="df-${id}">Difficulty</label>
      <select id="df-${id}" data-field="difficulty">${options(DIFFICULTIES, t.difficulty)}</select>
      <label class="sr-only" for="pr-${id}">Priority</label>
      <select id="pr-${id}" data-field="priority">${options(PRIORITIES, t.priority)}</select>
      <span class="topic-recall small ${overdue ? "overdue" : "muted"}">${recall}</span>
      <button class="btn" data-action="edit-topic" aria-label="Edit topic ${escapeHtml(t.name)}">Edit</button>
      <button class="btn btn-danger" data-action="delete-topic" aria-label="Delete topic ${escapeHtml(t.name)}">Delete</button>
    </div>`;
}
