// Shared fixed values. They match the allowed values in your database.
export const DIFFICULTIES = ["easy", "medium", "hard"];
export const PRIORITIES = ["low", "normal", "high"];
export const DEFAULT_DIFFICULTY = "medium";
export const DEFAULT_PRIORITY = "normal";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Subject colors, handed out in order (editable later on the Subjects page).
export const SUBJECT_COLORS = ["#3b5bdb", "#2f9e44", "#e8890c", "#ae3ec9", "#0c8599", "#d6336c", "#5f3dc4", "#868e96"];

// The value written to topics.status when a topic is studied for the first time.
// null = leave the column alone (the database default applies). Once you know
// your allowed status values, put the right one here, e.g. "studied".
export const TOPIC_STATUS = { studied: null };
