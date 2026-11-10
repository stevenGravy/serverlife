import { state } from './state.js';

/**
 * What each session is doing, for the tab strip to show.
 *
 * A row of tabs says what is open and nothing about what is happening in
 * them. That is fine with two; with eight it means clicking through the lot
 * to find the build that is still running, or — worse — the one that stopped
 * four minutes ago on `[sudo] password for steven:` and has been waiting
 * ever since. Both are visible from the output alone, and the output all
 * passes through one function on its way to the terminal.
 *
 * Three states, in order of how much they want you:
 *
 *   waiting — output has stopped at something that reads like a question.
 *             Somebody has to answer it or the session sits there forever.
 *   moving  — bytes arrived just now: a build, a tail, a long install.
 *   idle    — neither.
 *
 * Deliberately built on the byte stream and not on anything the shell is
 * asked, because a probe costs a channel — and on a recorded cluster, an
 * audit entry — every few seconds per pane, which is far too much to pay for
 * a dot on a tab.
 */

/* How long after the last byte a pane still counts as moving. Long enough to
 * ride out the gaps between lines of a build, short enough that a finished
 * command stops spinning while you are still looking at it. */
const MOVING_MS = 900;

/* And how long it has to have been quiet before a question counts as one
 * waiting for an answer, rather than a line that output happens to have
 * paused on. */
const SETTLE_MS = 400;

/**
 * The tail kept per pane.
 *
 * Long enough to hold a whole permission box — a coding agent asks its
 * question several lines above the options it then draws, and the question
 * is the part worth reading — and short enough that keeping one per pane
 * costs nothing.
 */
const TAIL = 700;

const panes = new Map();   // paneId -> { at, tail }

/**
 * Lines that are asking for something.
 *
 * A tight list on purpose. Every pattern here is a real thing that stops a
 * session dead — a credential, a confirmation, a key to press — and anchored
 * to the end of the output, because that is the difference between a prompt
 * waiting for you and the same words scrolling past in a log. A generic "ends
 * in a question mark" was tried and is far too eager: pagers, progress bars
 * and half-drawn lines all trip it, and a highlight that cries wolf is worse
 * than no highlight at all.
 */
const LAST_LINE = [
  /(?:password|passphrase|passcode)(?:[^\n]{0,40})?:\s*$/i,
  /\[sudo\] password for [^\n]*:\s*$/i,
  /\[y\/n\]\s*\??\s*$/i,
  /\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/i,
  /\b(?:y\/n|yes\/no)\b[^\n]{0,20}\?\s*$/i,
  /press (?:enter|return|any key)[^\n]*$/i,
  /(?:are you sure|do you want to|continue|proceed|overwrite|replace)[^\n]{0,40}\?\s*$/i,
  /(?:otp|mfa|verification|authentication) code[^\n]{0,20}:?\s*$/i,
  /tap any security key/i,
  /enter your (?:otp|code|token)[^\n]*$/i,
];

/**
 * And the ones that are not on the last line.
 *
 * A coding agent asking permission — Claude Code, Codex — draws a box: the
 * question, then the options, then a hint about escape. By the time it is
 * waiting, the last line is `3. No, and tell Claude what to do differently`
 * or the bottom edge of the box, and the question it wants answered is four
 * lines up. Anchoring to the last line misses every one of them, which is a
 * shame, because an agent sitting on an unanswered permission prompt in a
 * tab you are not looking at is the best example there is of what this mark
 * is for: it will wait there all afternoon.
 */

/** Phrases that mean somebody is being asked, not told. */
const ASKING = [
  /\byes,? and (?:don.t ask again|approve)/i,
  /\bno,? and tell (?:claude|codex|the agent)/i,
  /\bwaiting for (?:your )?(?:approval|confirmation|input)\b/i,
  /\ballow (?:this )?(?:command|tool|edit|request)\b[^\n]{0,30}\?/i,
  /\bapprove (?:this|the) (?:command|edit|change|tool)\b/i,
  /\bpress (?:1|y|enter) to (?:confirm|approve|continue)\b/i,
  /\bdo you want to [^\n]{0,70}\?/i,
  /\bwould you like to [^\n]{0,70}\?/i,
];

