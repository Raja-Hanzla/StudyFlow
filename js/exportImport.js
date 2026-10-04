// Export, import and the import steps. The file rules live in backup.js.
import * as db from "./database.js";
import { buildBackup, validateBackup, prepareImport, summarize, MAX_FILE_BYTES } from "./backup.js";
import { openForm, openInfo, tracked } from "./ui.js";
import { refreshSchedule } from "./planner.js";
import { state } from "./state.js";
import { escapeHtml, toDateString } from "./utils.js";

// ---------- Export ----------
/** Downloads studyflow-backup-YYYY-MM-DD.json with the user's own data. */
export async function exportData() {
  const raw = await db.getAllForExport();
  const backup = buildBackup(raw, new Date().toISOString());
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `studyflow-backup-${toDateString()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Import ----------
/** The import as a list of steps that can be resumed: a retry continues where it stopped. */
function createJob(plan, mode) {
  const steps = [];
  if (mode === "replace") {
    steps.push(["Removing your current data...", () => db.deleteAllStudyData()]);
    steps.push(["Restoring profile and settings...", async () => {
      if (plan.profile) await db.updateProfileFields(plan.profile);
      if (plan.settings) await db.updateSettings(plan.settings);
    }]);
  }
  const tables = [["subjects", "subjects"], ["exams", "exams"], ["chapters", "chapters"], ["topics", "topics"],
                  ["tasks", "study_tasks"], ["recall history", "recall_history"], ["study sessions", "study_sessions"]];
  const keys = ["subjects", "exams", "chapters", "topics", "tasks", "recallHistory", "studySessions"];
  tables.forEach(([label, table], i) => steps.push([`Importing ${label}...`, () => db.upsertRows(table, plan[keys[i]])]));

  let next = 0;
  return {
    async run(onStatus) {
      while (next < steps.length) {
        onStatus?.(steps[next][0]);
        await steps[next][1]();
        next += 1;
      }
    },
  };
}

/**
 * Reads a chosen file, checks it, shows what it contains, and only imports after the student confirms.
 * Nothing is written until the final "Import" button.
 */
export async function importBackupFile(file, { onStatus, onDone }) {
  if (file.size > MAX_FILE_BYTES) {
    return openInfo({ title: "File too large", html: `<p>Backups can be up to 20 MB. Nothing was changed.</p>` });
  }
  let json;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return openInfo({ title: "Can't read this file", html: `<p>It isn't valid JSON. Choose a backup exported from StudyFlow. Nothing was changed.</p>` });
  }
  const result = validateBackup(json);
  if (!result.ok) {
    const more = result.errorCount - result.errors.length;
    return openInfo({
      title: "This backup can't be imported",
      html: `<p>Nothing was changed. Problems found:</p>
        <ul>${result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
        ${more > 0 ? `<p class="muted small">…and ${more} more.</p>` : ""}`,
    });
  }

  const counts = summarize(result.backup);
  const plan = prepareImport(result.backup, state.user.id);
  const exported = result.backup.exportedAt ? new Date(result.backup.exportedAt).toLocaleString() : "unknown date";
  let job = null;
  let lockedMode = null;

  openForm({
    title: "Import backup",
    submitLabel: "Import",
    intro: `The file was exported ${escapeHtml(exported)} and contains ${counts.subjects} subject(s), ${counts.chapters} chapter(s),
      ${counts.topics} topic(s), ${counts.tasks} task(s), ${counts.recalls} recall record(s) and ${counts.sessions} study session(s).<br><br>
      <strong>Replace</strong> deletes ALL your current study data first, then restores the file (profile and settings too).<br>
      <strong>Merge</strong> adds the file's data next to what you have, which can create duplicates.`,
    fields: [{ name: "mode", label: "How to import", type: "select", options: ["replace", "merge"], value: "replace" }],
    onSubmit: async (values) => {
      if (lockedMode && values.mode !== lockedMode) throw new Error(`Press Import again with "${lockedMode}" to finish where it stopped.`);
      lockedMode = values.mode;
      job ??= createJob(plan, values.mode);
      await tracked(() => job.run(onStatus));   // on a network error the dialog stays open: press Import to continue
      onStatus?.("Backup imported. Updating your schedule...");
      await refreshSchedule().catch(() => {});
      onStatus?.("Backup imported.");
      onDone?.();
    },
  });
}
