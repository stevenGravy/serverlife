import RFB from '@novnc/novnc';
import { el } from './util.js';
import { status, toast, prompt } from './ui.js';
import { state } from './state.js';

/**
 * A VNC screen in a pane.
 *
 * Everything hard about this lives elsewhere — noVNC decodes RFB, and the
 * main process carries the bytes — so what is left here is the part a viewer
 * usually gets wrong: saying what is happening. A screen that is black
 * because the server wants a password, because the host refused the
 * connection, or because the desktop is genuinely black are three different
 * situations that look identical, and a blank pane that explains nothing is
 * the commonest complaint about every VNC client ever written.
 */

/** Open (or reopen) the screen this pane is for. */
export async function connectVnc(pane) {
  const spec = pane.vncSpec || {};
  const host = pane.view.screen;
  host.replaceChildren();
  const note = el('div', { class: 'vnc-note' },
    el('div', { class: 'vnc-title', text: `Connecting to ${spec.host}:${spec.port || 5900}…` }));
  host.append(note);

  let session = null;
  try {
    session = await window.api.vnc.prepare({ host: spec.host, port: spec.port || 5900 });
  } catch (e) {
    return showFailure(pane, e.message);
  }
  pane.vncToken = session.token;

  const screen = el('div', { class: 'vnc-screen' });
  host.append(screen);

  let rfb;
  try {
    rfb = new RFB(screen, session.url, {
      credentials: spec.password ? { password: spec.password } : undefined,
      shared: spec.shared !== false,
      wsProtocols: [],
    });
  } catch (e) {
    return showFailure(pane, e.message);
  }

  /*
   * Scaling rather than clipping, unless asked otherwise.
   *
   * A remote desktop is nearly always bigger than the pane it lands in, and a
   * viewer that clips shows you the top-left eighth of someone's screen with
   * no indication that there is more. Scaling makes it legible at a glance,
   * which is what a pane in a terminal app is for; `resize` asks the server
   * to match the pane instead, which only some servers honour.
   */
  rfb.scaleViewport = spec.scaling !== 'none';
  rfb.resizeSession = spec.scaling === 'resize';
  rfb.viewOnly = !!spec.viewOnly;
  rfb.clipViewport = spec.scaling === 'none';
  rfb.qualityLevel = clamp(spec.quality, 0, 9, 6);
  rfb.compressionLevel = clamp(spec.compression, 0, 9, 2);
  rfb.showDotCursor = true;
  pane.rfb = rfb;

  rfb.addEventListener('connect', () => {
    note.remove();
    pane.status = 'connected';
    pane.reconnectBtn?.classList.add('hidden');
    state.emit('tabs');
    screen.querySelector('canvas')?.focus();
  });

  rfb.addEventListener('credentialsrequired', async () => {
    const pw = await prompt({
      title: 'VNC password',
      label: `${spec.host} is asking for a password`,
      confirmLabel: 'Connect',
    });
    if (pw === null || pw === undefined) { try { rfb.disconnect(); } catch { /* never connected */ } return; }
    rfb.sendCredentials({ password: pw });
  });

  rfb.addEventListener('securityfailure', (e) => {
    showFailure(pane, e.detail?.reason || 'the server refused the connection');
  });

  rfb.addEventListener('disconnect', (e) => {
    pane.rfb = null;
    if (pane.vncToken) { window.api.vnc.release(pane.vncToken).catch(() => {}); pane.vncToken = null; }
    if (!e.detail?.clean) showFailure(pane, 'the connection dropped');
    else if (pane.status === 'connected') showFailure(pane, 'the server closed the session', 'ended');
    pane.status = 'closed';
    state.emit('tabs');
  });

  rfb.addEventListener('clipboard', (e) => {
    // The remote clipboard follows the local one only on purpose — see the
    // button on the pane header — but an explicit copy on the far side is
    // worth having here without asking twice.
    if (spec.clipboard === false) return;
    window.api.clipboard.write(e.detail?.text || '').catch(() => {});
  });

  return rfb;
}

/** Say what went wrong, and offer the one thing worth doing about it. */
function showFailure(pane, why, kind = 'failed') {
  const host = pane.view.screen;
  host.replaceChildren();
  const spec = pane.vncSpec || {};
  host.append(el('div', { class: 'vnc-note' },
    el('div', { class: 'vnc-title', text: kind === 'ended' ? 'Session ended' : 'Could not connect' }),
    el('div', { class: 'vnc-sub', text: `${spec.host}:${spec.port || 5900} — ${why}` }),
    el('div', { class: 'hint', style: 'margin-top:10px;max-width:46ch;text-align:center' },
      'A VNC server usually listens only on localhost. If this one does, open a '
      + 'tunnel to it from Tunnels and point this connection at 127.0.0.1 and the '
      + 'local port.'),
    el('button', {
      class: 'primary-btn', style: 'margin-top:12px',
      text: 'Try again',
      onClick: () => connectVnc(pane),
    })));
  pane.status = 'error';
  return null;
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Send a key combination the operating system would otherwise eat. */
export function sendVncKeys(pane, combo) {
  const rfb = pane?.rfb;
  if (!rfb) return toast('Not connected', 'error');
  if (combo === 'cad') { rfb.sendCtrlAltDel(); status('Sent Ctrl+Alt+Del'); return; }
  if (combo === 'ctrl-esc') {
    // The Windows key, which no browser will let through.
    rfb.sendKey(0xffe3, 'ControlLeft', true);
    rfb.sendKey(0xff1b, 'Escape', true);
    rfb.sendKey(0xff1b, 'Escape', false);
    rfb.sendKey(0xffe3, 'ControlLeft', false);
    status('Sent Ctrl+Esc');
  }
}

/** Paste the local clipboard into the remote session. */
export async function pasteToVnc(pane) {
  const rfb = pane?.rfb;
  if (!rfb) return toast('Not connected', 'error');
  const text = await window.api.clipboard.read();
  if (!text) return;
  rfb.clipboardPasteFrom(text);
  status('Pasted into the remote session');
}
