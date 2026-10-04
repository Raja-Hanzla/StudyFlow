// Progress page: charts built with Chart.js from your real data (see stats.js).
import { loadStats } from "./stats.js";
import { escapeHtml, formatMinutes } from "./utils.js";
import { errorCard } from "./ui.js";

let charts = []; // kept so they can be destroyed before the page is drawn again
let redraw = null; // redraws the page on screen, so chart colors follow a theme change
window.addEventListener("themechange", () => redraw?.());
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function chartCard({ id, title, label, hasData, empty, summary }) {
  return `
    <section class="card chart-card"><h2>${title}</h2>
      ${hasData
        ? `<div class="chart-box"><canvas id="${id}" role="img" aria-label="${escapeHtml(label)}"></canvas></div>
           <p class="muted small">${escapeHtml(summary)}</p>`
        : `<p class="muted">${empty}</p>`}
    </section>`;
}

export async function renderProgress(container) {
  charts.forEach((c) => c.destroy());
  charts = [];
  const el = document.createElement("div");
  container.replaceChildren(el);
  redraw = () => (el.isConnected ? renderProgress(container) : null);
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;

  let s;
  try {
    s = await loadStats();
  } catch (err) {
    errorCard(el, "Couldn't load your progress.", err, () => renderProgress(container));
    return;
  }

  const t = s.topics;
  const weekMinutes = s.weeks.reduce((n, w) => n + w.minutes, 0);
  const sumRecalls = (key) => s.weeks.reduce((n, w) => n + w.recalls[key], 0);
  const weekRecalls = sumRecalls("done") + sumRecalls("partial") + sumRecalls("missed");
  const taskTotal = s.tasks.done + s.tasks.partial + s.tasks.missed + s.tasks.overdue + s.tasks.upcoming;
  const withTopics = s.subjects.filter((x) => x.total > 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  el.innerHTML = `
    <div class="summary-grid compact">
      <section class="card"><h2>Topics studied</h2><p class="stat-big">${t.studied} of ${t.total}</p>
        <p class="muted small">${pct(t.studied, t.total)}% of your topics</p></section>
      <section class="card"><h2>Tasks completed</h2><p class="stat-big">${s.tasks.done}</p>
        <p class="muted small">${s.tasks.partial} partial · ${s.tasks.missed} missed</p></section>
      <section class="card"><h2>Pending</h2><p class="stat-big">${s.tasks.upcoming}</p>
        <p class="muted small">scheduled, not yet due</p></section>
      <section class="card"><h2>Overdue</h2><p class="stat-big ${s.tasks.overdue ? "overdue" : ""}">${s.tasks.overdue}</p>
        <p class="muted small">${s.tasks.overdue ? "pending tasks from earlier days" : "nothing overdue"}</p></section>
    </div>

    <div class="chart-grid">
      ${chartCard({ id: "ch-overall", title: "Overall topic completion", hasData: t.total > 0,
        empty: "No topics added yet. Add some on the Subjects page.",
        label: `Topics: ${t.total - t.studied} not studied, ${t.studied - t.recalled} studied, ${t.recalled} recalled`,
        summary: `${t.total - t.studied} not studied · ${t.studied - t.recalled} studied · ${t.recalled} recalled at least once` })}
      ${chartCard({ id: "ch-subjects", title: "Completion by subject", hasData: withTopics.length > 0,
        empty: "No subjects with topics yet.",
        label: "Share of topics studied and recalled, for each subject",
        summary: withTopics.map((x) => `${x.name}: ${x.studied}/${x.total} studied, ${x.recalled} recalled`).join(" · ") })}
      ${chartCard({ id: "ch-minutes", title: "Weekly study minutes", hasData: weekMinutes > 0,
        empty: "No study time recorded yet. It appears after you mark a task Done or Partial.",
        label: `Study minutes per week over the last 8 weeks, ${weekMinutes} in total`,
        summary: `Last 8 weeks: ${formatMinutes(weekMinutes)} · this week: ${formatMinutes(s.minutesThisWeek)}` })}
      ${chartCard({ id: "ch-tasks", title: "Tasks", hasData: taskTotal > 0,
        empty: "No tasks yet. They are created from your topics.",
        label: `Tasks: ${s.tasks.done} done, ${s.tasks.partial} partial, ${s.tasks.missed} missed, ${s.tasks.upcoming} pending, ${s.tasks.overdue} overdue`,
        summary: `${s.tasks.done} done · ${s.tasks.partial} partial · ${s.tasks.missed} missed · ${s.tasks.upcoming} pending · ${s.tasks.overdue} overdue` })}
      ${chartCard({ id: "ch-recalls", title: "Recall activity", hasData: weekRecalls > 0,
        empty: "No recalls recorded yet. They appear after you finish a recall task.",
        label: "Recalls per week by result over the last 8 weeks",
        summary: `Last 8 weeks: ${sumRecalls("done")} done · ${sumRecalls("partial")} partial · ${sumRecalls("missed")} missed` })}
      ${chartCard({ id: "ch-trend", title: "Preparation trend", hasData: t.studied > 0,
        empty: "The trend appears once you have studied your first topic.",
        label: "Topics studied and recalled, cumulative, at the end of each of the last 8 weeks",
        summary: `Now: ${s.trend.at(-1).studied} topics studied, ${s.trend.at(-1).recalled} with at least one successful recall (counted over your current topics)` })}
    </div>`;

  if (!window.Chart) {
    el.insertAdjacentHTML("afterbegin", `<p class="notice" role="status">The chart library didn't load, so only the numbers are shown. An ad blocker or a network filter may be blocking cdn.jsdelivr.net. Refresh the page once it is allowed.</p>`);
    return;
  }

  // Colors come from the theme, so charts follow light/dark mode (as of page load).
  const c = { accent: css("--accent"), warning: css("--warning"), success: css("--success"), danger: css("--danger"),
              muted: css("--text-muted"), border: css("--border"), surface: css("--surface") };
  Chart.defaults.color = c.muted;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const base = { responsive: true, maintainAspectRatio: false };
  const axis = { grid: { color: c.border }, border: { color: c.border } };
  const make = (id, config) => {
    const canvas = el.querySelector(`#${id}`);
    if (canvas) charts.push(new Chart(canvas, config));
  };

  make("ch-overall", { type: "doughnut",
    data: { labels: ["Not studied yet", "Studied", "Recalled at least once"],
      datasets: [{ data: [t.total - t.studied, t.studied - t.recalled, t.recalled], backgroundColor: [c.border, c.accent, c.success], borderColor: c.surface }] },
    options: { ...base, cutout: "62%", plugins: { legend: { position: "bottom" } } } });

  make("ch-subjects", { type: "bar",
    data: { labels: withTopics.map((x) => x.name),
      datasets: [
        { label: "Studied", data: withTopics.map((x) => pct(x.studied, x.total)), backgroundColor: c.accent },
        { label: "Recalled", data: withTopics.map((x) => pct(x.recalled, x.total)), backgroundColor: c.warning } ] },
    options: { ...base, indexAxis: "y", plugins: { legend: { position: "bottom" }, tooltip: { callbacks: {
        label: (ctx) => { const x = withTopics[ctx.dataIndex]; const n = ctx.datasetIndex ? x.recalled : x.studied; return `${ctx.dataset.label}: ${ctx.parsed.x}% (${n} of ${x.total})`; } } } },
      scales: { x: { ...axis, min: 0, max: 100, ticks: { callback: (v) => `${v}%` } }, y: { ...axis, grid: { display: false } } } } });

  make("ch-minutes", { type: "bar",
    data: { labels: s.weeks.map((w) => w.label), datasets: [{ label: "Minutes", data: s.weeks.map((w) => w.minutes), backgroundColor: c.accent }] },
    options: { ...base, plugins: { legend: { display: false } },
      scales: { x: { ...axis, grid: { display: false }, title: { display: true, text: "Week starting" } }, y: { ...axis, beginAtZero: true, title: { display: true, text: "Minutes" } } } } });

  make("ch-tasks", { type: "bar",
    data: { labels: ["Done", "Partial", "Missed", "Pending", "Overdue"],
      datasets: [{ data: [s.tasks.done, s.tasks.partial, s.tasks.missed, s.tasks.upcoming, s.tasks.overdue],
        backgroundColor: [c.success, c.warning, c.muted, c.accent, c.danger] }] },
    options: { ...base, indexAxis: "y", plugins: { legend: { display: false } },
      scales: { x: { ...axis, beginAtZero: true, ticks: { precision: 0 } }, y: { ...axis, grid: { display: false } } } } });

  make("ch-recalls", { type: "bar",
    data: { labels: s.weeks.map((w) => w.label),
      datasets: [
        { label: "Done", data: s.weeks.map((w) => w.recalls.done), backgroundColor: c.success },
        { label: "Partial", data: s.weeks.map((w) => w.recalls.partial), backgroundColor: c.warning },
        { label: "Missed", data: s.weeks.map((w) => w.recalls.missed), backgroundColor: c.muted } ] },
    options: { ...base, plugins: { legend: { position: "bottom" } },
      scales: { x: { ...axis, stacked: true, grid: { display: false }, title: { display: true, text: "Week starting" } },
                y: { ...axis, stacked: true, beginAtZero: true, ticks: { precision: 0 } } } } });

  make("ch-trend", { type: "line",
    data: { labels: s.trend.map((p) => p.label),
      datasets: [
        { label: "Topics studied", data: s.trend.map((p) => p.studied), borderColor: c.accent, backgroundColor: c.accent, tension: 0.25 },
        { label: "Topics recalled at least once", data: s.trend.map((p) => p.recalled), borderColor: c.success, backgroundColor: c.success, tension: 0.25 } ] },
    options: { ...base, plugins: { legend: { position: "bottom" } },
      scales: { x: { ...axis, grid: { display: false }, title: { display: true, text: "Week starting" } },
                y: { ...axis, beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "Topics" } } } } });
}
