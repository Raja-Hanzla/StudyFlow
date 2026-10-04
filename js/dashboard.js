// Dashboard: today's plan, overdue work, exam countdown, preparation, study time.
// Every number comes from Supabase (through planner.js / database.js).
import * as planner from "./planner.js";
import * as db from "./database.js";
import { diffDays } from "./scheduler.js";
import { state } from "./state.js";
import { withSaving, errorCard } from "./ui.js";
import { escapeHtml, formatLongDay, formatShortDate, freshRoot, toDateString, toLocalDay } from "./utils.js";

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");
const STATUS_LABEL = { pending: "Pending", done: "Done", partial: "Partial", missed: "Missed" };
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const DIFFICULTY_RANK = { hard: 0, medium: 1, easy: 2 };
const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Monday of the week containing `day` (as "YYYY-MM-DD"). */
function weekStart(day) {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return toDateString(date);
}

export function renderDashboard(container) {
  const host = document.createElement("div");
  container.replaceChildren(host);
  return draw(host);
}

// ---------- Small HTML pieces ----------
function taskRow(t, { actions = false, note = "", showStatus = true } = {}) {
  const id = escapeHtml(t.id);
  const name = escapeHtml(t.topicName);
  const end = actions
    ? `<div class="task-actions">
         <a class="btn" href="#/session/${id}" aria-label="Start ${name}">Start</a>
         <button class="btn" data-result="done" aria-label="Mark ${name} done">Done</button>
         <button class="btn" data-result="partial" aria-label="Mark ${name} partial">Partial</button>
         <button class="btn" data-result="missed" aria-label="Mark ${name} missed">Missed</button>
       </div>`
    : showStatus ? `<span class="small muted">${STATUS_LABEL[t.status] ?? escapeHtml(t.status)}</span>` : "";
  return `
    <li class="topic-row" data-task="${id}" style="--subject:${escapeHtml(t.color || "#3b5bdb")}">
      <div class="topic-main"><strong><span class="subject-dot"></span>${name}</strong>
        <span class="muted small">${escapeHtml(t.subjectName || "")} › ${escapeHtml(t.chapterName || "")}</span></div>
      <span class="tag tag-${t.type}">${t.type === "study" ? "Study" : "Recall"}</span>
      <span class="small">${t.minutes} min</span>
      <span class="pill" title="Difficulty">${cap(t.difficulty)}</span>
      <span class="pill" title="Priority">${cap(t.priority)} priority</span>
      ${note}${end}
    </li>`;
}

function bar(label, value, total) {
  const percent = total ? Math.round((value / total) * 100) : 0;
  return `
    <p class="bar-label"><span>${label}</span><span>${value} of ${total} (${percent}%)</span></p>
    <div class="progress" role="progressbar" aria-label="${label}" aria-valuemin="0"
         aria-valuemax="${total}" aria-valuenow="${value}"><span style="width:${percent}%"></span></div>`;
}

