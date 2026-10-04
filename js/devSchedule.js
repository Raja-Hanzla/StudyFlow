// TEMPORARY Stage 5 test view. It shows the generated schedule so you can try
// Done / Partial / Missed. Stage 6 replaces it with the real dashboard.
import * as planner from "./planner.js";
import { withSaving } from "./ui.js";
import { escapeHtml, formatShortDate } from "./utils.js";

export function renderSchedulePreview(container) {
  const el = document.createElement("div");
  container.replaceChildren(el);
  return draw(el);
}

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");

function taskRow(t, actionable) {
  const buttons = actionable
    ? `<button class="btn" data-result="done">Done</button>
       <button class="btn" data-result="partial">Partial</button>
       <button class="btn" data-result="missed">Missed</button>`
    : `<span class="small muted">${escapeHtml(cap(t.status))}</span>`;
  return `
    <li class="topic-row" data-task="${escapeHtml(t.id)}" style="--subject:${escapeHtml(t.color || "#3b5bdb")}">
      <div class="topic-main"><strong><span class="subject-dot"></span>${escapeHtml(t.topicName)}</strong>
        <span class="muted small">${escapeHtml(t.subjectName || "")} › ${escapeHtml(t.chapterName || "")}</span></div>
      <span class="tag tag-${t.type}">${t.type === "study" ? "Study" : "Recall"}</span>
      <span class="small">${t.minutes} min</span>
      <span class="small muted">${escapeHtml(t.difficulty)} · ${escapeHtml(t.priority)}</span>
      ${buttons}
    </li>`;
}

async function draw(el) {
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;
  let result, view;
  try {
    result = await planner.refreshSchedule();
    view = await planner.loadView();
  } catch (err) {
    el.innerHTML = `<section class="card"><p>Couldn't build your study plan. ${escapeHtml(err.message)}</p>
      <button class="btn" data-retry>Try again</button></section>`;
    el.querySelector("[data-retry]").addEventListener("click", () => draw(el));
    return;
  }

  const { today, tasks, capacityToday } = view;
  const overdue = tasks.filter((t) => t.status === "pending" && t.date < today);
  const todays = tasks.filter((t) => t.date === today);
  const upcoming = tasks.filter((t) => t.status === "pending" && t.date > today);
  const plannedToday = todays.reduce((n, t) => n + t.minutes, 0) + overdue.reduce((n, t) => n + t.minutes, 0);

  const byDate = new Map();
  upcoming.forEach((t) => byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]));

  el.innerHTML = `
    <section class="card">
      <h2>Schedule preview <span class="tag">test view</span></h2>
      <p class="muted">Temporary Stage 5 page. The real dashboard replaces it in Stage 6.</p>
      <div class="row">
        <div class="field"><label for="dev-day">Pretend today is</label>
          <input id="dev-day" type="date" value="${today}" /></div>
        <button class="btn" data-dev="set">Use this date</button>
        <button class="btn" data-dev="reset">Back to real today</button>
        <button class="btn" data-dev="refresh">Rebuild schedule</button>
      </div>
    </section>
    ${result.notes.map((n) => `<p class="notice" role="status">${escapeHtml(n.text)}</p>`).join("")}
    ${overdue.length ? `<section class="card"><h2>Overdue</h2><ul class="plain">${overdue.map((t) => taskRow(t, true)).join("")}</ul></section>` : ""}
    <section class="card"><h2>Today · ${formatShortDate(today)}</h2>
      <p class="muted">${plannedToday} of ${capacityToday} minutes planned</p>
      ${todays.length ? `<ul class="plain">${todays.map((t) => taskRow(t, t.status === "pending")).join("")}</ul>`
        : `<p>Nothing scheduled for today.</p>`}</section>
    <section class="card"><h2>Coming days</h2>
      ${byDate.size ? [...byDate].map(([date, list]) => `
        <h3 class="day-head">${formatShortDate(date)} <span class="muted small">${list.reduce((n, t) => n + t.minutes, 0)} min</span></h3>
        <ul class="plain">${list.map((t) => taskRow(t, false)).join("")}</ul>`).join("")
        : `<p>Nothing scheduled yet.</p>`}
      ${result.unscheduled.length ? `<p class="muted small">${result.unscheduled.length} more task(s) are waiting for free time.</p>` : ""}
    </section>`;

  el.addEventListener("click", (e) => {
    const dev = e.target.closest("[data-dev]")?.dataset.dev;
    if (dev === "set") { planner.setDevToday(el.querySelector("#dev-day").value); draw(el); }
    if (dev === "reset") { planner.setDevToday(null); draw(el); }
    if (dev === "refresh") draw(el);

    const btn = e.target.closest("[data-result]");
    if (!btn) return;
    const taskId = btn.closest("[data-task]").dataset.task;
    const action = { done: planner.completeTask, partial: planner.markTaskPartial, missed: planner.markTaskMissed }[btn.dataset.result];
    el.querySelectorAll("[data-result]").forEach((b) => (b.disabled = true)); // no double clicks
    withSaving(() => action(taskId), () => draw(el));
  });
}
