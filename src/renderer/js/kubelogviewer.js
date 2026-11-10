import { el, clear } from './util.js';
import { toast, checkbox } from './ui.js';
import { openKubeLogViewerTab } from './sessions.js';

/**
 * The Log Viewer: one pod, or every pod behind a label selector, as plain
 * searchable lines rather than a terminal — kubelogs.js streams them in,
 * this keeps a capped buffer and renders whatever currently matches the
 * filter box. A `kubectl logs -f` pane already covers "watch it scroll";
 * this covers "find the one line that matters, and keep a copy after."
 *
 * Capped at MAX_LINES kept in memory — a session left running for hours
 * would otherwise grow without bound. Download always writes the full,
 * unfiltered buffer that's still held, not just what the filter shows.
 */
const MAX_LINES = 20000;

export async function openKubeLogViewer(kubeSpec, target = {}, title) {
  const paneTitle = title || target.selector || target.podName || 'Logs';
  const pane = await openKubeLogViewerTab(paneTitle);
  pane.kubeSpec = kubeSpec;
  pane.kubeLogTarget = target;
  pane.kubeTitle = paneTitle;

  let lines = [];
  let trimmed = false;
  let filterText = '';
  let useRegex = false;
  let follow = true;
  let running = false;
  let sessionId = null;
  let statusLine = '';

  const body = pane.klvRoot;
  let logEl = null;
  let unsubscribe = null;

  const matches = (line) => {
    if (!filterText) return true;
    if (!useRegex) return line.toLowerCase().includes(filterText.toLowerCase());
    try { return new RegExp(filterText, 'i').test(line); } catch { return true; }
  };

  const renderLines = () => {
    if (!logEl) return;
    clear(logEl);
    const shown = lines.filter(matches);
    for (const line of shown) logEl.append(el('div', { class: 'klv-line', text: line }));
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  };

  const addLines = (newOnes) => {
    lines.push(...newOnes);
    if (lines.length > MAX_LINES) { lines = lines.slice(lines.length - MAX_LINES); trimmed = true; }
    render();
  };

  const stopSession = () => {
    if (sessionId) window.api.kube.logsStop({ id: sessionId }).catch(() => {});
    sessionId = null;
    running = false;
  };
  // Picked up by sessions.js's closePane() — the one way this pane's own
  // spawned kubectl process (and its push-event listener) is told to stop
  // when the pane itself closes, rather than idling until the app quits.
  pane.klvStop = () => { stopSession(); unsubscribe?.(); };

  const startSession = async () => {
    stopSession();
    try {
      const r = await window.api.kube.logsStart({ spec: kubeSpec, ...target });
      if (!r?.ok) { statusLine = r?.error || 'Could not start reading logs'; running = false; render(); return; }
      sessionId = r.id;
      running = true;
      statusLine = '';
      render();
    } catch (e) {
      statusLine = e?.message || 'Could not start reading logs';
      running = false;
      render();
    }
  };

  unsubscribe = window.api.kube.onLogsData((evt) => {
    if (evt.id !== sessionId) return;
    if (evt.done) {
      running = false;
      statusLine = evt.error || (evt.code ? `kubectl exited with code ${evt.code}` : 'Stopped');
      render();
      return;
    }
    if (evt.line !== undefined) addLines([evt.line]);
  });

  const render = () => {
    clear(body);
    const filterInput = el('input', { type: 'text', value: filterText, placeholder: 'Filter…' });
    filterInput.addEventListener('input', () => { filterText = filterInput.value; renderLines(); });
    const regexBox = checkbox('Regex', useRegex);
    regexBox.input.addEventListener('change', () => { useRegex = regexBox.input.checked; renderLines(); });
    const followBox = checkbox('Follow', follow);
    followBox.input.addEventListener('change', () => { follow = followBox.input.checked; if (follow) renderLines(); });

    const downloadLog = async () => {
      const text = lines.join('\n') + (lines.length ? '\n' : '');
      const saved = await window.api.dialog.saveText({
        text, defaultPath: `${paneTitle.replace(/[^\w.-]+/g, '-')}.log`, title: `Download ${paneTitle}`,
      });
      if (saved) toast(`Saved ${saved.path}`);
    };

    body.append(
      el('div', { class: 'klv-bar' },
        filterInput, regexBox, followBox,
        el('span', { style: 'margin-left:auto;color:var(--muted);font-size:11px', text: `${lines.length}${trimmed ? '+' : ''} line(s)` }),
        el('button', {
          class: 'ghost-btn sm', text: running ? 'Stop' : 'Restart',
          onClick: () => { if (running) { stopSession(); render(); } else { startSession(); } },
        }),
        el('button', { class: 'ghost-btn sm', text: 'Download…', onClick: downloadLog }),
      ),
      trimmed ? el('div', { class: 'hint', text: `Only the most recent ${MAX_LINES.toLocaleString()} lines are kept — earlier lines were dropped.` }) : null,
      statusLine ? el('div', { class: 'hint', text: statusLine }) : null,
      el('div', { class: 'klv-log' }),
    );
    logEl = body.querySelector('.klv-log');
    renderLines();
  };

  render();
  await startSession();
  return pane;
}

/** A saved Log Viewer pane, reopened after a restart — checked against the cluster first, same as a pod exec/logs pane. */
export async function reopenKubeLogViewer(saved) {
  const { resolveKubeTarget } = await import('./kubepanel.js');
  const name = saved.title || saved.target?.selector || saved.target?.podName || 'the log viewer';
  const spec = await resolveKubeTarget(saved.spec || {}, name);
  if (!spec) return false;
  await openKubeLogViewer(spec, saved.target || {}, saved.title);
  return true;
}
