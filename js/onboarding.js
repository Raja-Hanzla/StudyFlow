// First-login setup wizard. Collects everything in a local draft, then saves
// it to Supabase in one go at the end ("Finish"). The draft remembers which
// rows are already saved (their ids), so pressing Finish again after a network
// failure never creates duplicates.
import { state } from "./state.js";
import * as db from "./database.js";
import { refreshSchedule } from "./planner.js";
import { parseTopicLines } from "./bulk.js";
import { DIFFICULTIES, PRIORITIES, SUBJECT_COLORS, DEFAULT_DIFFICULTY, DEFAULT_PRIORITY } from "./constants.js";
import { $, escapeHtml, refreshIcons, toDateString } from "./utils.js";

const STEP_NAMES = ["About you", "Subjects, exams & time", "Chapters & topics", "Review"];
const LAST = STEP_NAMES.length - 1;

let draft;   // everything the student has entered so far
let onDone;  // called after a successful save

// ---------- Draft ----------
const newChapter = () => ({ name: "", topics: "", difficulty: DEFAULT_DIFFICULTY, priority: DEFAULT_PRIORITY, id: null, topicsSaved: false });
const newSubject = () => ({ name: "", examDate: "", id: null, examId: null, dailyMinutes: 60, topicsPerDay: 1, chapters: [newChapter()] });

const draftKey = () => `studyflow-onboarding-${state.user.id}`;
const saveDraft = () => localStorage.setItem(draftKey(), JSON.stringify(draft));

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey()));
    if (saved && Array.isArray(saved.subjects)) return saved;
  } catch { /* ignore a corrupt draft */ }
  return {
    step: 0, saving: false,
    fullName: state.profile?.full_name || state.user.user_metadata?.full_name || "",
    className: "",
    subjects: [newSubject()],
  };
}

/** Copies every input marked data-f into the draft. data-s / data-c pick the subject / chapter. */
function collectFields(root) {
  root.querySelectorAll("[data-f]").forEach((el) => {
    const { f, s, c } = el.dataset;
    let target = draft;
    if (s !== undefined) target = draft.subjects[+s];
    if (c !== undefined) target = target.chapters[+c];
    target[f] = el.value;
  });
}

// ---------- Small HTML helpers ----------
const options = (list, selected) =>
  list.map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("");

const input = (id, label, attrs, value) => `
  <div class="field"><label for="${id}">${label}</label>
  <input id="${id}" value="${escapeHtml(value)}" ${attrs} /></div>`;

