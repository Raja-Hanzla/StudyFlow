// Reusable UI pieces: form dialogs, confirm dialogs, and "Saving..." wrappers.
import { $, escapeHtml, setSaveStatus, showToast } from "./utils.js";
import { explainError } from "./errors.js";

// ---------- Save feedback ----------
/**
 * For inline actions (a dropdown change, a delete).
 * Shows Saving... / Saved, or "Unable to save — retry" (the retry re-runs the task).
 * onSuccess runs after a successful save, including after a retry.
 */
export async function withSaving(task, onSuccess) {
  setSaveStatus("saving");
  try {
    await task();
    setSaveStatus("saved");
    onSuccess?.();
  } catch (err) {
    setSaveStatus("error", () => withSaving(task, onSuccess));
    showToast(err.message);
  }
}

/** For dialogs: shows Saving... / Saved, then re-throws errors so the dialog can show them. */
export async function tracked(task) {
  setSaveStatus("saving");
  try {
    const result = await task();
    setSaveStatus("saved");
    return result;
  } catch (err) {
    const status = $("#save-status");
    status.classList.remove("error");
    status.textContent = "Not saved";
    throw err;
  }
}

// ---------- Load errors ----------
/** Replaces a page with "what failed + the real reason + Try again". Logs the raw error for F12. */
export function errorCard(el, headline, error, retry) {
  console.error(headline, error);
  const reason = error?.reason || explainError(error);
  el.innerHTML = `<section class="card page-error" role="alert">
    <p>${escapeHtml(headline)}</p>
    <p class="muted">${escapeHtml(reason)}</p>
    <button type="button" class="btn" data-retry>Try again</button></section>`;
  el.querySelector("[data-retry]").addEventListener("click", retry);
}

// ---------- Dialogs ----------
function fieldHtml(f) {
  const id = `f-${f.name}`;
  const value = escapeHtml(f.value ?? "");
  let control;
  if (f.type === "select") {
    control = `<select id="${id}" name="${f.name}">${f.options.map((o) =>
      `<option value="${o}"${o === f.value ? " selected" : ""}>${o[0].toUpperCase() + o.slice(1)}</option>`).join("")}</select>`;
  } else if (f.type === "textarea") {
    control = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 6}">${value}</textarea>`;
  } else {
    control = `<input id="${id}" name="${f.name}" type="${f.type || "text"}" value="${value}" ${f.attrs || ""} />`;
  }
  return `<div class="field"><label for="${id}">${f.label}</label>${control}</div>`;
}

/**
 * Opens a form in a modal <dialog>.
 *  fields:   [{name, label, type, value, options?, rows?, attrs?}]
 *  intro:    short trusted HTML shown under the title (never put user text in it)
 *  onSubmit: async (values) => {...}  throw an Error to show a message and keep the dialog open
 *  onInput:  optional (values) => string, shown as a live note (used for the bulk-topic preview)
 */
export function openForm({ title, fields, submitLabel = "Save", intro = "", onSubmit, onInput }) {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `
    <form novalidate>
      <h2>${escapeHtml(title)}</h2>
      ${intro ? `<p class="muted">${intro}</p>` : ""}
      ${fields.map(fieldHtml).join("")}
      <p class="dialog-note muted" role="status"></p>
      <p class="form-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary">${submitLabel}</button>
      </div>
    </form>`;
  document.body.append(dialog);

  const form = $("form", dialog);
  const note = $(".dialog-note", dialog);
  const error = $(".form-error", dialog);
  const submit = $("button[type=submit]", dialog);
  const values = () => Object.fromEntries(new FormData(form));

  const updateNote = () => { if (onInput) note.textContent = onInput(values()) || ""; };
  form.addEventListener("input", updateNote);
  updateNote();

  $("[data-cancel]", dialog).addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      await onSubmit(values());
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  dialog.showModal();
}

/** Yes/No question. Resolves true if the student confirms. */
export function confirmDialog({ title, message, confirmLabel = "Delete" }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" data-no>Cancel</button>
        <button type="button" class="btn btn-danger" data-yes>${escapeHtml(confirmLabel)}</button>
      </div>`;
    document.body.append(dialog);
    let answer = false;
    $("[data-yes]", dialog).addEventListener("click", () => { answer = true; dialog.close(); });
    $("[data-no]", dialog).addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { dialog.remove(); resolve(answer); });
    dialog.showModal();
    $("[data-no]", dialog).focus(); // safest default for a destructive question
  });
}

/**
 * A read-only dialog with a Close button.
 *  html:    trusted HTML (callers escape any user text)
 *  onClick: optional (event, close) => {...} for buttons inside the dialog
 * Clicking a link inside it closes the dialog.
 */
export function openInfo({ title, html, onClick }) {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    ${html}
    <div class="dialog-actions"><button type="button" class="btn" data-close>Close</button></div>`;
  document.body.append(dialog);
  const close = () => dialog.close();
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-close], a[href]")) close();
    onClick?.(e, close);
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}
