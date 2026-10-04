// Calendar: a month grid with study tasks, recalls, exams and overdue work.
// Click a day to see everything on it, or click an item for its details.
import * as db from "./database.js";
import * as planner from "./planner.js";
import { addDays, diffDays, weekdayOf } from "./scheduler.js";
import { openInfo, errorCard } from "./ui.js";
import { escapeHtml, formatLongDay, freshRoot, showToast, toLocalDay } from "./utils.js";

const WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS = 3;       // items shown inside a day cell (the rest: "+N more")
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");

let month = null;          // the month on screen, "YYYY-MM" (kept while you stay in the app)

// ---------- Month maths on "YYYY-MM" strings ----------
function shiftMonth(m, delta) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthTitle(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
/** The 6 weeks (Monday first) that cover the month. */
function gridRange(m) {
  const first = `${m}-01`;
  const start = addDays(first, -WEEK.indexOf(weekdayOf(first)));
  return { start, end: addDays(start, 41) };
}

// ---------- Loading ----------
async function loadEntries(m, today) {
  const { start, end } = gridRange(m);
  const [subjects, chapters, topics, exams, rangeTasks, pendingTasks] = await Promise.all([
    db.getSubjects(), db.getChapters(), db.getTopics(), db.getExams(), db.getTasksInRange(start, end), db.getTasks(today),
  ]);
  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const chapterById = new Map(chapters.map((c) => [c.id, c]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const names = (topicId) => {
    const topic = topicById.get(topicId);
    if (!topic) return null;
    const chapter = chapterById.get(topic.chapter_id);
    const subject = subjectById.get(chapter?.subject_id);
    return { topicName: topic.name, chapterName: chapter?.name ?? "", subjectName: subject?.name ?? "",
             color: subject?.color, difficulty: topic.difficulty, priority: topic.priority };
  };

  const entries = [];
  for (const t of rangeTasks) {
    const n = names(t.topic_id);
    if (!n) continue;
    const date = toLocalDay(t.scheduled_date);
    entries.push({ kind: "task", id: t.id, date, type: t.task_type, status: t.status, minutes: t.estimated_minutes,
                   overdue: t.status === "pending" && date < today, ...n });
  }
  for (const e of exams) {
    const date = toLocalDay(e.exam_date);
    if (date < start || date > end) continue;
    const subject = subjectById.get(e.subject_id);
    entries.push({ kind: "exam", date, subjectName: subject?.name ?? "", color: subject?.color });
  }
  // Recalls that are due but not in the 14-day plan yet (shown from the stored next_recall_at).
  const hasPendingRecall = new Set(pendingTasks.filter((t) => t.status === "pending" && t.task_type === "recall").map((t) => t.topic_id));
  for (const t of topics) {
    if (!t.last_studied_at || !t.next_recall_at || hasPendingRecall.has(t.id)) continue;
    const date = toLocalDay(t.next_recall_at);
    const n = names(t.id);
    if (!n || date < today || date < start || date > end) continue;
    entries.push({ kind: "projected", date, type: "recall", status: "due", ...n });
  }

  const order = (e) => e.kind === "exam" ? 0 : e.overdue ? 1 : e.status === "pending" && e.type === "study" ? 2
    : e.status === "pending" ? 3 : e.kind === "projected" ? 4 : 5;
  entries.sort((a, b) => order(a) - order(b) || (a.topicName ?? "").localeCompare(b.topicName ?? ""));
  return entries;
}

// ---------- Small HTML pieces ----------
const chipClass = (e) => e.kind === "exam" ? "exam" : e.kind === "projected" ? "recall projected" : e.overdue ? "overdue"
  : e.status === "pending" ? e.type : e.status;           // done / partial / missed
const label = (e) => (e.kind === "exam" ? `${e.subjectName} exam` : e.topicName);
const describe = (e) => e.kind === "exam" ? `Exam: ${e.subjectName}`
  : `${cap(e.type)}${e.kind === "projected" ? " due" : ""}${e.overdue ? ", overdue" : ""}: ${e.topicName}, ${e.subjectName}${e.minutes ? `, ${e.minutes} minutes` : ""}, ${e.status}`;

const chip = (e, i) => `<button class="cal-chip ${chipClass(e)}" data-i="${i}" aria-label="${escapeHtml(describe(e))}" title="${escapeHtml(describe(e))}">${escapeHtml(label(e))}</button>`;

function detailsHtml(e, today) {
  if (e.kind === "exam") {
    const n = diffDays(e.date, today);
    return `<dl class="details"><dt>Date</dt><dd>${formatLongDay(e.date)}</dd><dt>Subject</dt><dd>${escapeHtml(e.subjectName)}</dd>
      <dt>When</dt><dd>${n > 0 ? `${n} day${n === 1 ? "" : "s"} remaining` : n === 0 ? "Today" : "This exam has passed"}</dd></dl>`;
  }
  const status = e.kind === "projected" ? "Recall due" : e.overdue ? "Overdue" : cap(e.status);
  const rows = [["Date", formatLongDay(e.date)], ["Subject", e.subjectName], ["Chapter", e.chapterName], ["Topic", e.topicName],
    ["Type", cap(e.type)], ...(e.minutes ? [["Planned time", `${e.minutes} min`]] : []),
    ["Difficulty", cap(e.difficulty)], ["Priority", cap(e.priority)], ["Status", status]];
  let footer = "";
  if (e.kind === "projected") footer = `<p class="muted small">This recall will join your daily plan when it comes within the next 14 days.</p>`;
  else if (e.status === "pending" && e.date <= today) footer = `<p><a class="btn btn-primary" href="#/session/${escapeHtml(e.id)}">Start session</a></p>`;
  else if (e.status === "pending") footer = `<p class="muted small">Scheduled for a later day. You can start it when the day comes.</p>`;
  return `<dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>${footer}`;
}

// ---------- Page ----------
export async function renderCalendar(container) {
  const host = document.createElement("div");
  container.replaceChildren(host);
  host.innerHTML = `<p class="muted">Loading your study plan...</p>`;
  // Make sure today's plan is up to date before drawing it.
  await planner.refreshSchedule().catch(() => showToast("Couldn't update your schedule. Showing what is saved."));
  return draw(host);
}

async function draw(host) {
  const today = planner.getToday();
  month ??= today.slice(0, 7);
  let entries;
  try {
    entries = await loadEntries(month, today);
  } catch (err) {
    errorCard(host, "Couldn't load your calendar.", err, () => draw(host));
    return;
  }

  const el = freshRoot(host); // new element per draw, so click handlers never stack up
  const byDay = new Map();
  entries.forEach((e, i) => byDay.set(e.date, [...(byDay.get(e.date) ?? []), i]));
  const { start } = gridRange(month);

  const cells = [];
  for (let k = 0; k < 42; k++) {
    const day = addDays(start, k);
    const idx = byDay.get(day) ?? [];
    const classes = ["cal-day", day.slice(0, 7) !== month ? "out" : "", day === today ? "today" : ""].join(" ");
    cells.push(`
      <div class="${classes}">
        <button class="cal-num" data-day="${day}" aria-label="${escapeHtml(formatLongDay(day))}, ${idx.length} item${idx.length === 1 ? "" : "s"}">${Number(day.slice(8))}</button>
        <div class="cal-items">
          ${idx.slice(0, MAX_CHIPS).map((i) => chip(entries[i], i)).join("")}
          ${idx.length > MAX_CHIPS ? `<button class="cal-more" data-day="${day}">+${idx.length - MAX_CHIPS} more</button>` : ""}
        </div>
        <div class="cal-dots" aria-hidden="true">${idx.slice(0, 4).map((i) => `<span class="dot ${chipClass(entries[i])}"></span>`).join("")}</div>
      </div>`);
  }

  el.innerHTML = `
    <div class="section-head">
      <h2 aria-live="polite">${monthTitle(month)}</h2>
      <div class="cal-nav">
        <button class="btn" data-nav="-1" aria-label="Previous month">‹</button>
        <button class="btn" data-nav="0">Today</button>
        <button class="btn" data-nav="1" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="cal-legend" aria-label="Legend">
      <span><i class="swatch study"></i>Study</span><span><i class="swatch recall"></i>Recall</span>
      <span><i class="swatch recall projected"></i>Recall due</span><span><i class="swatch exam"></i>Exam</span>
      <span><i class="swatch overdue"></i>Overdue</span><span><i class="swatch done"></i>Done</span>
    </div>
    <div class="cal-grid">
      ${SHORT.map((d) => `<div class="cal-dow">${d}</div>`).join("")}
      ${cells.join("")}
    </div>
    ${entries.length ? "" : `<p class="muted">Nothing is planned in this view yet.</p>`}`;

  const open = (i) => openInfo({ title: entries[i].kind === "exam" ? `${entries[i].subjectName} exam` : entries[i].topicName,
                                  html: detailsHtml(entries[i], today) });

  el.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]")?.dataset.nav;
    if (nav !== undefined) {
      month = nav === "0" ? today.slice(0, 7) : shiftMonth(month, Number(nav));
      draw(host);
      return;
    }
    const chipBtn = e.target.closest("[data-i]");
    if (chipBtn) return open(Number(chipBtn.dataset.i));

    const day = e.target.closest("[data-day]")?.dataset.day;
    if (!day) return;
    const idx = byDay.get(day) ?? [];
    openInfo({
      title: formatLongDay(day),
      html: idx.length
        ? `<ul class="plain">${idx.map((i) => `<li><button class="cal-chip wide ${chipClass(entries[i])}" data-i="${i}">${escapeHtml(label(entries[i]))}
            <span class="small">· ${escapeHtml(entries[i].kind === "exam" ? "Exam" : cap(entries[i].type) + (entries[i].overdue ? ", overdue" : ""))}</span></button></li>`).join("")}</ul>`
        : `<p class="muted">Nothing planned for this day.</p>`,
      onClick: (ev, close) => {
        const b = ev.target.closest("[data-i]");
        if (b) { close(); open(Number(b.dataset.i)); }
      },
    });
  });
}
