// Authentication service. Talks to Supabase Auth only; no HTML in this file.
// The screens live in authView.js.
import { supabase } from "./supabase.js";
import { explainError, isFetchFailure } from "./errors.js";

function client() {
  if (!supabase) throw new Error("Supabase isn't configured. Add your keys in js/supabase.js.");
  return supabase;
}

/** Where Supabase should send the user back to from email links. */
function appUrl() {
  return window.location.origin + window.location.pathname;
}

/** Turns Supabase error messages into clear, friendly ones. */
function friendly(error) {
  const msg = (error.message || "").toLowerCase();
  const code = error.code || "";
  if (msg.includes("invalid login credentials")) return new Error("Incorrect email or password.");
  if (code === "email_not_confirmed" || msg.includes("email not confirmed"))
    return new Error("Please confirm your email first. Check your inbox for the confirmation link.");
  if (code === "user_already_exists" || msg.includes("already registered"))
    return new Error("An account with this email already exists. Try logging in.");
  if (code === "weak_password") return new Error(error.message);
  if (code.includes("rate_limit") || msg.includes("rate limit") || error.status === 429)
    return new Error("Too many attempts. Please wait a few minutes and try again.");
  if (isFetchFailure(error)) return new Error(explainError(error));
  return new Error(error.message || "Something went wrong. Please try again.");
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** callback(event, session). Events: SIGNED_IN, SIGNED_OUT, PASSWORD_RECOVERY, ... */
export function onAuthChange(callback) {
  if (!supabase) return;
  supabase.auth.onAuthStateChange((event, session) => callback(event, session));
}

export async function signUp({ fullName, email, password }) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },  // stored as user metadata; the DB trigger can copy it to profiles
      emailRedirectTo: appUrl(),
    },
  });
  if (error) throw friendly(error);
  // With "Confirm email" ON, Supabase creates the user but returns no session
  // until the link in the email is clicked.
  return { needsConfirmation: !data.session };
}

export async function signIn({ email, password }) {
  const { error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw friendly(error);
}

export async function signOut() {
  const { error } = await client().auth.signOut();
  if (error) throw friendly(error);
}

export async function sendPasswordReset(email) {
  const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  if (error) throw friendly(error);
}

/** Used on the "set a new password" screen after clicking the reset link. */
export async function updatePassword(newPassword) {
  const { error } = await client().auth.updateUser({ password: newPassword });
  if (error) throw friendly(error);
}
