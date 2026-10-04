// Settings page. Every field saves by itself as soon as you change it.
import * as db from "./database.js";
import * as auth from "./auth.js";
import { state } from "./state.js";
import { WEEKDAYS } from "./constants.js";
import { withSaving, openForm, tracked, errorCard } from "./ui.js";
import { refreshSchedule } from "./planner.js";
import { setTheme, currentTheme } from "./theme.js";
import { exportData, importBackupFile } from "./exportImport.js";
import { $, escapeHtml, showToast } from "./utils.js";

const cap = (w) => w[0].toUpperCase() + w.slice(1);

// Keep the Appearance radios in step with the top-bar toggle.
window.addEventListener("themechange", (e) => {
  const radio = document.querySelector(`input[name="theme"][value="${e.detail}"]`);
  if (radio) radio.checked = true;
});

export async function renderSettings(container) {
  const el = document.createElement("div");
  container.replaceChildren(el);
  el.innerHTML = `<p class="muted">Loading your study plan...</p>`;

  let profile, settings;
  try {
    [profile, settings] = await Promise.all([db.getProfile(state.user.id), db.getSettings()]);
  } catch (err) {
    errorCard(el, "Couldn't load your settings.", err, () => renderSettings(container));
    return;
  }
  if (profile) state.profile = profile;
  draw(el, container, profile ?? {}, settings ?? {});
}

