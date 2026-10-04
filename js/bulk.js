// Turns pasted text into topics. Used by onboarding now and by the
// "Add many topics" dialog on the Subjects page.
import { DIFFICULTIES, PRIORITIES } from "./constants.js";

/**
 * One topic per line. Bullets/numbers are stripped and duplicates ignored.
 * Optional extras after "|" set that topic only:   Velocity | hard | high
 * @param {string} text
 * @param {{difficulty:string, priority:string}} defaults used when a line has no extras
 * @returns {{name:string, difficulty:string, priority:string}[]}
 */
export function parseTopicLines(text, defaults) {
  const seen = new Set();
  const topics = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!line) continue;
    const [name, ...extras] = line.split("|").map((part) => part.trim());
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    const topic = { name, difficulty: defaults.difficulty, priority: defaults.priority };
    for (const word of extras.map((e) => e.toLowerCase())) {
      if (DIFFICULTIES.includes(word)) topic.difficulty = word;
      else if (PRIORITIES.includes(word)) topic.priority = word;
    }
    topics.push(topic);
  }
  return topics;
}
