// App entry point: session gate, hash router, account menu, and the app-wide safety nets
// (unexpected errors, offline banner, keyboard focus after navigation).
import * as auth from "./auth.js";
import { isConfigured } from "./supabase.js";
import { showAuth } from "./authView.js";
import { showOnboarding } from "./onboarding.js";
import { renderSubjects } from "./subjects.js";
import { renderDashboard } from "./dashboard.js";
import { renderSession } from "./session.js";
import { renderCalendar } from "./calendar.js";
import { renderProgress } from "./progress.js";
import { renderInsights } from "./insights.js";
import { renderSettings } from "./settings.js";
import { applyTheme, setTheme, currentTheme, syncThemeFromSettings } from "./theme.js";
import { getToday } from "./planner.js";
import { getProfile } from "./database.js";
import { state } from "./state.js";
import { $, $$, refreshIcons, showToast } from "./utils.js";

// ---------- Router ----------
// Each page is a function that draws itself into the element it is given.
const routes = {
  dashboard: { title: "Dashboard", render: renderDashboard },
  session:   { title: "Study session", render: renderSession }, // opened from a task, not in the menu
  subjects:  { title: "Subjects",  render: renderSubjects },
  calendar:  { title: "Calendar",  render: renderCalendar },
  progress:  { title: "Progress",  render: renderProgress },
  insights:  { title: "Insights",  render: renderInsights },
  settings:  { title: "Settings",  render: renderSettings },
};

