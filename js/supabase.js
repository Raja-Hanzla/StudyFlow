// =====================================================================
// Supabase connection: the ONLY place the client is created.
// Every other file does: import { supabase } from "./supabase.js";
// =====================================================================
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ---------- CONFIGURATION: replace these two values ----------
const SUPABASE_URL = "https://gncjujhuedossdobokex.supabase.co";           // e.g. https://abcd1234.supabase.co
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fyUjmrj4hrD3sRzT8nwTGw_JJCY8ThY"; // starts with sb_publishable_...
// -------------------------------------------------------------
// Never put a secret key, service_role key or database password here.
// The publishable key is safe in the browser because Row Level Security
// decides what each logged-in user can read or write.

export const isConfigured =
  !SUPABASE_URL.startsWith("YOUR_") && !SUPABASE_PUBLISHABLE_KEY.startsWith("YOUR_");

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,      // keep the user logged in across reloads
        autoRefreshToken: true,
        detectSessionInUrl: true,  // needed for email-confirmation / reset links
      },
    })
  : null;

/**
 * Checks that the URL + key work and that the tables are reachable.
 * Returns { ok: boolean, message: string }.
 *
 * Logged out, RLS hides every row, so a working connection returns count 0
 * with no error. A wrong URL/key or a missing table returns an error.
 */
export async function testConnection() {
  if (!isConfigured) {
    return { ok: false, message: "Add your Project URL and Publishable Key in js/supabase.js." };
  }
  try {
    const { error } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true });
    if (error) return { ok: false, message: `Supabase responded with an error: ${error.message}` };
    return { ok: true, message: "Connected to Supabase. The profiles table is reachable." };
  } catch (err) {
    return { ok: false, message: `Couldn't reach Supabase. Check your URL and internet connection. (${err.message})` };
  }
}
