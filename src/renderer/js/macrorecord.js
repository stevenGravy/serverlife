import { state } from './state.js';
import { el } from './util.js';
import { modal, toast, status, checkbox } from './ui.js';

/**
 * Record a macro: work in a session as usual, and what you ran becomes one.
 *
 * Keystrokes are the wrong thing to keep — Tab completion, the history, the
 * arrow keys and backspace would all be replayed as keys, against a shell in
 * a different state. What is kept is each command as it stood when Enter was
 * pressed, read off the screen from where its typing began: what Tab filled
 * in and what the Up arrow brought back are on the screen, so they are in the
 * command. A line still being typed when recording stops is read the same way
 * and offered as the last step, marked as not run.
 *
 * Not recorded: anything typed into a full-screen program (vim, less, top —
 * the alternate screen), a line abandoned with Ctrl+C, and what is typed at a
 * prompt that does not echo — a password is not on the screen to be read. A
 * line that looks as though it carries a secret is recorded but left unticked
 * in the review.
 *
 * Stopping shows the steps to keep, edit, reorder or drop, and then the
 * ordinary macro editor, already filled in.
 */

/* ------------------------------------------------------------------ */
/* Pure parts                                                          */
/* ------------------------------------------------------------------ */

/**
 * The command in a run of screen lines: from column `startX` of the first to
 * the end of the last, a wrapped line joined to the one before it and an
 * unwrapped one (a shell's continuation, `> `) on a line of its own.
 * `lines` are { text, wrapped }.
 */