function draw(el, container, profile, settings) {
  const daily = settings.daily_study_minutes ?? profile.daily_study_minutes ?? 60;
  const theme = currentTheme();
  const input = (id, label, attrs, value, setting, extra = "") => `
    <div class="field"><label for="${id}">${label}</label>
      <input id="${id}" data-setting="${setting}" data-last="${escapeHtml(value)}" value="${escapeHtml(value)}" ${attrs} ${extra} /></div>`;

  el.innerHTML = `
    <p class="muted">Changes save automatically.</p>

    <section class="card"><h2>Profile</h2>
      <div class="row">
        <div class="grow">${input("set-name", "Name", 'type="text" autocomplete="name"', profile.full_name ?? "", "full_name")}</div>
        <div class="grow">${input("set-class", "Class / year", 'type="text"', profile.class_name ?? "", "class_name")}</div>
      </div>
    </section>

    <section class="card"><h2>Study capacity</h2>
      <p class="muted">How much time you can study. The schedule never plans more than this on a day.</p>
      <div class="chips" role="group" aria-label="Quick choices">
        ${[30, 60, 120, 180].map((m) => `<button type="button" class="btn" data-action="set-daily" data-minutes="${m}">${m < 60 ? m + " min" : m / 60 + " h"}</button>`).join("")}
      </div>
      ${input("set-daily", "Minutes per day (usual)", 'type="number" min="10" max="720" step="5"', daily, "daily")}
      <h3 class="sub-head">Different amounts for each weekday</h3>
      <p class="muted small">Leave a day empty to use the usual amount. Enter 0 for a rest day.</p>
      <div class="weekday-grid">
        ${WEEKDAYS.map((d) => `
          <div class="field"><label for="set-${d}">${cap(d)}</label>
            <input id="set-${d}" type="number" min="0" max="720" step="5" data-setting="weekday" data-day="${d}"
                   data-last="${settings[`${d}_minutes`] ?? ""}" value="${settings[`${d}_minutes`] ?? ""}" placeholder="${daily}" /></div>`).join("")}
      </div>
      <button type="button" class="btn" data-action="all-days">Use the usual amount for every day</button>
    </section>

    <section class="card"><h2>Appearance</h2>
      <div class="radio-row" role="radiogroup" aria-label="Theme">
        <label><input type="radio" name="theme" value="light" ${theme === "light" ? "checked" : ""} /> Light</label>
        <label><input type="radio" name="theme" value="dark" ${theme === "dark" ? "checked" : ""} /> Dark</label>
      </div>
    </section>

    <section class="card"><h2>Account</h2>
      <p>Email: <strong>${escapeHtml(state.user.email || "")}</strong></p>
      <div class="toolbar">
        <button type="button" class="btn" data-action="password-reset">Send password reset email</button>
        <button type="button" class="btn" data-action="logout">Log out</button>
      </div>
    </section>

    <section class="card"><h2>Data</h2>
      <p class="muted">Export a backup of all your study data as a JSON file, or restore one.</p>
      <div class="toolbar">
        <button type="button" class="btn" data-action="export">Export data</button>
        <button type="button" class="btn" data-action="import">Import data</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden />
      <p id="data-status" class="muted small" role="status"></p>
    </section>

    <section class="card danger-zone"><h2>Reset account data</h2>
      <p class="muted">Deletes all your subjects, chapters, topics, tasks, recall history and study sessions. Your account, profile and settings stay.</p>
      <button type="button" class="btn btn-danger" data-action="reset">Reset account data</button>
    </section>`;

  const status = (text) => { const p = $("#data-status", el); if (p) p.textContent = text; };
  const afterCapacity = () => refreshSchedule().catch(() => showToast("Couldn't update your schedule. It will retry next time you open the app."));

  // ----- Fields save when changed -----
  el.addEventListener("change", (e) => {
    const field = e.target;
    if (field.name === "theme") return void setTheme(field.value);
    const { setting, day } = field.dataset;
    if (!setting) return;
    const revert = () => { field.value = field.dataset.last; };
    const remember = () => { field.dataset.last = field.value; };

    if (setting === "full_name" || setting === "class_name") {
      const value = field.value.trim();
      if (!value) { showToast(setting === "full_name" ? "Enter your name." : "Enter your class or year."); return revert(); }
      field.value = value;
      withSaving(() => db.updateProfileFields({ [setting]: value }), () => {
        remember();
        state.profile = { ...state.profile, [setting]: value };
        if (setting === "full_name") $("#account-name").textContent = value;
      });
    } else if (setting === "daily") {
      const n = Number(field.value);
      if (!Number.isInteger(n) || n < 10 || n > 720) { showToast("Daily study time must be between 10 and 720 minutes."); return revert(); }
      withSaving(async () => {
        await db.updateSettings({ daily_study_minutes: n });
        await db.updateProfileFields({ daily_study_minutes: n });
      }, () => {
        remember();
        el.querySelectorAll('[data-setting="weekday"]').forEach((i) => (i.placeholder = String(n)));
        afterCapacity();
      });
    } else if (setting === "weekday") {
      const raw = field.value.trim();
      const n = raw === "" ? null : Number(raw);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 720)) { showToast("Minutes for a day must be 0 to 720, or empty."); return revert(); }
      withSaving(() => db.updateSettings({ [`${day}_minutes`]: n }), () => { remember(); afterCapacity(); });
    }
  });

  // ----- Buttons -----
  el.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action) return;

    if (action === "set-daily") {
      const box = $("#set-daily", el);
      box.value = e.target.closest("[data-action]").dataset.minutes;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action === "all-days") {
      const n = Number($("#set-daily", el).dataset.last);
      const fields = Object.fromEntries(WEEKDAYS.map((d) => [`${d}_minutes`, n]));
      withSaving(() => db.updateSettings(fields), () => {
        el.querySelectorAll('[data-setting="weekday"]').forEach((i) => { i.value = String(n); i.dataset.last = String(n); });
        afterCapacity();
      });
    }
    if (action === "logout") {
      try { await auth.signOut(); } catch (err) { showToast(err.message); }
    }
    if (action === "password-reset") {
      try {
        await auth.sendPasswordReset(state.user.email);
        showToast("Password reset email sent. Check your inbox.");
      } catch (err) { showToast(err.message); }
    }
    if (action === "export") {
      status("Preparing your backup...");
      try { await exportData(); status("Backup downloaded."); }
      catch (err) { status(""); showToast(err.message); }
    }
    if (action === "import") $("#import-file", el).click();
    if (action === "reset") resetDialog(container, status);
  });

  $("#import-file", el).addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // so choosing the same file again works
    if (file) importBackupFile(file, { onStatus: status, onDone: () => renderSettings(container) });
  });
}

function resetDialog(container, status) {
  openForm({
    title: "Reset account data",
    submitLabel: "Delete everything",
    intro: `This permanently deletes all your subjects, chapters, topics, tasks, recall history and study sessions. Your account, profile and settings stay.
      Export a backup first if you might want this data back. Type <strong>RESET</strong> to confirm.`,
    fields: [{ name: "confirm", label: "Type RESET", value: "" }],
    onSubmit: async (v) => {
      if (v.confirm.trim() !== "RESET") throw new Error("Type RESET exactly to continue.");
      await tracked(() => db.deleteAllStudyData());
      status("All study data was removed.");
      await refreshSchedule().catch(() => {});
      renderSettings(container);
    },
  });
}
