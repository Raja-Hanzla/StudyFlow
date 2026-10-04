// Login / signup / forgot password / set new password / check-your-email screens.
// showAuth(mode, opts) renders one screen into #auth-root.
//   opts.notice  friendly message   opts.error  error message
//   opts.email   shown on confirm   opts.onDone called after password reset
import * as auth from "./auth.js";
import { $, escapeHtml, refreshIcons } from "./utils.js";

const MIN_PASSWORD = 8;

// ---------- Validation ----------
function checkEmail(email) {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email address.");
}
function checkPassword(password) {
  if (password.length < MIN_PASSWORD)
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
}

// ---------- Small HTML helpers ----------
const banner = (o) =>
  (o.error ? `<p class="form-error" role="alert">${escapeHtml(o.error)}</p>` : "") +
  (o.notice ? `<p class="notice" role="status">${escapeHtml(o.notice)}</p>` : "");

const field = (id, label, type, autocomplete) => `
  <div class="field">
    <label for="${id}">${label}</label>
    <input id="${id}" name="${id}" type="${type}" autocomplete="${autocomplete}" required />
  </div>`;

const formTail = (buttonText) => `
  <p id="auth-error" class="form-error" role="alert"></p>
  <button class="btn btn-primary btn-block" type="submit">${buttonText}</button>`;

// ---------- Screens ----------
const screens = {
  login: {
    render: (o) => `
      <h1>Log in</h1>
      <p class="muted">Welcome back. Log in to see today's plan.</p>
      ${banner(o)}
      <form id="auth-form" novalidate>
        ${field("email", "Email", "email", "email")}
        ${field("password", "Password", "password", "current-password")}
        ${formTail("Log in")}
      </form>
      <div class="auth-links">
        <button type="button" class="link" data-go="forgot">Forgot password?</button>
        <button type="button" class="link" data-go="signup">Create an account</button>
      </div>`,
    submit: async (f) => {
      const email = f.get("email").trim();
      checkEmail(email);
      await auth.signIn({ email, password: f.get("password") });
      // Success: app.js hears the SIGNED_IN event and opens the app.
    },
  },

  signup: {
    render: (o) => `
      <h1>Create your account</h1>
      <p class="muted">Set up StudyFlow in a couple of minutes.</p>
      ${banner(o)}
      <form id="auth-form" novalidate>
        ${field("name", "Your name", "text", "name")}
        ${field("email", "Email", "email", "email")}
        ${field("password", "Password (min. 8 characters)", "password", "new-password")}
        ${formTail("Sign up")}
      </form>
      <div class="auth-links">
        <button type="button" class="link" data-go="login">I already have an account</button>
      </div>`,
    submit: async (f) => {
      const fullName = f.get("name").trim();
      const email = f.get("email").trim();
      const password = f.get("password");
      if (!fullName) throw new Error("Enter your name.");
      checkEmail(email);
      checkPassword(password);
      const { needsConfirmation } = await auth.signUp({ fullName, email, password });
      if (needsConfirmation) showAuth("confirm", { email });
    },
  },

  forgot: {
    render: (o) => `
      <h1>Reset your password</h1>
      <p class="muted">Enter your email and we'll send you a reset link.</p>
      ${banner(o)}
      <form id="auth-form" novalidate>
        ${field("email", "Email", "email", "email")}
        ${formTail("Send reset link")}
      </form>
      <div class="auth-links">
        <button type="button" class="link" data-go="login">Back to log in</button>
      </div>`,
    submit: async (f) => {
      const email = f.get("email").trim();
      checkEmail(email);
      await auth.sendPasswordReset(email);
      // Same message whether or not the account exists (don't reveal who has an account).
      showAuth("login", { notice: "If an account exists for that email, a reset link is on its way." });
    },
  },

  recovery: {
    render: (o) => `
      <h1>Choose a new password</h1>
      ${banner(o)}
      <form id="auth-form" novalidate>
        ${field("password", "New password (min. 8 characters)", "password", "new-password")}
        ${field("confirm", "Confirm new password", "password", "new-password")}
        ${formTail("Save new password")}
      </form>`,
    submit: async (f, o) => {
      const password = f.get("password");
      checkPassword(password);
      if (password !== f.get("confirm")) throw new Error("The passwords don't match.");
      await auth.updatePassword(password);
      o.onDone?.();
    },
  },

  confirm: {
    render: (o) => `
      <h1>Check your email</h1>
      <p class="notice" role="status">Check your email to confirm your account.</p>
      <p class="muted">We sent a confirmation link to <strong>${escapeHtml(o.email || "your email")}</strong>.
         Click it, and you'll be signed in.</p>
      <div class="auth-links">
        <button type="button" class="link" data-go="login">Back to log in</button>
      </div>`,
    submit: null,
  },
};

// ---------- Render + wire up ----------
export function showAuth(mode = "login", opts = {}) {
  const screen = screens[mode] || screens.login;
  const root = $("#auth-root");

  root.innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <div class="auth-brand"><i data-lucide="book-open-check"></i><span>StudyFlow</span></div>
      ${screen.render(opts)}
    </div></div>`;
  refreshIcons();

  // Links that switch screens
  root.querySelectorAll("[data-go]").forEach((btn) =>
    btn.addEventListener("click", () => showAuth(btn.dataset.go)));

  // Form submit with busy state + error display
  const form = $("#auth-form", root);
  if (form && screen.submit) {
    const button = form.querySelector("button[type=submit]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      $("#auth-error", root).textContent = "";
      const label = button.textContent;
      button.disabled = true;
      button.textContent = "Please wait...";
      try {
        await screen.submit(new FormData(form), opts);
      } catch (err) {
        $("#auth-error", root).textContent = err.message;
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
  }
  root.querySelector("input")?.focus();
}
