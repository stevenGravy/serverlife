'use strict';
/**
 * Remote Desktop, handed to the client the machine already has.
 *
 * This is the one protocol here that is not drawn in the app, and the reason
 * is worth stating rather than hiding. RDP is not a screen protocol with a
 * keyboard bolted on; it is a bundle of virtual channels — printers, drives,
 * smart cards, audio, clipboard, RemoteApp, multi-monitor — and a viewer that
 * implements the drawing orders and none of the rest is a demo, not a tool
 * someone can work in. There is no embeddable JavaScript client that does the
 * job; the ones that exist are servers with a browser on the far end, which
 * means a second service to run and trust.
 *
 * So ServerLife does what Royal TS and Remote Desktop Manager do for the
 * protocols they do not implement: it keeps the *settings* — which is the
 * part worth saving, and the part people retype — writes them into the file
 * the platform's own client reads, and launches it. The connection is saved
 * here, lives in the same folders as everything else, and opens from the same
 * list; the pixels are somebody else's problem, and they are better at it.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

/**
 * The settings, in the `.rdp` format both Windows and the macOS client read.
 *
 * Only the keys that are worth a saved connection: the address, who you are,
 * the size of the window and the redirections that change whether the session
 * is usable at all. A full `.rdp` has over a hundred, nearly all of them
 * defaults nobody has ever changed.
 */
function rdpFile(c) {
  const addr = c.port && Number(c.port) !== 3389 ? `${c.hostname}:${c.port}` : c.hostname;
  const lines = [
    `full address:s:${addr}`,
    `screen mode id:i:${c.fullscreen ? 2 : 1}`,
    `session bpp:i:${Number(c.colorDepth) || 32}`,
    `redirectclipboard:i:${c.clipboard === false ? 0 : 1}`,
    `audiomode:i:${c.audio === 'none' ? 2 : c.audio === 'remote' ? 1 : 0}`,
    `redirectprinters:i:${c.printers ? 1 : 0}`,
    `drivestoredirect:s:${c.drives ? '*' : ''}`,
    `administrative session:i:${c.adminSession ? 1 : 0}`,
    'prompt for credentials:i:1',
    // Without this a saved file is "untrusted publisher" on every launch.
    'authentication level:i:2',
  ];
  if (!c.fullscreen) {
    lines.push(`desktopwidth:i:${Number(c.width) || 1440}`);
    lines.push(`desktopheight:i:${Number(c.height) || 900}`);
    lines.push('smart sizing:i:1');
  } else if (c.multimon) {
    lines.push('use multimon:i:1');
  }
  if (c.username) lines.push(`username:s:${c.username}`);
  if (c.domain) lines.push(`domain:s:${c.domain}`);
  if (c.gateway) {
    lines.push(`gatewayhostname:s:${c.gateway}`);
    lines.push('gatewayusagemethod:i:1');
    lines.push('gatewaycredentialssource:i:4');
  }
  return lines.join('\r\n') + '\r\n';
}

/** Where the generated file goes: per user, and overwritten each launch. */
function rdpPath(name) {
  const safe = String(name || 'session').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return path.join(os.tmpdir(), `serverlife-${safe}.rdp`);
}

/**
 * The Linux clients, in the order they are worth trying.
 *
 * FreeRDP first because it is the one that does the channels; Remmina is a
 * front end to it and is what a desktop install actually has; rdesktop is
 * there for the machines that have nothing newer.
 */
const LINUX_CLIENTS = [
  { bin: 'xfreerdp3', args: (c) => freerdpArgs(c, 3) },
  { bin: 'xfreerdp', args: (c) => freerdpArgs(c, 2) },
  { bin: 'remmina', args: (c) => ['-c', `rdp://${c.username ? encodeURIComponent(c.username) + '@' : ''}${c.hostname}:${c.port || 3389}`] },
  { bin: 'rdesktop', args: (c) => ['-g', `${c.width || 1440}x${c.height || 900}`, `${c.hostname}:${c.port || 3389}`] },
];

function freerdpArgs(c, major) {
  const a = [`/v:${c.hostname}:${c.port || 3389}`];
  if (c.username) a.push(`/u:${c.username}`);
  if (c.domain) a.push(`/d:${c.domain}`);
  if (c.fullscreen) a.push('/f');
  else a.push(`/size:${c.width || 1440}x${c.height || 900}`);
  if (c.clipboard !== false) a.push('+clipboard');
  if (c.drives) a.push('/drive:home,' + os.homedir());
  if (c.gateway) a.push(`/g:${c.gateway}`);
  // FreeRDP 2 asks about the certificate on a terminal nobody is watching.
  a.push(major >= 3 ? '/cert:ignore' : '/cert-ignore');
  return a;
}

function which(bin) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 4000 },
      (err, stdout) => resolve(err ? null : String(stdout).split('\n')[0].trim() || null));
  });
}

/**
 * Launch the platform's client for this connection.
 *
 * Returns what was used, so the app can say "opened in Microsoft Remote
 * Desktop" rather than leaving the user wondering whether anything happened.
 */
async function launch(conn, { shell }) {
  const c = conn || {};
  if (!c.hostname) throw new Error('No hostname');

  if (process.platform === 'linux') {
    for (const client of LINUX_CLIENTS) {
      const bin = await which(client.bin);
      if (!bin) continue;
      const child = spawn(bin, client.args(c), { detached: true, stdio: 'ignore' });
      child.unref();
      return { client: client.bin };
    }
    throw new Error('No RDP client found — install FreeRDP (xfreerdp) or Remmina');
  }

  const file = rdpPath(c.name || c.hostname);
  await fsp.writeFile(file, rdpFile(c), 'utf8');

  if (process.platform === 'win32') {
    const child = spawn('mstsc.exe', [file], { detached: true, stdio: 'ignore' });
    child.unref();
    return { client: 'mstsc', file };
  }

  // macOS: whichever of Microsoft's clients is installed opens a .rdp file.
  const err = await shell.openPath(file);
  if (err) {
    throw new Error('No RDP client is set up to open .rdp files — install '
      + 'Windows App (formerly Microsoft Remote Desktop) from the App Store');
  }
  return { client: 'system', file };
}

/** Is there anything on this machine that could open one? */
async function clientAvailable() {
  if (process.platform === 'win32') return !!(await which('mstsc.exe')) || fs.existsSync('C:\\Windows\\System32\\mstsc.exe');
  if (process.platform === 'linux') {
    for (const c of LINUX_CLIENTS) {
      if (await which(c.bin)) return true;
    }
    return false;
  }
  // On macOS the answer is "whatever claims .rdp", which cannot be asked
  // without trying it. Assume yes and let the launch say otherwise.
  return true;
}

module.exports = { launch, rdpFile, rdpPath, clientAvailable, freerdpArgs };
