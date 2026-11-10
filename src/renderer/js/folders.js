import { state } from './state.js';
import { uid, el, clear, colorCss, compareNames } from './util.js';
import { compileQuery, collectTags, termFor } from './tags.js';
import { modal, field, textInput, select, toast, status, iconPicker, colorPicker } from './ui.js';

/**
 * Folders inside a cluster, and inside an ssh_config.
 *
 * A cluster's list is whatever `tsh ls` returns, in whatever order, and on a
 * real fleet that is hundreds of rows where the fifteen you work on are
 * scattered. Stars and tag filters both help and both stop short: a star is
 * one flat list, and a filter is something you retype. A folder is the thing
 * people actually want — a name, a place to drag a machine into, and it stays
 * there.
 *
 * Two ways in, and a folder can use both at once:
 *
 *   by hand    drag a node onto the folder. Kept by the node's UUID, never
 *              its hostname: a hostname is a label that changes on a rename
 *              or a rebuild, and a folder that empties itself when somebody
 *              renames a box is worse than no folder.
 *   by rule    a tag query the folder re-asks every time the inventory
 *              changes, so a node that comes up with `env=prod` files itself.
 *              The query is the boolean one (see compileQuery), because the
 *              useful rules are "prod web or prod api, but not the canary".
 *
 * A node that has been filed stops appearing loose in its group's list — the
 * point of filing something is that it is now somewhere — and the group's
 * menu can put them back if you would rather see both.
 *
 * Everything here is settings, and settings are portable: the whole
 * arrangement exports to a file and imports on another machine, which is how
 * a team shares one way of looking at a cluster. Membership travels as UUIDs,
 * so it lands correctly on anyone else's copy of the same cluster.
 */

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * The key a host is filed under.
 *
 * Deliberately the same key every other per-host preference uses — the
 * colours, the pinned username, the MFA list — so one machine means one
 * thing everywhere. sidebar.js has this as `hostPrefKey` and the main process
 * has it again in store.js; it is duplicated rather than imported because
 * importing it here would close a cycle, and the three copies must agree.
 */
export function hostKey(host) {
  if (!host) return '';
  if (host.uuid) return 'uuid:' + host.uuid;
  if (host.type === 'teleport' && host.name) return `tsh:${host.cluster || ''}:${host.name}`;
  return host.id || (host.alias ? 'ssh:' + host.alias : '');
}

/**
 * The key a group of hosts is known by: a cluster's proxy (and home, when it
 * is not the default one), or the ssh_config file.
 *
 * The scope a folder belongs to, and the scope a disappearance is noticed
 * in. It lives here with `hostKey` because the two are the same kind of
 * fact — what a thing is filed under — and because nodewatch cannot import
 * the sidebar, which is where this used to be.
 */
export function groupKeyFor(profile) {
  if (!profile) return '';
  return 'tp:' + profile.proxy + (profile.home ? '@' + profile.home : '');
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export function allFolders() {
  return state.settings.hostFolders || [];
}

export function folderById(id) {
  return allFolders().find((f) => f.id === id) || null;
}

/**
 * The folders directly under `parent` in one group, by name.
 *
 * By name rather than by when they were made: creation order is invisible
 * to the person reading the list, so it looks like no order at all — and a
 * folder added months later turning up between two old ones reads as a bug.
 * The same case-insensitive, numeric rule the file lists use.
 */
export function foldersIn(groupKey, parent = null) {
  return allFolders()
    .filter((f) => f.group === groupKey && (f.parent || null) === (parent || null))
    .sort((a, b) => compareNames(a.name, b.name));
}

/** Does this group have any folders at all? Decides whether to draw any of it. */
export function groupHasFolders(groupKey) {
  return allFolders().some((f) => f.group === groupKey);
}

export function childFolders(id) {
  return allFolders().filter((f) => (f.parent || null) === id);
}

/** Ancestors first, this folder last — what a breadcrumb is made of. */
export function folderPath(folder) {
  const out = [];
  let f = folder;
  const seen = new Set();
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    out.unshift(f);
    f = f.parent ? folderById(f.parent) : null;
  }
  return out;
}