/** An option, a border, or the escape hint: the furniture of a prompt box. */
const BOX_LINE = [
  /^[\s\u2502|]*[\u276f>*]?\s*\d+[.)]\s+\S/,
  /^[\s\u2502\u2500\u256d\u256e\u256f\u2570\u250c\u2510\u2514\u2518\u251c\u2524]+$/,
  /\besc to (?:cancel|reject|interrupt|go back)\b/i,
  /^[\s\u2502|]*\(?y(?:es)?\)?\s*[/|]\s*\(?n(?:o)?\)?\s*$/i,   // a bare "y / n" line
  /^\s*[\u276f>]\s*$/,
];

/**
 * Does the output read as something waiting for an answer?
 *
 * Two ways in. A shell asks on the line the cursor is sitting on, which the
 * anchored patterns above cover. An agent asks inside a box: the question,
 * then the options, then a hint about escape — so the question is found in
 * the last handful of lines instead.
 *
 * What makes the second kind safe is insisting the **last line still belongs
 * to the prompt** — an option, a border, the escape hint, or the asking
 * phrase itself. A question with the box still under it is a question; the
 * same words with a shell prompt after them are scrollback, and lighting a
 * tab up for those would mean any transcript, log or answered prompt left it
 * amber all afternoon.
 */
export function looksLikePrompt(tail) {
  const text = String(tail || '').replace(/\s+$/, '');
  if (!text) return false;

  // Blank rows below the box — a screen is a fixed height and the thing
  // drawn on it rarely fills the last row.
  const lines = text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return false;
  const last = lines[lines.length - 1];
  if (LAST_LINE.some((re) => re.test(last))) return true;

  const stillOnScreen = BOX_LINE.some((re) => re.test(last))
    || ASKING.some((re) => re.test(last));
  if (!stillOnScreen) return false;

  // The last handful of lines, not the whole scrollback: a question answered
  // a minute ago is not a question any more.
  const recent = lines.slice(-12).join('\n');
  return ASKING.some((re) => re.test(recent));
}

/**
 * Escape sequences, out. The tail is matched against as text, and a cursor
 * move or a colour in the middle of `password:` would hide it. This is the
 * cheap version — the full grammar is xterm's job, not ours.
 */
function plain(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')   // OSC (window titles)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')                        // CSI (colour, cursor)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[()][B0UK]/g, '')                                    // charset selection
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    /*
     * A terminal ends its lines with CR LF, and uses a bare CR to draw
     * over the line it is on — a progress bar, a spinner. Either way what
     * is on screen is whatever came after the last one, so treating it as
     * a line break is both simpler and closer to the truth than carrying
     * stray carriage returns into patterns that anchor to the end of a
     * line.
     */
    .replace(/\r\n?/g, '\n');
}

/**
 * Output has arrived in a pane.
 *
 * On the hot path: every chunk of every session goes through here, so it
 * does as little as it can get away with — a timestamp, and a couple of
 * hundred characters kept for the prompt test. A big chunk is trimmed before
 * it is cleaned rather than after, so a megabyte of `cat` costs the same as
 * a line of it.
 */
export function noteOutput(paneId, data) {
  if (!paneId || !data) return;
  const raw = data.length > 400 ? data.slice(-400) : data;
  const prev = panes.get(paneId);
  const tail = ((prev?.tail || '') + plain(raw)).slice(-TAIL);
  panes.set(paneId, { at: Date.now(), tail });
}

/** A pane that has gone takes its record with it. */
export function forgetPane(paneId) {
  panes.delete(paneId);
}