export function commandFromLines(lines, startX = 0) {
  let out = '';
  lines.forEach((l, i) => {
    const text = i === 0 ? l.text.slice(startX) : l.text;
    if (i === 0) out = text;
    else if (l.wrapped) out += text;
    else out += '\n' + text.replace(/^\s*>\s?/, '');
  });
  out = out.replace(/\s+$/, '');
  // Accepted from bash's reverse search before the shell redrew the line.
  const rs = out.match(/^\((?:reverse|bck)-i-search\)`[^']*':\s?(.*)$/s);
  if (rs) out = rs[1];
  return out.trim();
}

/** A command that looks as though a secret is written into it. */
export function looksSecret(cmd) {
  return /(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key)\s*[=:]\s*\S|--pass(word)?[= ]\S|(^|\s)-p[^\s-]\S{3,}|authorization:\s*\S/i.test(String(cmd || ''));
}

/** The kept steps as one macro command, each on its own line. */
export function macroCommand(steps, { stopOnFail = false } = {}) {
  const lines = steps.map((s) => String(s).trim()).filter(Boolean);
  // `a &&` at the end of a line carries on to the next, so the first failure
  // stops the rest — written out, so it can be read and changed.
  return stopOnFail ? lines.join(' &&\n') : lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Reading the screen                                                  */
/* ------------------------------------------------------------------ */

/** The colour a cell is drawn in, to tell typed text from a suggestion. */
const ink = (cell) => (cell ? `${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.isDim()}` : '');

/**
 * The line being typed, from where its typing began to the cursor — and past
 * the cursor only while the text is drawn the way the typed text is. Grey
 * text after the cursor is zsh's or fish's suggestion, and text far to the
 * right in another colour is a right-hand prompt; neither was run.
 */
function readCommand(term, start) {
  const buf = term.buffer.active;
  const endY = buf.baseY + buf.cursorY;
  if (endY < start.y || endY - start.y > 40) return '';
  const lines = [];
  for (let y = start.y; y <= endY; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    let text = line.translateToString(true);
    if (y === endY) {
      const ref = ink(line.getCell(Math.max(0, buf.cursorX - 1)));
      let end = buf.cursorX;
      for (let x = buf.cursorX; x < line.length; x++) {
        const c = line.getCell(x);
        const ch = c?.getChars() || ' ';
        if (ch.trim() && ink(c) !== ref) break;
        end = x + 1;
      }
      text = text.slice(0, end);
    }
    lines.push({ text, wrapped: y > start.y && line.isWrapped });
  }
  return commandFromLines(lines, start.x);
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

export function isRecording(pane) { return !!pane?.recorder; }

/** Start recording in a pane. */
export function startRecording(pane = state.activePane) {
  if (!pane?.termId || !pane.view?.term) return toast('Open a session to record in', 'error');
  if (pane.kind === 'vnc' || pane.kind === 'device') return toast('Recording is for shell sessions', 'error');
  if (pane.recorder) return;
  pane.recorder = { steps: [], start: null, since: Date.now() };
  drawBadge(pane);
  status('Recording — run the commands for the macro, then press ● Stop in the pane’s header', 8000);
  pane.view.focus?.();
}

/**
 * What was typed into a recording pane. Called before the keys are sent, so
 * the cursor is still where the shell left it.
 */
export function recordInput(pane, data) {
  const r = pane.recorder;
  const term = pane.view?.term;
  if (!r || !term) return;
  const buf = term.buffer.active;
  // A full-screen program: its keys are not commands.
  if (buf.type === 'alternate') { r.start = null; return; }

  /*
   * A bracketed paste lands in the shell's line as text and runs at the next
   * Enter, where it is read off the screen with the rest. A paste without
   * brackets runs line by line as it arrives, so its lines are the commands.
   */
  if (data.startsWith('\x1b[200~')) {
    if (!r.start) r.start = { x: buf.cursorX, y: buf.baseY + buf.cursorY };
    return;
  }
  if (data.length > 1 && /[\r\n]/.test(data) && !data.startsWith('\x1b')) {
    const before = r.start ? readCommand(term, r.start) : '';
    const parts = data.split(/\r\n|\r|\n/);
    const last = parts.pop();
    parts[0] = before + parts[0];
    for (const p of parts) add(pane, p);
    r.start = last ? { x: buf.cursorX, y: buf.baseY + buf.cursorY } : null;
    return;
  }

  if (data === '\r' || data === '\n') {
    if (r.start) add(pane, readCommand(term, r.start));
    r.start = null;
    return;
  }
  // Ctrl+C or Ctrl+U: the line is abandoned.
  if (data === '\x03' || data === '\x15') { r.start = null; return; }
  // Ctrl+D on an empty line ends the shell; nothing to record.
  if (data === '\x04') return;
  // The first key of a new line marks where its command starts.
  if (!r.start) r.start = { x: buf.cursorX, y: buf.baseY + buf.cursorY };
}

function add(pane, cmd) {
  const c = String(cmd || '').trim();
  if (!c) return;
  pane.recorder.steps.push(c);
  drawBadge(pane);
}

/** The ● in the pane's header: how many steps so far, and Stop. */
function drawBadge(pane) {
  const head = pane.head;
  if (!head) return;
  let badge = head.querySelector('.rec-badge');
  if (!pane.recorder) { badge?.remove(); return; }
  if (!badge) {
    badge = el('button', {
      class: 'rec-badge', title: 'Recording a macro — click to stop and review what was recorded',
      onClick: (e) => { e.stopPropagation(); stopRecording(pane); },
    });
    const name = head.querySelector('.pname');
    name ? name.after(badge) : head.prepend(badge);
  }
  const n = pane.recorder.steps.length;
  badge.textContent = `● Stop recording · ${n} step${n === 1 ? '' : 's'}`;
}

/** Stop, review the steps, and hand them to the macro editor. */
export async function stopRecording(pane = state.activePane) {
  const r = pane?.recorder;
  if (!r) return;
  // A line typed but not yet run with Enter is the last step, marked as such.
  const term = pane.view?.term;
  const typed = r.start && term && term.buffer.active.type !== 'alternate' ? readCommand(term, r.start) : '';
  pane.recorder = null;
  drawBadge(pane);
  if (!r.steps.length && !typed) return status('Recording stopped — nothing was run');

  const rows = el('div', { class: 'rec-steps' });
  const steps = r.steps.map((cmd) => ({ cmd, keep: !looksSecret(cmd) }));
  if (typed) steps.push({ cmd: typed, keep: !looksSecret(typed), typed: true });
  const draw = () => {
    rows.replaceChildren(...steps.map((s, i) => {
      const keep = el('input', { type: 'checkbox' });
      keep.checked = s.keep;
      keep.addEventListener('change', () => { s.keep = keep.checked; });
      const text = el('input', { type: 'text', class: 'rec-cmd', value: s.cmd, spellcheck: 'false' });
      text.addEventListener('input', () => { s.cmd = text.value; });
      const move = (d) => () => {
        const j = i + d;
        if (j < 0 || j >= steps.length) return;
        [steps[i], steps[j]] = [steps[j], steps[i]];
        draw();
      };
      return el('div', { class: 'rec-step' + (looksSecret(s.cmd) ? ' secret' : '') },
        keep, el('span', { class: 'rec-n', text: String(i + 1) }), text,
        el('button', { class: 'icon-btn sm', text: '↑', title: 'Earlier', onClick: move(-1) }),
        el('button', { class: 'icon-btn sm', text: '↓', title: 'Later', onClick: move(1) }),
        s.typed ? el('span', { class: 'rec-typed', text: 'typed, not run', title: 'On the command line when recording stopped — Enter had not been pressed' }) : null,
        looksSecret(s.cmd) ? el('span', { class: 'rec-warn', text: 'looks like a secret', title: 'Left out unless you tick it — a macro is saved as plain text' }) : null);
    }));
  };
  draw();
  const stopOnFail = checkbox('Stop at the first step that fails', true);

  const res = await modal({
    title: `Recorded ${steps.length} step${steps.length === 1 ? '' : 's'}`,
    width: 'min(720px, 94vw)',
    render: (b) => b.append(
      el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'Untick a step to leave it out; edit one in place. Next, name the macro and choose where it runs.' }),
      rows, stopOnFail),
    buttons: [
      { label: 'Discard', value: 'discard' },
      { label: 'Keep recording', value: 'more' },
      { label: 'Next', class: 'primary-btn', value: 'next' },
    ],
  });
  if (res === 'more') {
    // The typed line is still on the command line: it is read again at Enter.
    pane.recorder = { ...r, steps: steps.filter((s) => s.keep && !s.typed).map((s) => s.cmd), start: r.start };
    drawBadge(pane);
    return;
  }
  if (res !== 'next') return status('Recording discarded');

  const kept = steps.filter((s) => s.keep && s.cmd.trim()).map((s) => s.cmd);
  if (!kept.length) return status('No steps kept — nothing saved');
  const { editMacro, macroKindOf } = await import('./macros.js');
  const where = { local: 'local', beam: 'beams' }[macroKindOf(pane)] || 'hosts';
  const saved = await editMacro({
    name: '', category: 'Recorded', where,
    description: `Recorded on ${pane.kind === 'local' ? 'the local shell' : (state.getConnection(pane.connId)?.label || pane.title || 'a session')}, ${new Date(r.since).toLocaleDateString()}`,
    command: macroCommand(kept, { stopOnFail: stopOnFail.input.checked }),
  });
  if (saved) status(`Saved ${saved.name} — in the ▶ menu`);
}