// ---------- Page ----------
async function draw(host) {
  const el = freshRoot(host); // new element per draw, so click handlers never stack up
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;
  let result, view, sessions;
  try {
    result = await planner.refreshSchedule();           // rebuild today's plan first
    const today = planner.getToday();
    const fromIso = new Date(`${weekStart(today)}T00:00:00`).toISOString();
    [view, sessions] = await Promise.all([planner.loadView(), db.getStudySessions(fromIso)]);
  } catch (err) {
    errorCard(el, "Couldn't load your study plan.", err, () => draw(host));
    return;
  }

  const { today, tasks, exams, stats, capacityToday } = view;
  const importance = (t) => PRIORITY_RANK[t.priority] * 3 + DIFFICULTY_RANK[t.difficulty];
  const overdue = tasks.filter((t) => t.status === "pending" && t.date < today).sort((a, b) => a.date.localeCompare(b.date));
  const todays = tasks.filter((t) => t.date === today)
    .sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || importance(a) - importance(b));
  const upcomingRecalls = tasks.filter((t) => t.status === "pending" && t.type === "recall" && t.date > today).slice(0, 6);

  const plannedToday = todays.reduce((n, t) => n + t.minutes, 0) + overdue.reduce((n, t) => n + t.minutes, 0);
  const todayMinutes = sessions.filter((s) => toLocalDay(s.ended_at) === today).reduce((n, s) => n + (s.duration_minutes || 0), 0);
  const weekMinutes = sessions.reduce((n, s) => n + (s.duration_minutes || 0), 0);
  const firstName = (state.profile?.full_name || state.user?.user_metadata?.full_name || "").split(" ")[0];

  // ----- Exam countdown -----
  const examHtml = (() => {
    if (!exams.length) return `<p>No exam dates set.</p><p class="muted small">Add one on the <a href="#/subjects">Subjects</a> page.</p>`;
    const line = (e) => {
      const n = diffDays(e.date, today);
      return `${escapeHtml(e.subjectName)} exam — ${n === 0 ? "today" : plural(n, "day") + " remaining"}`;
    };
    const [next, ...later] = exams;
    return `<p class="stat-big">${line(next)}</p><p class="muted small">${formatShortDate(next.date)}</p>
      ${later.slice(0, 2).map((e) => `<p class="muted small">Then: ${line(e)}</p>`).join("")}`;
  })();

  const doneToday = todays.length > 0 && todays.every((t) => t.status !== "pending");
  const noTopics = stats.total === 0;

  el.innerHTML = `
    <header class="dash-head">
      <h2>${firstName ? `Hello, ${escapeHtml(firstName)}` : "Hello"}</h2>
      <p class="muted">${formatLongDay(today)}</p>
    </header>

    ${result.notes.map((n) => `<p class="notice" role="status">${escapeHtml(n.text)}</p>`).join("")}

    <div class="summary-grid">
      <section class="card"><h2>Next exam</h2>${examHtml}</section>
      <section class="card"><h2>Overall preparation</h2>
        ${noTopics ? `<p>No topics added yet.</p><p class="muted small">Add some on the <a href="#/subjects">Subjects</a> page.</p>`
          : bar("Topics studied", stats.studied, stats.total) + bar("Recalled at least once", stats.recalled, stats.total)}
      </section>
      <section class="card"><h2>Study time</h2>
        <p class="stat-big">${fmtMinutes(todayMinutes)}</p><p class="muted small">today</p>
        <p class="muted small">${fmtMinutes(weekMinutes)} this week</p>
      </section>
    </div>

    ${overdue.length ? `<section class="card overdue-card"><h2>Overdue</h2>
      <ul class="plain">${overdue.map((t) => {
        const n = diffDays(today, t.date);
        return taskRow(t, { actions: true, note: `<span class="overdue small">${plural(n, "day")} overdue</span>` });
      }).join("")}</ul></section>` : ""}

    <section class="card"><h2>Today's plan</h2>
      <p class="muted">${fmtMinutes(plannedToday)} planned of ${fmtMinutes(capacityToday)} available</p>
      ${todays.length ? `<ul class="plain">${todays.map((t) => taskRow(t, { actions: t.status === "pending" })).join("")}</ul>`
        : noTopics ? `<p>No subjects or topics yet. Start on the <a href="#/subjects">Subjects</a> page.</p>`
        : `<p>Nothing is scheduled for today.</p>`}
      ${doneToday ? `<p class="muted">Today's plan is finished.</p>` : ""}
    </section>

    <section class="card"><h2>Upcoming recalls</h2>
      ${upcomingRecalls.length ? `<ul class="plain">${upcomingRecalls.map((t) => {
        const n = diffDays(t.date, today);
        return taskRow(t, { showStatus: false, note: `<span class="small muted">${n === 1 ? "tomorrow" : `in ${n} days`} · ${formatShortDate(t.date)}</span>` });
      }).join("")}</ul>` : `<p>No recalls are scheduled yet.</p>`}
    </section>`;

  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-result]");
    if (!btn) return;
    const taskId = btn.closest("[data-task]").dataset.task;
    const action = { done: planner.completeTask, partial: planner.markTaskPartial, missed: planner.markTaskMissed }[btn.dataset.result];
    el.querySelectorAll("[data-result]").forEach((b) => (b.disabled = true)); // no double clicks
    withSaving(() => action(taskId), () => draw(host));
  });
}
