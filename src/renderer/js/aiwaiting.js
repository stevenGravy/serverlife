/**
 * Whether an assistant's screen is asking something — a permission, a
 * choice, a yes or no — rather than working or sitting at its prompt.
 *
 * Read from the bottom of the screen once it has stopped changing: a
 * spinner, a stream of output or a timer all change it, a question does
 * not. The patterns are the shapes the assistants ask in, not any one
 * vendor's wording: "Do you want to…", "Allow …?", "(y/n)", a numbered list
 * with a cursor on one of its choices, "Enter to confirm".
 */
const QUESTION = [
  /\bDo you want to\b/i,
  /\bWould you like\b/i,
  /\bDo you trust\b/i,
  /\b(Allow|Approve|Permit|Proceed|Continue)\b[^\n]{0,100}\?/i,
  /\b(Enter|Return) to (confirm|select|continue|approve)\b/i,
  /\bEsc to cancel\b/i,
  /\((y\/n|yes\/no)\)|\[(y\/n|Y\/n|y\/N)\]/,
  /\bPress (any key|Enter)\b/i,
  // A numbered list with the cursor on one of its choices: ❯ 1. Yes
  /^\s*[❯›▶➜>]\s*\d+[.)]\s+\S/m,
  /\bdon[’']t ask again\b/i,
];

/** True when `text` — the last lines of a screen — is asking something. */
export function looksLikeQuestion(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return QUESTION.some((re) => re.test(t));
}

/** The last `n` lines with text on a terminal's screen. */
export function screenTail(term, n = 24) {
  const buf = term?.buffer?.active;
  if (!buf) return '';
  // Up from the last line with anything on it: a tall pane is mostly blank
  // below a short screen, and its bottom rows say nothing.
  const line = (y) => buf.getLine(y)?.translateToString(true) || '';
  let end = buf.baseY + term.rows - 1;
  while (end > buf.baseY && !line(end).trim()) end--;
  const out = [];
  for (let y = Math.max(0, end - n + 1); y <= end; y++) out.push(line(y));
  return out.join('\n');
}