// ---------- Steps ----------
const steps = [
  { // 0 — About you
    render: () => `
      ${input("fullName", "Your name", 'data-f="fullName" type="text" autocomplete="name" required', draft.fullName)}
      ${input("className", "Class / year (e.g. Grade 10)", 'data-f="className" type="text" required', draft.className)}`,
    next() {
      if (!draft.fullName.trim()) throw new Error("Enter your name.");
      if (!draft.className.trim()) throw new Error("Enter your class or year.");
    },
  },

  { // 1 — Subjects and exam dates
    render: () => `
      <p class="muted">Add each subject, its exam date if you know it, and how long you will study it each day. New topics per day share that time. Recalls are extra and have no time limit.</p>
      ${draft.subjects.map((s, i) => `
        <div class="row">
          <div class="field grow"><label for="sub-${i}">Subject</label>
            <input id="sub-${i}" data-f="name" data-s="${i}" type="text" value="${escapeHtml(s.name)}" /></div>
          <div class="field"><label for="exam-${i}">Exam date (optional)</label>
            <input id="exam-${i}" data-f="examDate" data-s="${i}" type="date" min="${toDateString()}" value="${s.examDate}" /></div>
          <div class="field"><label for="min-${i}">Minutes a day</label>
            <input id="min-${i}" data-f="dailyMinutes" data-s="${i}" type="number" min="5" max="720" step="5" value="${escapeHtml(s.dailyMinutes)}" /></div>
          <div class="field"><label for="tpd-${i}">Topics a day</label>
            <input id="tpd-${i}" data-f="topicsPerDay" data-s="${i}" type="number" min="1" max="20" step="1" value="${escapeHtml(s.topicsPerDay)}" /></div>
          ${draft.subjects.length > 1
            ? `<button type="button" class="icon-btn" data-action="remove-subject" data-s="${i}" aria-label="Remove subject ${i + 1}"><i data-lucide="x"></i></button>` : ""}
        </div>`).join("")}
      <button type="button" class="btn" data-action="add-subject">Add subject</button>`,
    next() {
      draft.subjects = draft.subjects.filter((s) => s.name.trim());
      if (!draft.subjects.length) { draft.subjects = [newSubject()]; throw new Error("Add at least one subject."); }
      const names = draft.subjects.map((s) => s.name.trim().toLowerCase());
      if (new Set(names).size !== names.length) throw new Error("Each subject needs a different name.");
      draft.subjects.forEach((s) => {
        s.name = s.name.trim();
        s.dailyMinutes = Number(s.dailyMinutes);
        s.topicsPerDay = Number(s.topicsPerDay);
        if (!Number.isInteger(s.dailyMinutes) || s.dailyMinutes < 5 || s.dailyMinutes > 720)
          throw new Error(`${s.name}: minutes a day must be between 5 and 720.`);
        if (!Number.isInteger(s.topicsPerDay) || s.topicsPerDay < 1 || s.topicsPerDay > 20)
          throw new Error(`${s.name}: topics a day must be between 1 and 20.`);
      });
      if (draft.subjects.some((s) => s.examDate && s.examDate < toDateString()))
        throw new Error("An exam date is in the past. Pick a date from today onward.");
    },
  },

  { // 2 — Chapters and topics
    render: () => `
      <p class="muted">Add chapters and paste topics, one per line. Difficulty and priority apply to the whole chapter.
        To override one topic, write it like <code>Velocity | hard | high</code>.</p>
      ${draft.subjects.map((s, si) => {
        if (!s.chapters.length) s.chapters.push(newChapter());
        return `<fieldset class="subject-block"><legend>${escapeHtml(s.name)}</legend>
          ${s.chapters.map((c, ci) => `
            <div class="chapter-block">
              <div class="row">
                <div class="field grow"><label for="ch-${si}-${ci}">Chapter name</label>
                  <input id="ch-${si}-${ci}" data-f="name" data-s="${si}" data-c="${ci}" type="text" value="${escapeHtml(c.name)}" /></div>
                <div class="field"><label for="df-${si}-${ci}">Difficulty</label>
                  <select id="df-${si}-${ci}" data-f="difficulty" data-s="${si}" data-c="${ci}">${options(DIFFICULTIES, c.difficulty)}</select></div>
                <div class="field"><label for="pr-${si}-${ci}">Priority</label>
                  <select id="pr-${si}-${ci}" data-f="priority" data-s="${si}" data-c="${ci}">${options(PRIORITIES, c.priority)}</select></div>
                ${s.chapters.length > 1
                  ? `<button type="button" class="icon-btn" data-action="remove-chapter" data-s="${si}" data-c="${ci}" aria-label="Remove chapter ${ci + 1} of ${escapeHtml(s.name)}"><i data-lucide="x"></i></button>` : ""}
              </div>
              <div class="field"><label for="tp-${si}-${ci}">Topics (one per line)</label>
                <textarea id="tp-${si}-${ci}" data-f="topics" data-s="${si}" data-c="${ci}" rows="4">${escapeHtml(c.topics)}</textarea></div>
            </div>`).join("")}
          <button type="button" class="btn" data-action="add-chapter" data-s="${si}">Add chapter</button>
        </fieldset>`;
      }).join("")}`,
    next() {
      let total = 0;
      for (const s of draft.subjects) {
        s.chapters = s.chapters.filter((c) => c.name.trim() || c.topics.trim());
        for (const c of s.chapters) {
          if (!c.name.trim()) throw new Error(`A chapter in ${s.name} has topics but no name.`);
          c.name = c.name.trim();
          total += parseTopicLines(c.topics, c).length;
        }
      }
      if (total === 0) throw new Error("Add at least one topic so StudyFlow has something to schedule.");
    },
  },

  { // 3 — Review and save
    render: () => {
      const chapters = draft.subjects.reduce((n, s) => n + s.chapters.length, 0);
      const topics = draft.subjects.reduce((n, s) => n + s.chapters.reduce((m, c) => m + parseTopicLines(c.topics, c).length, 0), 0);
      const exams = draft.subjects.filter((s) => s.examDate).length;
      return `
        <ul class="summary">
          <li><strong>${escapeHtml(draft.fullName)}</strong>, ${escapeHtml(draft.className)}</li>
          <li>${draft.subjects.length} subject(s), ${exams} exam date(s)</li>
          <li>${chapters} chapter(s), ${topics} topic(s)</li>
          <li>${draft.subjects.map((s) => `${escapeHtml(s.name)}: ${s.dailyMinutes} min, ${s.topicsPerDay} topic${s.topicsPerDay === 1 ? "" : "s"} a day`).join("; ")}</li>
        </ul>
        <p id="save-progress" class="muted" role="status">${draft.saving ? "Some of your data is already saved. Press the button to finish the rest." : "Nothing is saved until you press the button."}</p>`;
    },
    next: () => finish(),
  },
];