/**
 * What is on the pane's screen, where that can be read.
 *
 * The byte stream says *when* something happened, which is all the moving
 * state needs. It is a poor guide to *what is on screen*, though: a
 * full-screen program paints by moving the cursor and rewriting lines, so
 * the end of the stream is whichever line it redrew last. A coding agent's
 * permission box is exactly that — the question, the options and the "Esc
 * to cancel" footer are all rewritten in place — and reading it from the
 * stream found the box in pieces and in the wrong order. The terminal
 * buffer is the only honest answer, and asking it costs a handful of rows
 * once a quarter of a second, and only for panes that have gone quiet.
 */
function screenOf(paneId) {
  try {
    return state.getPane(paneId)?.view?.screenTail?.(16) || '';
  } catch { return ''; }
}

/** 'moving' | 'waiting' | 'idle' for one pane. */
export function paneActivity(paneId) {
  const rec = panes.get(paneId);
  if (!rec) return 'idle';
  const since = Date.now() - rec.at;
  if (since >= SETTLE_MS && looksLikePrompt(screenOf(paneId) || rec.tail)) return 'waiting';
  if (since < MOVING_MS) return 'moving';
  return 'idle';
}

/**
 * And for a tab, which may hold several panes: the state of whichever of
 * them wants you most. A tab with a build in one pane and a password prompt
 * in the other is a tab you should open because of the password.
 */
export function tabActivity(tabId) {
  let out = 'idle';
  for (const id of state.panesOf(tabId)) {
    const a = paneActivity(id);
    if (a === 'waiting') return 'waiting';
    if (a === 'moving') out = 'moving';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

/** Whether the tabs report what their sessions are doing at all. */
export function showTabActivity() {
  return state.settings.showTabActivity !== false;
}

/**
 * The state is written onto the tabs that already exist rather than by
 * redrawing the strip.
 *
 * Output arrives in a stream, and a tab strip rebuilt on every chunk would
 * throw away hover, drop the element under a half-finished click, and cost
 * a layout per frame of a build's output. Toggling two classes costs
 * nothing, and the strip is rebuilt only when the tabs themselves change.
 */
export function paintTabActivity() {
  const on = showTabActivity();
  for (const node of document.querySelectorAll('#tabstrip .tab')) {
    const id = node.dataset.tab;
    if (!id) continue;
    /*
     * Nothing is reported about the tab you are looking at.
     *
     * The mark answers "which of these is doing something?", and for the tab
     * on screen you are already looking at the answer — the output is right
     * there, scrolling. A ripple beside it is an animation in the corner of
     * your eye that tells you what you can plainly see, which is the kind of
     * movement that makes an interface tiring rather than informative. The
     * moment you switch away it appears, because from then on it is news.
     */
    const a = on && id !== state.activeTabId ? tabActivity(id) : 'idle';
    node.classList.toggle('moving', a === 'moving');
    node.classList.toggle('waiting', a === 'waiting');
    const mark = node.querySelector('.tact');
    if (mark) {
      mark.title = a === 'waiting' ? 'Waiting for an answer in this tab'
        : a === 'moving' ? 'Output is arriving in this tab' : '';
    }
  }
}

/**
 * One timer for the whole strip.
 *
 * Both states are defined by time passing — moving becomes idle because
 * nothing has arrived, a question becomes a waiting one because it has sat
 * there — so something has to look at the clock. A quarter of a second is
 * under the threshold of a state looking stale and far above the cost of
 * reading a handful of timestamps.
 */
let timer = null;
export function initActivity() {
  clearInterval(timer);
  timer = setInterval(paintTabActivity, 250);
}

/**
 * The preference has changed: clear whatever is on the strip and let the
 * next tick put back whatever is still true. Turning it off has to take the
 * marks off immediately — a setting that waits for the next tab to change
 * before it applies reads as a setting that did not work.
 */
export function refreshTabActivity() {
  if (!showTabActivity()) {
    for (const node of document.querySelectorAll('#tabstrip .tab')) {
      node.classList.remove('moving', 'waiting');
    }
    return;
  }
  paintTabActivity();
}
