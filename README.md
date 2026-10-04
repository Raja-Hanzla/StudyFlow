# StudyFlow

A study planner that works out **what to study today, what to recall today, and when to recall it again**.
You study in your own way, outside the app. StudyFlow only schedules and tracks. There are no flashcards and no answers to type.

Plain HTML, CSS and JavaScript (ES modules). It talks directly to your Supabase project. There is no build step and no server of your own.

## 1. Set up

1. Open `js/supabase.js` and replace the two values at the top with your **Project URL** and **Publishable Key**
   (Supabase dashboard, Project Settings, API). Never use the secret or `service_role` key.
2. In the Supabase dashboard, open **Authentication, URL Configuration**:
   - set **Site URL** to the address you open the app at (for example `http://localhost:5500`);
   - add the same address followed by `/**` to **Redirect URLs**.
   Email confirmation and password-reset links return to this address. `localhost` and `127.0.0.1` count as different addresses.
3. Under **Authentication, Providers, Email**, keep **Confirm email** on.

## 2. Run it

Browsers block ES modules opened straight from a file, so use any small local server from this folder:

```
python -m http.server 5500
```

then open http://localhost:5500. (Or use the *Live Server* extension in VS Code.)

To put it online, upload the whole folder to any static host (Netlify, GitHub Pages, Cloudflare Pages...), then add that address to the Supabase Site URL and Redirect URLs as in step 1.

## 3. Tests

The scheduling rules and the backup format are tested without a browser (Node 22 or newer):

```
node tests/scheduler.test.mjs
node tests/backup.test.mjs
```

## 4. How the code is organised

| File | Job |
|---|---|
| `js/supabase.js` | The only place the Supabase client is created. Your keys go here. |
| `js/database.js` | The only file that reads or writes tables. Everything else calls its functions. |
| `js/scheduler.js` | Scheduling rules. Pure logic: no page, no database, no clock. The tunable numbers are in `CONFIG` at the top. |
| `js/planner.js` | Connects the scheduler to the database: rebuild the plan, record Done / Partial / Missed. |
| `js/app.js` | Start-up, sign-in gate, page routing, app-wide error handling. |
| `js/auth.js`, `js/authView.js` | Sign up, log in, password reset: the logic and the screens. |
| `js/onboarding.js` | First-login setup wizard. |
| `js/dashboard.js`, `session.js`, `subjects.js`, `calendar.js`, `progress.js`, `insights.js`, `settings.js` | One file per page. |
| `js/stats.js` | Counts for the Progress and Insights pages. |
| `js/backup.js`, `js/exportImport.js` | Backup file format and checking; download and restore. |
| `js/ui.js`, `js/utils.js`, `js/theme.js`, `js/state.js`, `js/constants.js`, `js/bulk.js` | Shared helpers. |
| `css/variables.css` | Colors, spacing, fonts. Change the look here. |
| `css/style.css`, `css/responsive.css` | Components, and the tablet / phone layouts. |

## 5. How scheduling works, in short

- A topic never studied gets a **study** task. A studied topic gets a **recall** task on its `next_recall_at` day.
- Recall gaps grow with `recall_stage`: 1, 3, 7, 14, then 30 days. Hard topics come back sooner, easy ones later, and gaps shrink as an exam gets close.
- Nothing is scheduled after the day before an exam.
- Each day holds at most your available minutes (set per weekday in Settings). When there is too little time, the most important work goes first: overdue, closer exam, high priority, hard, unfinished study, then ordinary recalls.
- A task left pending for more than 2 days is counted as missed, so a backlog never builds up.

## 6. Good to know

- When something can't load or save, the message states the real cause (offline, Supabase unreachable, or the database's own error). Press F12 > Console for the full technical error.
- Saving needs an internet connection. A failed save shows **Unable to save, retry** and never creates duplicates when retried. Nothing is cached for offline use.
- `topics.status` is not written by the app (the database default applies). If you want it filled in, set `TOPIC_STATUS.studied` in `js/constants.js` to one of your allowed values.
- **Reset account data** and a **Replace** import delete rows from every study table, so each table needs a row-level-security policy that lets a user delete their own rows.
- Supabase's built-in email sender allows only a few emails per hour. For real use, connect your own email provider in the Supabase dashboard.