// ---------- Saving ----------
async function finish() {
  draft.saving = true;           // from now on, Back is disabled (data may be partly saved)
  saveDraft();
  const say = (text) => { const el = $("#save-progress"); if (el) el.textContent = text; };

  say("Saving your subjects and chapters...");
  for (const [si, s] of draft.subjects.entries()) {
    if (!s.id) { s.id = (await db.createSubject({ name: s.name, color: SUBJECT_COLORS[si % SUBJECT_COLORS.length], dailyMinutes: s.dailyMinutes, topicsPerDay: s.topicsPerDay })).id; saveDraft(); }
    if (s.examDate && !s.examId) {
      s.examId = (await db.createExam({ subjectId: s.id, name: `${s.name} exam`, examDate: s.examDate })).id; saveDraft();
    }
    for (const [ci, c] of s.chapters.entries()) {
      if (!c.id) { c.id = (await db.createChapter({ subjectId: s.id, name: c.name, chapterNumber: ci + 1 })).id; saveDraft(); }
      if (!c.topicsSaved) {
        say(`Saving topics for ${s.name}...`);
        await db.createTopics(c.id, parseTopicLines(c.topics, c));
        c.topicsSaved = true; saveDraft();
      }
    }
  }
  say("Saving your settings...");
  // The profile keeps one overall figure: the subjects' daily minutes added up (kept within the allowed range).
  const dailyMinutes = Math.min(720, Math.max(10, draft.subjects.reduce((n, s) => n + s.dailyMinutes, 0)));
  await db.saveSettings({ dailyMinutes });
  // The profile is saved LAST: a saved class name means "onboarding finished".
  await db.updateProfile({ fullName: draft.fullName.trim(), className: draft.className.trim(), dailyMinutes });

  say("Building your first study plan...");
  await refreshSchedule(); // creates the first study tasks
  localStorage.removeItem(draftKey());
  onDone();
}

// ---------- Rendering ----------
function render() {
  const root = $("#auth-root");
  const percent = ((draft.step + 1) / STEP_NAMES.length) * 100;
  const isLast = draft.step === LAST;

  root.innerHTML = `
    <div class="auth-wrap"><div class="auth-card wide">
      <div class="auth-brand"><i data-lucide="book-open-check"></i><span>StudyFlow</span></div>
      <h1>${STEP_NAMES[draft.step]}</h1>
      <p class="muted">Step ${draft.step + 1} of ${STEP_NAMES.length}</p>
      <div class="progress" role="progressbar" aria-label="Setup progress" aria-valuemin="1"
           aria-valuemax="${STEP_NAMES.length}" aria-valuenow="${draft.step + 1}"><span style="width:${percent}%"></span></div>
      <form id="onboard-form" novalidate>
        ${steps[draft.step].render()}
        <p id="onboard-error" class="form-error" role="alert"></p>
        <div class="nav-row">
          ${draft.step > 0 && !draft.saving ? `<button type="button" class="btn" data-action="back">Back</button>` : "<span></span>"}
          <button type="submit" class="btn btn-primary">${isLast ? (draft.saving ? "Retry saving" : "Finish and save") : "Next"}</button>
        </div>
      </form>
    </div></div>`;
  refreshIcons();

  const form = $("#onboard-form", root);
  const errorBox = $("#onboard-error", root);

  // Buttons that change the draft and redraw the same step
  form.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    collectFields(form);
    const { action, s, c } = btn.dataset;
    if (action === "add-subject") draft.subjects.push(newSubject());
    else if (action === "remove-subject") draft.subjects.splice(+s, 1);
    else if (action === "add-chapter") draft.subjects[+s].chapters.push(newChapter());
    else if (action === "remove-chapter") draft.subjects[+s].chapters.splice(+c, 1);
    else if (action === "back") draft.step -= 1;
    saveDraft();
    render();
  });

  // Next / Finish
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.textContent = "";
    const submit = form.querySelector("button[type=submit]");
    const label = submit.textContent;
    submit.disabled = true;
    try {
      collectFields(form);
      await steps[draft.step].next();
      if (!isLast) { draft.step += 1; saveDraft(); render(); }
    } catch (err) {
      submit.disabled = false;
      submit.textContent = isLast ? "Retry saving" : label;
      errorBox.textContent = isLast
        ? `${err.message} Press the button to continue where it stopped.`
        : err.message;
    }
  });
  form.querySelector("input, select, textarea")?.focus();
}

/** Starts the wizard. opts.onDone is called once everything is saved. */
export function showOnboarding(opts) {
  onDone = opts.onDone;
  draft = loadDraft();
  draft.step = Math.min(draft.step, LAST); // an older draft may have more steps
  if (draft.saving) draft.step = LAST; // a save was interrupted: go straight to the retry screen
  render();
}
