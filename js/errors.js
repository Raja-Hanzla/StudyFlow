// Turns a raw error into a short, honest reason. The app only blames the internet when the
// browser itself says it is offline; everything else reports what actually went wrong.

/** True when the request never reached Supabase (wrong URL, paused project, blocker, no network). */
export function isFetchFailure(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return /failed to fetch|networkerror|load failed|network request failed/.test(text);
}

/** One sentence describing the real cause. */
export function explainError(error) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You're offline. Reconnect and try again.";
  }
  if (isFetchFailure(error)) {
    return "The browser couldn't reach Supabase. Check that the Project URL in js/supabase.js is correct, " +
      "that your Supabase project isn't paused, and that no extension (ad blocker, VPN) is blocking it.";
  }
  const raw = String(error?.message || error || "");
  if (raw.includes("daily_minutes") || raw.includes("topics_per_day")) {
    return "Your Supabase subjects table is missing the daily_minutes / topics_per_day columns. Run the SQL from the README (section 1, step 4), then reload.";
  }
  const message = String(error?.message || error || "").trim();
  return message ? `The database said: ${message}` : "An unknown error happened.";
}
