// Light / dark mode. The choice is applied at once, kept in the browser (so the
// page doesn't flash on reload) and saved to settings.dark_mode (so it follows you).
import * as db from "./database.js";
import { withSaving } from "./ui.js";

const KEY = "studyflow-theme";

export const currentTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** Apply only (no saving). Pages that draw colors themselves listen for "themechange". */
export function applyTheme(theme) {
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* storage can be blocked: the theme still applies */ }
  document.getElementById("theme-toggle")?.setAttribute("aria-pressed", String(theme === "dark"));
  if (changed) window.dispatchEvent(new CustomEvent("themechange", { detail: theme })); // only when it really changed
}

/** Apply and save to the database (shows Saving... / Saved). */
export function setTheme(theme) {
  applyTheme(theme);
  return withSaving(() => db.updateSettings({ dark_mode: theme === "dark" }));
}

/** After login: use the theme saved in the database. */
export async function syncThemeFromSettings() {
  const settings = await db.getSettings();
  if (settings && typeof settings.dark_mode === "boolean") applyTheme(settings.dark_mode ? "dark" : "light");
}
