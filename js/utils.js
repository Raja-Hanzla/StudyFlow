// Small helpers shared by every module.

export const $  = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Re-draw Lucide icons after inserting new HTML that contains data-lucide. */
export function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

/** Escape text before putting it in innerHTML (prevents HTML injection). */
export function escapeHtml(text = "") {
  return String(text).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Local date as YYYY-MM-DD (avoids the UTC shift of toISOString). */
export function toDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatLongDate(date = new Date()) {
  return date.toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

/** Save indicator in the top bar. state: "saving" | "saved" | "error" */
let saveTimer;
export function setSaveStatus(state, retryFn) {
  const el = $("#save-status");
  clearTimeout(saveTimer);
  el.classList.toggle("error", state === "error");
  if (state === "saving") el.textContent = "Saving...";
  if (state === "saved") {
    el.textContent = "Saved";
    saveTimer = setTimeout(() => (el.textContent = ""), 2000);
  }
  if (state === "error") {
    el.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Unable to save — retry";
    if (retryFn) btn.addEventListener("click", retryFn);
    el.append(btn);
  }
}

/** Short message at the bottom of the screen. */
let toastTimer;
export function showToast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

// ---------- Dates ----------
/** "YYYY-MM-DD" or a timestamp -> local calendar day "YYYY-MM-DD". */
export function toLocalDay(value) {
  return String(value).length === 10 ? String(value) : toDateString(new Date(value));
}
function dayToDate(value) {
  const [y, m, d] = toLocalDay(value).split("-").map(Number);
  return new Date(y, m - 1, d);
}
/** Whole days from today until the date (negative = in the past). */
export function daysUntil(value) {
  return Math.round((dayToDate(value) - dayToDate(toDateString())) / 86400000);
}
export function formatShortDate(value) {
  return dayToDate(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "Monday, 5 October 2026" for a "YYYY-MM-DD" day. */
export function formatLongDay(value) {
  return dayToDate(value).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** 95 -> "1 h 35 min", 40 -> "40 min" */
export function formatMinutes(m) {
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}

/**
 * Pages that redraw themselves call this first: it puts a NEW empty element inside `host`
 * and returns it. Click handlers are attached to that element, so they disappear when
 * the page is redrawn. (Attaching them to `host` would stack up a duplicate on every redraw.)
 */
export function freshRoot(host) {
  const root = document.createElement("div");
  host.replaceChildren(root);
  return root;
}
