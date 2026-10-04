// Study session screen: #/session/<taskId>
// Shows one task, counts the time, and records Done / Partial / Missed.
// No answers are typed: the student studies or recalls in their own way.
import * as planner from "./planner.js";
import { withSaving, errorCard } from "./ui.js";
import { escapeHtml } from "./utils.js";

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");

export async function renderSession(container, params = []) {
  const el = document.createElement("div");
  container.replaceChildren(el);
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;

  let view;
  try {
    view = await planner.loadView();
  } catch (err) {
    errorCard(el, "Couldn't load this session.", err, () => renderSession(container, params));
    return;
  }

  const task = view.tasks.find((t) => t.id === params[0]);
  if (!task || task.status !== "pending") {
    el.innerHTML = `<section class="card">
      <p>${task ? `This task is already marked ${escapeHtml(task.status)}.` : "This task is no longer in your plan."}</p>
      <a href="#/dashboard">Back to the dashboard</a></section>`;
    return;
  }

  const isStudy = task.type === "study";
  el.innerHTML = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="#/dashboard">Dashboard</a> / Study session</nav>
    <section class="card session-card" style="--subject:${escapeHtml(task.color || "#3b5bdb")}">
      <p class="muted"><span class="subject-dot"></span>${escapeHtml(task.subjectName || "")} › ${escapeHtml(task.chapterName || "")}</p>
      <h2>${escapeHtml(task.topicName)}</h2>
      <p><span class="tag tag-${task.type}">${isStudy ? "Study" : "Recall"}</span>
         ${task.minutes ? `<span class="small">Planned: ${task.minutes} min</span>` : ""}
         <span class="pill">${cap(task.difficulty)}</span><span class="pill">${cap(task.priority)} priority</span></p>
      <p class="session-text">${isStudy
        ? "Study this topic using your normal study method."
        : "Close your book and recall this topic."}</p>
      <p class="timer" id="timer" role="timer" aria-label="Time so far">0:00</p>
      <p class="muted small">When you're finished, tell StudyFlow how it went.</p>
      <div class="toolbar">
        <button class="btn btn-primary" data-result="done">Done</button>
        <button class="btn" data-result="partial">Partial</button>
        <button class="btn" data-result="missed">Missed</button>
      </div>
    </section>`;

  // Simple stopwatch. It stops by itself once the page is left.
  const started = Date.now();
  const timer = el.querySelector("#timer");
  const tick = setInterval(() => {
    if (!el.isConnected) return clearInterval(tick);
    const s = Math.floor((Date.now() - started) / 1000);
    timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);

  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-result]");
    if (!btn) return;
    const result = btn.dataset.result;
    const elapsed = Date.now() - started;
    // Use the real time if at least a minute passed, otherwise the planner's estimate.
    const durationMinutes = result !== "missed" && elapsed >= 60000 ? Math.round(elapsed / 60000) : null;
    const action = { done: planner.completeTask, partial: planner.markTaskPartial, missed: planner.markTaskMissed }[result];
    el.querySelectorAll("[data-result]").forEach((b) => (b.disabled = true));
    withSaving(() => action(task.id, { durationMinutes }), () => { location.hash = "#/dashboard"; });
  });
}