/** "#/subjects/abc" -> { name: "subjects", params: ["abc"] } */
function currentRoute() {
  const [name, ...params] = location.hash.replace(/^#\//, "").split("/");
  return routes[name] ? { name, params } : { name: "dashboard", params: [] };
}

let renderCount = 0; // lets a slow page notice that the student has already moved on
let shownDay = null; // the calendar day the screen was last drawn for

/** Draws the page for the current address. moveFocus = true after the student navigates. */
async function renderRoute({ moveFocus = false } = {}) {
  if (!state.user) return; // protected: never render pages when logged out
  const { name, params } = currentRoute();
  const route = routes[name];
  const mine = ++renderCount;
  shownDay = getToday();

  $("#page-title").textContent = route.title;
  document.title = `${route.title} · StudyFlow`;
  const menuName = name === "session" ? "dashboard" : name; // a session belongs to the dashboard
  $$("#main-nav a").forEach((a) => {
    if (a.dataset.route === menuName) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  // New page: start at the top and let screen readers announce the page title.
  if (moveFocus) {
    window.scrollTo(0, 0);
    $("#page-title").focus({ preventScroll: true });
  }

  try {
    await route.render($("#view"), params);
  } catch (error) {
    console.error(`Couldn't draw the ${name} page:`, error);
    if (mine === renderCount) showPageError(error);
    return;
  }
  if (mine === renderCount) refreshIcons();
}

/** Last resort if a page fails to draw at all, so the student never sees a blank screen. */
function showPageError(error) {
  $("#view").innerHTML = `
    <section class="card page-error" role="alert">
      <h2>Something went wrong</h2>
      <p>This page couldn't be shown. Try again, and reload the page if it keeps happening.</p>
      <p class="muted" id="page-error-detail"></p>
      <div class="toolbar">
        <button type="button" class="btn btn-primary" data-act="retry">Try again</button>
        <button type="button" class="btn" data-act="reload">Reload page</button>
      </div>
    </section>`;
  $("#page-error-detail").textContent = error?.reason || error?.message || "";
  $("#view [data-act=retry]").addEventListener("click", () => renderRoute());
  $("#view [data-act=reload]").addEventListener("click", () => location.reload());
}

// ---------- Session gate ----------
let recoveryMode = false; // true while the user is setting a new password

/** Reads an error Supabase puts in the URL (e.g. expired email link), then cleans the URL. */
function readUrlError() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const description = params.get("error_description");
  if (description) history.replaceState(null, "", location.pathname);
  return description || "";
}

function fillAccountMenu() {
  const name = state.profile?.full_name || state.user.user_metadata?.full_name || "Student";
  $("#account-name").textContent = name;
  $("#account-email").textContent = state.user.email || "";
}

/** Shows the app for a session, or the login screen when session is null. */
async function handleSession(session, opts = {}) {
  if (!session) {
    state.user = null;
    state.profile = null;
    renderCount += 1;                                   // any page still loading must not draw
    $("#view").replaceChildren();                       // nothing of the last student stays in the page
    $("#account-menu").hidden = true;
    document.querySelectorAll("dialog").forEach((d) => d.close());
    history.replaceState(null, "", location.pathname);  // forget the page the last student was on
    $("#app-shell").hidden = true;
    $("#auth-root").hidden = false;
    showAuth("login", opts);
    return;
  }
  state.user = session.user;
  let profileLoaded = true;
  try {
    state.profile = await getProfile(session.user.id);
  } catch (error) {
    state.profile = null;
    profileLoaded = false;
    showToast(`Couldn't load your profile. ${error?.reason || "Try refreshing the page."}`);
  }
  // First login: no saved class name means onboarding hasn't been finished.
  if (profileLoaded && !state.profile?.class_name) {
    startOnboarding();
    return;
  }
  enterApp();
}

function enterApp() {
  fillAccountMenu();
  syncThemeFromSettings().catch(() => {}); // use the saved light/dark choice
  $("#auth-root").hidden = true;
  $("#app-shell").hidden = false;
  renderRoute();
}

function startOnboarding() {
  $("#app-shell").hidden = true;
  $("#auth-root").hidden = false;
  showOnboarding({
    onDone: async () => {
      try { state.profile = await getProfile(state.user.id); } catch { /* will reload next visit */ }
      enterApp();
    },
  });
}

function showRecovery() {
  hideBoot();
  $("#app-shell").hidden = true;
  $("#auth-root").hidden = false;
  showAuth("recovery", {
    onDone: async () => {
      recoveryMode = false;
      handleSession(await auth.getSession());
    },
  });
}

const hideBoot = () => $("#boot")?.remove(); // the "Loading StudyFlow..." line from index.html

/** Shown instead of the app when the Supabase keys haven't been added yet. */
function showSetupNotice() {
  hideBoot();
  $("#auth-root").hidden = false;
  $("#auth-root").innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <h1>StudyFlow isn't connected yet</h1>
      <p class="notice">Open <code>js/supabase.js</code> and replace the two placeholder values with your
        Supabase Project URL and Publishable Key, then reload this page.</p>
    </div></div>`;
}

// ---------- Account menu ----------
function setupAccountMenu() {
  const btn = $("#account-btn");
  const menu = $("#account-menu");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { close(); btn.focus(); }
  });

  $("#logout-btn").addEventListener("click", async () => {
    close();
    try {
      await auth.signOut(); // the SIGNED_OUT event below shows the login screen
    } catch (err) {
      showToast(err.message);
    }
  });
}

// ---------- App-wide safety nets ----------
let lastErrorToast = 0;
/** Anything unexpected: logged for you (F12 console), and one calm message for the student. */
function reportUnexpected(error) {
  console.error("Unexpected error:", error);
  const now = Date.now();
  if (now - lastErrorToast > 5000) {
    lastErrorToast = now;
    showToast("Something went wrong. Please try again.");
  }
}

function setupSafetyNets() {
  window.addEventListener("unhandledrejection", (e) => reportUnexpected(e.reason));
  window.addEventListener("error", (e) => reportUnexpected(e.error || e.message));

  // Offline banner. Saving needs the internet; every save already offers a retry.
  const banner = $("#offline-banner");
  const update = () => { banner.hidden = navigator.onLine; };
  window.addEventListener("offline", update);
  window.addEventListener("online", () => { update(); showToast("You're back online."); });
  update();

  // Left open overnight? When the student comes back on a new day, redraw for the new day.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user && shownDay && getToday() !== shownDay) renderRoute();
  });

  // Keyboard users: jump past the menu.
  $("#skip-link").addEventListener("click", () => {
    const target = state.user && !$("#app-shell").hidden ? $("#view") : $("#auth-root");
    target.tabIndex = -1;
    target.focus();
  });
}

function savedTheme() {
  try { return localStorage.getItem("studyflow-theme") || "light"; } catch { return "light"; }
}

// ---------- Boot ----------
async function init() {
  applyTheme(savedTheme());
  setupSafetyNets();
  if (!isConfigured) return showSetupNotice();

  $("#theme-toggle").addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  setupAccountMenu();
  window.addEventListener("hashchange", () => renderRoute({ moveFocus: true }));

  const urlError = readUrlError();

  // Register the listener BEFORE reading the session, so we never miss the
  // PASSWORD_RECOVERY event that fires when the user arrives from a reset link.
  // Keep this callback synchronous: do async work in setTimeout (Supabase advice).
  auth.onAuthChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      recoveryMode = true;
      setTimeout(showRecovery, 0);
    } else if (event === "SIGNED_OUT") {
      recoveryMode = false;
      setTimeout(() => handleSession(null), 0);
    } else if (event === "SIGNED_IN" && !recoveryMode && session?.user.id !== state.user?.id) {
      // (Supabase can re-fire SIGNED_IN when the tab regains focus; same-user repeats are ignored.)
      setTimeout(() => handleSession(session), 0);
    }
  });

  const session = await auth.getSession();
  if (!recoveryMode) await handleSession(session, { error: urlError });
  hideBoot();
}

init();
