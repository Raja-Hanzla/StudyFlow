// Insights page: plain facts counted from your data. No predictions.
import { loadStats } from "./stats.js";
import { diffDays } from "./scheduler.js";
import { escapeHtml, formatMinutes, formatShortDate } from "./utils.js";
import { errorCard } from "./ui.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function renderInsights(container) {
  const el = document.createElement("div");
  container.replaceChildren(el);
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;

  let s;
  try {
    s = await loadStats();
  } catch (err) {
    errorCard(el, "Couldn't load your insights.", err, () => renderInsights(container));
    return;
  }

  // Most completed subject = the highest share of its topics studied (ties are all named).
  const withTopics = s.subjects.filter((x) => x.total > 0);
  const best = Math.max(0, ...withTopics.map((x) => x.studied / x.total));
  const leaders = best > 0 ? withTopics.filter((x) => x.studied / x.total === best) : [];
  const remaining = s.topics.total - s.topics.studied;

  const card = (title, big, detail = "", extra = "") => `
    <section class="card"><h2>${title}</h2><p class="stat-big">${big}</p>
      ${detail ? `<p class="muted small">${detail}</p>` : ""}${extra}</section>`;

  el.innerHTML = `
    <div class="summary-grid">
      ${card("Most completed subject",
        leaders.length ? escapeHtml(leaders.map((x) => x.name).join(" and ")) : "No topics studied yet",
        leaders.length ? `${leaders[0].studied} of ${leaders[0].total} topics studied (${Math.round(best * 100)}%)` : "Measured by the share of a subject's topics studied.")}
      ${card("Topics remaining", s.topics.total ? `${remaining} of ${s.topics.total}` : "No topics yet",
        s.topics.total ? "not studied yet" : "Add topics on the Subjects page.",
        remaining ? `<ul class="plain small">${withTopics.filter((x) => x.total > x.studied)
          .map((x) => `<li>${escapeHtml(x.name)}: ${x.total - x.studied}</li>`).join("")}</ul>` : "")}
      ${card("Overdue tasks", String(s.tasks.overdue),
        s.tasks.overdue ? `pending tasks from earlier days. <a href="#/dashboard">See them on the dashboard</a>.` : "Nothing is overdue.")}
      ${card("Study time this week", formatMinutes(s.minutesThisWeek), "recorded from finished tasks and sessions")}
      ${card("Recalls completed", String(s.recalls.doneTotal), `${s.recalls.doneThisWeek} this week · counted when a recall is marked Done`)}
      ${card("Difficult topics remaining", `${s.hard.notStudied} not studied`,
        `${s.hard.earlyRecall} more studied, with fewer than 3 successful recalls`)}
    </div>
    <section class="card"><h2>Upcoming exams</h2>
      ${s.exams.length ? `<ul class="plain">${s.exams.slice(0, 6).map((e) => {
        const n = diffDays(e.date, s.today);
        return `<li class="exam-line"><strong>${escapeHtml(e.subjectName)}</strong>
          <span class="muted">${formatShortDate(e.date)} · ${n === 0 ? "today" : plural(n, "day") + " remaining"}</span></li>`;
      }).join("")}</ul>` : `<p>No exam dates set. Add them on the Subjects page.</p>`}
    </section>`;
}