/** The top-level folder this one sits under — itself, if it is one. */
export function rootOf(folder) {
  return folderPath(folder)[0] || folder;
}

function members(id) {
  const m = (state.settings.folderMembers || {})[id];
  return { in: m?.in || [], out: m?.out || [] };
}

/**
 * Compiled rules, kept between renders.
 *
 * A folder's rule is re-asked of every host on every redraw; parsing the same
 * string a few hundred times a second is work for nothing. Keyed by the rule
 * itself, so editing one invalidates only its own entry.
 */
const ruleCache = new Map();
function ruleFor(folder) {
  if (!folder?.rule) return null;
  if (!ruleCache.has(folder.rule)) ruleCache.set(folder.rule, compileQuery(folder.rule));
  const c = ruleCache.get(folder.rule);
  return c.empty ? null : c;
}

/**
 * The hosts in this folder itself: the ones filed by hand, plus the ones its
 * rule claims, less anything explicitly taken out.
 *
 * The exclusion list is what makes "remove from this folder" mean something
 * on a rule folder. Without it, dragging a node out of a rule folder would be
 * undone by the rule a second later, which reads as the app ignoring you.
 */
export function hostsInFolder(folder, hosts) {
  if (!folder) return [];
  const { in: inKeys, out } = members(folder.id);
  const manual = new Set(inKeys);
  const excluded = new Set(out);
  const rule = ruleFor(folder);
  return hosts.filter((h) => {
    const k = hostKey(h);
    if (excluded.has(k)) return false;
    return manual.has(k) || (rule ? rule.match(h) : false);
  });
}

/** The same, including every subfolder, with a host counted once. */
export function hostsInTree(folder, hosts) {
  const seen = new Set();
  const out = [];
  const walk = (f) => {
    for (const h of hostsInFolder(f, hosts)) {
      const k = hostKey(h);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
    }
    for (const c of childFolders(f.id)) walk(c);
  };
  walk(folder);
  return out;
}

/** Every folder in this group that holds this host, by hand or by rule. */
export function foldersForHost(host, groupKey) {
  const k = hostKey(host);
  return allFolders().filter((f) => {
    if (f.group !== groupKey) return false;
    const { in: inKeys, out } = members(f.id);
    if (out.includes(k)) return false;
    if (inKeys.includes(k)) return true;
    const rule = ruleFor(f);
    return rule ? rule.match(host) : false;
  });
}

/** Is this host filed anywhere in its group — and so not loose any more? */
export function isFiled(host, groupKey) {
  return foldersForHost(host, groupKey).length > 0;
}

/**
 * How a folder is drawn.
 *
 * An icon of its own if it has been given one, else the open or shut folder
 * glyph — the point of letting people choose is that "🔥" and "🧪" are read
 * faster than two folder shapes with different names, and a sidebar is
 * something you scan rather than read.
 */
export function folderIcon(folder, open = false) {
  return folder?.icon || (open ? '\u{1F4C2}' : '\u{1F4C1}');
}

/** Its colour as CSS, from the same eight a host can be marked with. */
export function folderColor(folder) {
  return colorCss(folder?.color);
}

