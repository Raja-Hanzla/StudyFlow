// Tiny shared store for "who is logged in". Other modules import this
// instead of asking Supabase again. app.js fills it in after login.
export const state = {
  user: null,     // Supabase auth user (id, email, ...)
  profile: null,  // row from the profiles table
};