/** Whether a filed host is also still listed at the top of its group. */
export function showFiledHosts() {
  return !!state.settings.showFiledHosts;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

async function save(patch) {
  state.settings = await window.api.settings.set(patch);
  ruleCache.clear();
  state.emit('folders');
}

async function saveFolders(folders, membersMap) {
  const patch = { hostFolders: folders };
  if (membersMap) patch.folderMembers = membersMap;
  await save(patch);
}

export async function createFolder({ name, group, parent = null, rule = '', icon = '', color = '' }) {
  const folder = {
    id: uid('fld'),
    name: String(name || 'New folder').trim() || 'New folder',
    group,
    parent: parent || null,
    rule: rule || '',
    icon: icon || '',
    color: color || '',
  };
  await saveFolders([...allFolders(), folder]);
  return folder;
}

export async function updateFolder(id, patch) {
  await saveFolders(allFolders().map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

/**
 * Move a folder under a new parent, refusing the moves that would make a loop
 * — a folder cannot be put inside itself or inside its own descendant, and
 * the tree walk that draws the sidebar would never come back if it were.
 */
export async function reparentFolder(id, parent) {
  if (id === parent) return false;
  const target = parent ? folderById(parent) : null;
  if (parent && !target) return false;
  if (target && folderPath(target).some((f) => f.id === id)) return false;
  await updateFolder(id, { parent: parent || null, group: target ? target.group : folderById(id)?.group });
  return true;
}

/** Ids of a folder and everything under it. */
export function subtreeIds(id) {
  const out = [id];
  for (const c of childFolders(id)) out.push(...subtreeIds(c.id));
  return out;
}

/**
 * Delete a folder and everything under it. Only the folders go: the hosts
 * were never *in* the app in the first place, they are in a cluster, and
 * unfiling them is the whole of what this can do to them.
 */
export async function deleteFolder(id) {
  const ids = new Set(subtreeIds(id));
  const map = { ...(state.settings.folderMembers || {}) };
  for (const k of ids) delete map[k];
  await saveFolders(allFolders().filter((f) => !ids.has(f.id)), map);
}

/** Put a host in a folder by hand, and clear any exclusion that contradicts it. */
export async function fileHost(host, folderId, { removeFrom = [] } = {}) {
  const k = hostKey(host);
  const map = { ...(state.settings.folderMembers || {}) };
  const cur = members(folderId);
  map[folderId] = {
    in: cur.in.includes(k) ? cur.in : [...cur.in, k],
    out: cur.out.filter((x) => x !== k),
  };
  /*
   * Taking it out of the folders it came from, when the drop said "just
   * here". A folder that held it by rule gets an exclusion rather than a
   * removal — there is no manual entry to delete, and the rule would put it
   * straight back.
   */
  for (const other of removeFrom) {
    if (other === folderId) continue;
    const m = members(other);
    const byRule = !m.in.includes(k);
    map[other] = {
      in: m.in.filter((x) => x !== k),
      out: byRule ? (m.out.includes(k) ? m.out : [...m.out, k]) : m.out,
    };
  }
  await save({ folderMembers: map });
}

/**
 * Take a host out of one folder. A rule match is excluded rather than
 * removed, for the same reason as above.
 */
export async function unfileHost(host, folderId) {
  const k = hostKey(host);
  const map = { ...(state.settings.folderMembers || {}) };
  const m = members(folderId);
  const byRule = !m.in.includes(k);
  map[folderId] = {
    in: m.in.filter((x) => x !== k),
    out: byRule ? (m.out.includes(k) ? m.out : [...m.out, k]) : m.out,
  };
  await save({ folderMembers: map });
}

/** Undo an exclusion, putting a rule's own match back in its folder. */
export async function clearExclusion(host, folderId) {
  const k = hostKey(host);
  const map = { ...(state.settings.folderMembers || {}) };
  const m = members(folderId);
  map[folderId] = { in: m.in, out: m.out.filter((x) => x !== k) };
  await save({ folderMembers: map });
}

export function isExcluded(host, folderId) {
  return members(folderId).out.includes(hostKey(host));
}

/** Is this host in the folder because somebody put it there, or by rule? */
export function isManualMember(host, folderId) {
  return members(folderId).in.includes(hostKey(host));
}

export async function setShowFiledHosts(on) {
  await save({ showFiledHosts: !!on });
}

/**
 * Put folders back where they can be seen.
 *
 * 0.6.0 and 0.6.1 filed a folder made from a group's own heading menu under
 * the proxy address rather than the group key — two things that both sound
 * like "this cluster" — so those folders were saved correctly and drawn
 * nowhere. Anyone who made one before the fix would otherwise have to make
 * it again, without ever being told why the first one disappeared.
 *
 * Only ever rewrites a group that is not a real one *into* a real one, so it
 * cannot move a folder that was already fine, and it is silent when there is
 * nothing to do.
 */
export async function repairFolderGroups(groups) {
  const known = new Set((groups || []).map((g) => g.key));
  if (!known.size) return 0;
  let fixed = 0;
  const out = allFolders().map((f) => {
    if (known.has(f.group)) return f;
    const guess = 'tp:' + f.group;
    if (!known.has(guess)) return f;
    fixed += 1;
    return { ...f, group: guess };
  });
  if (fixed) await saveFolders(out);
  return fixed;
}

/* ------------------------------------------------------------------ */
/* Export and import                                                   */
/* ------------------------------------------------------------------ */

const FILE_KIND = 'serverlife-folders';

/**
 * The arrangement as a file.
 *
 * Folders, their rules and their membership — nothing else. No addresses, no
 * logins, no credentials: it is a way of looking at a cluster, and it should
 * be safe to put in a pull request. Membership is UUIDs, which are the same
 * for everyone looking at the same cluster, so a colleague's import lands on
 * the same machines.
 */
export function exportData(groupKey = null) {
  const folders = allFolders().filter((f) => !groupKey || f.group === groupKey);
  const ids = new Set(folders.map((f) => f.id));
  const all = state.settings.folderMembers || {};
  const membersOut = {};
  for (const id of ids) if (all[id]) membersOut[id] = all[id];
  return {
    kind: FILE_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    app: state.appInfo?.version || '',
    groups: [...new Set(folders.map((f) => f.group))],
    folders,
    members: membersOut,
  };
}

export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not JSON.'); }
  if (!data || data.kind !== FILE_KIND) throw new Error('That is not a ServerLife folder export.');
  if (!Array.isArray(data.folders)) throw new Error('The file has no folders in it.');
  return data;
}

/**
 * Bring an exported arrangement in.
 *
 * `mode` is 'merge' or 'replace'; replace clears the groups the file covers
 * before adding, which is what "use theirs" means. Ids are rewritten on the
 * way in either way, so importing the same file twice makes a second copy
 * rather than silently overwriting the folders you have since edited — and a
 * file written on another machine can never collide with one of yours.
 *
 * `remap` renames the group every folder lands in, for the case where the
 * file came from a cluster reached by a different proxy address.
 */
export async function importData(data, { mode = 'merge', remap = null } = {}) {
  const idMap = new Map();
  for (const f of data.folders) idMap.set(f.id, uid('fld'));

  const incoming = data.folders.map((f) => ({
    id: idMap.get(f.id),
    name: String(f.name || 'Folder'),
    group: remap || f.group,
    parent: f.parent ? (idMap.get(f.parent) || null) : null,
    rule: typeof f.rule === 'string' ? f.rule : '',
  }));

  const incomingMembers = {};
  for (const [oldId, m] of Object.entries(data.members || {})) {
    const id = idMap.get(oldId);
    if (!id) continue;
    incomingMembers[id] = {
      in: Array.isArray(m?.in) ? m.in.map(String) : [],
      out: Array.isArray(m?.out) ? m.out.map(String) : [],
    };
  }

  const touched = new Set(incoming.map((f) => f.group));
  const keep = mode === 'replace'
    ? allFolders().filter((f) => !touched.has(f.group))
    : allFolders();
  const keptIds = new Set(keep.map((f) => f.id));
  const membersMap = {};
  for (const [id, m] of Object.entries(state.settings.folderMembers || {})) {
    if (keptIds.has(id)) membersMap[id] = m;
  }

  await saveFolders([...keep, ...incoming], { ...membersMap, ...incomingMembers });
  return { folders: incoming.length, groups: [...touched] };
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

/**
 * Make a folder, or edit one.
 *
 * The rule field is the part worth care: it is a query that will decide
 * membership long after whoever wrote it has forgotten what it said, so it
 * is checked as it is typed — how many of this group's hosts it matches
 * right now, the first few of them by name, and the parser's own complaint
 * when it will not read. A rule that matches nothing is not refused, because
 * `env=prod` matching nothing is a fair thing to write on a Monday morning
 * before anything has come up, but it says so.
 */
export async function openFolderDialog({ group, parent = null, folder = null, hosts = [] } = {}) {
  const editing = !!folder;
  const nameIn = textInput({ value: folder?.name || '', placeholder: 'Production web', autofocus: true });
  const ruleIn = textInput({ value: folder?.rule || '', placeholder: 'env=prod and (role:web or role:api) and not name=web-canary' });

  /*
   * The rule, built rather than recalled.
   *
   * Writing `env=prod and not name~^web-canary` from memory means knowing the
   * syntax *and* knowing which labels this cluster actually sets, and the
   * second one is the real obstacle: `tsh ls` decides the vocabulary, every
   * cluster's is different, and nothing on screen used to say what it was.
   * So the labels this group really has are a list you can pick from, the
   * operators are buttons, and what the rule matches right now is on screen
   * while it is being written. Typing it by hand still works; nobody has to.
   */
  const note = el('div', { class: 'rule-note' });
  const hits = el('div', { class: 'rule-hits' });

  const syncNote = () => {
    const q = ruleIn.value.trim();
    clear(hits);
    if (!q) {
      note.className = 'rule-note';
      note.textContent = 'No rule: the folder holds only what you drag into it.';
      return;
    }
    const c = compileQuery(q);
    if (c.error) {
      note.className = 'rule-note warn';
      note.textContent = `${c.error}. Reading it as a plain list of conditions for now.`;
      return;
    }
    const hit = hosts.filter(c.match);
    note.className = 'rule-note' + (hit.length ? '' : ' warn');
    note.textContent = hit.length
      ? `Matches ${hit.length} of ${hosts.length} in this group right now.`
      : 'Nothing here matches that yet — the folder will fill itself when something does.';
    for (const h of hit) hits.append(el('span', { class: 'rule-hit', text: h.name || h.alias }));
  };
  ruleIn.addEventListener('input', syncNote);

  /*
   * Appending to the rule rather than replacing it, and putting the `and` in
   * for you — the commonest mistake is two conditions with nothing between
   * them, which parses as an AND anyway but reads as a typo.
   */
  const insert = (text, { operator = false } = {}) => {
    const cur = ruleIn.value.trim();
    const open = !cur || /(\(|\b(and|or|not)\b|\|\||&&|!)\s*$/i.test(cur);
    // An operator leaves a space behind it: the next thing typed by hand
    // must not run into it, and `env=prod orname~…` is a baffling thing to
    // have to spot in your own query.
    ruleIn.value = cur + (cur ? (operator || open ? ' ' : ' and ') : '') + text + (operator ? ' ' : '');
    ruleIn.focus();
    ruleIn.setSelectionRange(ruleIn.value.length, ruleIn.value.length);
    syncNote();
  };

  /* Every label this group actually sets, with how many nodes carry it. */
  const tagPick = el('select', { class: 'rule-pick' },
    el('option', { value: '', text: 'Insert a tag…' }));
  for (const [key, values] of collectTags(hosts)) {
    const grp = el('optgroup', { label: key });
    grp.append(el('option', { value: `${key}:`, text: `${key}: (has the tag at all)` }));
    for (const [v, n] of [...values].sort((a, b) => b[1] - a[1])) {
      grp.append(el('option', { value: termFor(key, v), text: `${key} = ${v || '(empty)'}  · ${n}` }));
    }
    tagPick.append(grp);
  }
  tagPick.addEventListener('change', () => {
    if (tagPick.value) insert(tagPick.value);
    tagPick.value = '';
  });

  const fieldPick = el('select', { class: 'rule-pick' },
    el('option', { value: '', text: 'Insert a field…' }),
    el('option', { value: 'name~', text: 'name ~ regular expression' }),
    el('option', { value: 'name=', text: 'name = exact, or a glob like web-*' }),
    el('option', { value: 'name:', text: 'name : contains' }),
    el('option', { value: 'addr:', text: 'addr : contains' }),
    el('option', { value: 'cluster=', text: 'cluster =' }),
    el('option', { value: 'tag:', text: 'tag : anywhere in any label' }),
    el('option', { value: 'tunnel=true', text: 'tunnel = true' }));
  fieldPick.addEventListener('change', () => {
    if (fieldPick.value) insert(fieldPick.value);
    fieldPick.value = '';
  });

  const opBtn = (label, text = label) => el('button', {
    class: 'ghost-btn sm', type: 'button', text: label,
    onClick: () => insert(text, { operator: true }),
  });
  const builder = el('div', { class: 'rule-builder' },
    tagPick, fieldPick,
    opBtn('and'), opBtn('or'), opBtn('not'), opBtn('( )', '('), opBtn(')'),
    el('span', { style: 'flex:1' }),
    el('button', {
      class: 'ghost-btn sm', type: 'button', text: 'Clear',
      onClick: () => { ruleIn.value = ''; syncNote(); ruleIn.focus(); },
    }));

  // Where it sits. Its own descendants are not offered: a folder cannot be
  // put inside itself, and a select that lets you try is a select that has
  // to explain afterwards.
  const banned = editing ? new Set(subtreeIds(folder.id)) : new Set();
  const options = [{ value: '', label: '(top level)' }];
  for (const f of allFolders().filter((f) => f.group === group && !banned.has(f.id))) {
    options.push({ value: f.id, label: folderPath(f).map((x) => x.name).join(' / ') });
  }
  const parentSel = select(options, editing ? (folder.parent || '') : (parent || ''));
  const icon = iconPicker({ value: folder?.icon || '' });
  const colour = colorPicker({ value: folder?.color || '' });

  const res = await modal({
    title: editing ? 'Edit folder' : 'New folder',
    subtitle: group,
    width: 'min(620px, 94vw)',
    render: (body) => {
      body.append(
        field('Name', nameIn),
        field('Inside', parentSel, 'Folders nest as deep as you like.'),
        field('Fill it automatically', ruleIn,
          'A query, re-asked whenever the inventory changes. Tags (`env=prod`), fields '
          + '(`name=web-*`), a regular expression (`name~^web-\\d+$`), and `and`, `or`, `not` '
          + 'and brackets between them.'),
        builder,
        note,
        hits,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Icon', icon),
        field('Colour', colour, 'Drawn down the row, the same eight a host can be marked with.'));
      syncNote();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: editing ? 'Save' : 'Create',
        class: 'primary-btn',
        onClick: ({ close }) => {
          const name = nameIn.value.trim();
          if (!name) return toast('Give the folder a name', 'error');
          return close({
            name,
            rule: ruleIn.value.trim(),
            parent: parentSel.value || null,
            icon: icon.value,
            color: colour.value,
          });
        },
      },
    ],
  });
  if (!res) return null;

  if (editing) {
    await updateFolder(folder.id, res);
    status(`Saved “${res.name}”`);
    return folderById(folder.id);
  }
  const made = await createFolder({ ...res, group });
  status(`Created “${made.name}”`);
  return made;
}

/**
 * A node dragged into a folder under a different root.
 *
 * Asked rather than assumed, because both answers are ordinary: a machine
 * can be one of the web servers *and* one of the things on call this week,
 * and it can equally have been filed in the wrong place a minute ago. The
 * question only comes up across roots — dragging between two folders of the
 * same tree is a tidy-up, and asking every time would be noise.
 */
export async function askBothOrOne(host, folder, current) {
  const where = current.map((f) => folderPath(f).map((x) => x.name).join(' / '));
  return modal({
    title: `${host.name || host.alias} is already filed`,
    subtitle: where.join(' · '),
    width: 'min(560px, 94vw)',
    render: (body) => {
      body.append(el('div', { class: 'hint' },
        `It is in ${where.length === 1 ? 'that folder' : 'those folders'} already. `
        + `Put it in “${folder.name}” as well, or move it there?`));
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'List in both', onClick: ({ close }) => close('both') },
      { label: 'Move it here', class: 'primary-btn', onClick: ({ close }) => close('move') },
    ],
  });
}

/**
 * File one or more hosts into a folder, asking the question when it needs
 * asking.
 *
 * The one place that decides what a drop means, because there are three
 * views that can be dropped on — the sidebar, the browser and the hosts pane
 * — and three subtly different answers would be three bugs. Nothing filed
 * anywhere goes straight in; something already in the same tree is being
 * tidied and moves; something filed under a different root is the case where
 * both answers are ordinary, so it is asked. Asked once per drop, whatever
 * its size: fifteen identical dialogs is how you teach somebody to click the
 * first button without reading it.
 */
export async function fileHostsInto(hosts, folder, groupKey) {
  const list = (hosts || []).filter(Boolean);
  if (!list.length || !folder) return null;

  const targetRoot = rootOf(folder).id;
  const others = new Map();   // host key -> the folders it is in now
  let crossRoot = 0;
  for (const h of list) {
    const cur = foldersForHost(h, groupKey).filter((f) => f.id !== folder.id);
    others.set(hostKey(h), cur);
    if (cur.some((f) => rootOf(f).id !== targetRoot)) crossRoot += 1;
  }

  let mode = 'move';
  if (crossRoot) {
    const subject = list.length === 1 ? list[0] : { name: `${crossRoot} of ${list.length} hosts` };
    const seen = [...new Set([...others.values()].flat())];
    const answer = await askBothOrOne(subject, folder, seen);
    if (!answer) return null;
    mode = answer;
  }

  for (const h of list) {
    const from = mode === 'move' ? (others.get(hostKey(h)) || []).map((f) => f.id) : [];
    await fileHost(h, folder.id, { removeFrom: from });
  }
  return { count: list.length, mode };
}

/** Write the arrangement out, for a colleague or for a backup. */
export async function exportFoldersDialog(groupKey = null) {
  const data = exportData(groupKey);
  if (!data.folders.length) return toast('There are no folders to export', 'error');
  const name = `serverlife-folders${groupKey ? '-' + groupKey.replace(/[^\w.-]+/g, '_') : ''}.json`;
  const r = await window.api.dialog.saveText({
    text: JSON.stringify(data, null, 2),
    defaultPath: name,
    title: 'Export folders',
  });
  if (r) status(`Exported ${data.folders.length} folder${data.folders.length === 1 ? '' : 's'} to ${r.path}`);
}

/**
 * Read one back in.
 *
 * Merge or replace, and — when the file was written against a cluster this
 * machine does not have — the offer to land it somewhere else. That case is
 * the normal one for a rule-only arrangement, which is portable in a way
 * membership by UUID is not: the rules mean the same thing on any cluster,
 * the UUIDs mean nothing off the one they came from.
 */
export async function importFoldersDialog(groups = []) {
  const picked = await window.api.dialog.openFiles();
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;

  let data;
  try {
    const text = await window.api.local.readText(path);
    data = parseImport(typeof text === 'string' ? text : (text?.text ?? ''));
  } catch (e) {
    return toast(e.message || 'Could not read that file', 'error');
  }

  const fileGroups = [...new Set(data.folders.map((f) => f.group))];
  const here = new Set(groups.map((g) => g.key));
  const unknown = fileGroups.filter((g) => !here.has(g));

  const modeSel = select([
    { value: 'merge', label: 'Add them to what is here' },
    { value: 'replace', label: 'Replace the folders of the groups in the file' },
  ], 'merge');
  const remapSel = select(
    [{ value: '', label: 'Leave them where the file says' },
      ...groups.map((g) => ({ value: g.key, label: g.label }))],
    '');

  const res = await modal({
    title: 'Import folders',
    subtitle: `${data.folders.length} folder${data.folders.length === 1 ? '' : 's'}`
      + (data.exportedAt ? ` · exported ${new Date(data.exportedAt).toLocaleDateString()}` : ''),
    width: 'min(620px, 94vw)',
    render: (body) => {
      body.append(field('How', modeSel));
      if (unknown.length) {
        body.append(
          el('div', { class: 'hint', style: 'margin-top:8px;color:var(--amber)' },
            `${unknown.length === fileGroups.length ? 'None' : 'Some'} of the groups in this file are here: `
            + `${unknown.join(', ')}. Folders for a cluster you are not logged in to stay out of sight until you are.`),
          field('Put them in', remapSel,
            'Rules travel between clusters; hosts filed by hand do not — they are held by node UUID, '
            + 'which only means something on the cluster they came from.'));
      }
      body.append(el('div', { class: 'hint', style: 'margin-top:8px' },
        'Imported folders are given new ids, so importing twice makes a second copy rather than '
        + 'overwriting the one you have since edited.'));
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Import', class: 'primary-btn', onClick: ({ close }) => close({ mode: modeSel.value, remap: remapSel.value || null }) },
    ],
  });
  if (!res) return;

  const out = await importData(data, res);
  status(`Imported ${out.folders} folder${out.folders === 1 ? '' : 's'}`);
}
