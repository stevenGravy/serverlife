import { state } from './state.js';
import { el, clear, fmtDate } from './util.js';
import { modal, toast, status, confirm, field, textInput, select } from './ui.js';

/**
 * Registering S3 buckets.
 *
 * Three ways to get credentials, in the order most people should reach for
 * them: Teleport (short-lived, audited, nothing stored), the environment this
 * app was launched with, and finally a stored access key — which is the only
 * one that puts a long-lived secret on disk, so it is last and says so.
 */

export async function loadS3Targets() {
  try { state.s3Targets = await window.api.s3.list(); }
  catch { state.s3Targets = []; }
  state.emit('s3');
  return state.s3Targets;
}

const MODES = [
  { value: 'teleport', label: 'Teleport AWS app — short-lived, audited' },
  { value: 'profile', label: 'AWS profile on this machine (~/.aws)' },
  { value: 'env', label: 'Environment variables of this app' },
  { value: 'explicit', label: 'Stored access key' },
];

/* ------------------------------------------------------------------ */
/* Register / edit                                                     */
/* ------------------------------------------------------------------ */

export async function openS3Editor(initial = {}) {
  const nameIn = textInput({ value: initial.name || '', placeholder: 'Backups' });
  const bucketIn = textInput({ value: initial.bucket || '', placeholder: 'my-bucket' });
  const regionIn = textInput({ value: initial.region || '', placeholder: 'us-east-1 — blank to detect' });
  const prefixIn = textInput({ value: initial.prefix || '', placeholder: 'optional — only show keys under this' });
  const endpointIn = textInput({ value: initial.endpoint || '', placeholder: 'optional — MinIO or another S3-compatible host' });

  const modeSel = select(MODES, initial.credentials?.mode || 'teleport');
  const envPrefixIn = textInput({
    value: initial.credentials?.envPrefix || '',
    placeholder: 'optional — e.g. BACKUP_ for BACKUP_AWS_ACCESS_KEY_ID',
  });
  const keyIn = textInput({ value: initial.credentials?.accessKeyId || '', placeholder: 'AKIA…' });
  const secretIn = textInput({
    type: 'password',
    placeholder: initial.credentials?.hasSecret ? '•••••••• — stored, leave blank to keep' : 'Secret access key',
  });

  const profileSel = select([{ value: '', label: 'Loading profiles…' }], initial.credentials?.profile || '');
  const profileStatus = el('div', { class: 'hint' });

  const appSel = select([{ value: '', label: 'Loading AWS apps…' }], initial.credentials?.app || '');
  const roleSel = select([{ value: '', label: '—' }], initial.credentials?.role || '');
  const appStatus = el('div', { class: 'hint' });

  let classes = [];
  try { classes = await window.api.s3.storageClasses(); } catch { /* no classes: the field offers the default only */ }
  const classSel = select(
    classes.map((c) => ({ value: c.value, label: c.label })),
    initial.defaultStorageClass || 'STANDARD');

  const modeBlock = el('div', {});
  const syncMode = () => {
    clear(modeBlock);
    const mode = modeSel.value;
    if (mode === 'env') {
      modeBlock.append(
        field('Variable prefix', envPrefixIn,
          'Blank uses AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN.'),
        el('div', { class: 'hint' },
          'Read from the environment ServerLife itself was launched with — so launch it from a shell that has them, '
          + 'or they will not be visible.'));
    } else if (mode === 'profile') {
      modeBlock.append(
        field('Profile', profileSel),
        profileStatus,
        el('div', { style: 'margin-top:6px' },
          el('button', { class: 'ghost-btn sm', text: 'Check', onClick: () => checkProfile() })),
        el('div', { class: 'hint', style: 'margin-top:8px' },
          'Whatever this machine already uses — SSO, an assumed role, a credential_process hook or a static key. '
          + 'The AWS CLI resolves the profile, so an SSO session that has expired is refreshed with aws sso login.'));
      loadProfiles();
    } else if (mode === 'explicit') {
      modeBlock.append(
        el('div', { class: 'field-row' }, field('Access key ID', keyIn), field('Secret access key', secretIn)),
        el('div', { class: 'hint', style: 'color:var(--amber)' },
          'A stored key is long-lived. It is encrypted with this machine’s keychain, but Teleport or environment '
          + 'credentials avoid keeping one at all.'));
    } else {
      modeBlock.append(
        el('div', { class: 'field-row' }, field('AWS application', appSel), field('IAM role', roleSel)),
        appStatus,
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' },
          el('button', { class: 'ghost-btn sm', text: 'Reload apps', onClick: () => loadApps() }),
          el('button', { class: 'ghost-btn sm', text: 'Log in to app', onClick: () => doAppLogin() })),
        el('div', { class: 'hint', style: 'margin-top:8px' },
          'Credentials are minted per session by tsh and never stored. Every call is signed by Teleport with the '
          + 'IAM role above and lands in the cluster’s audit log.'));
    }
  };
  modeSel.addEventListener('change', syncMode);

  const loadProfiles = async () => {
    try {
      const profiles = await window.api.aws.profiles();
      if (!profiles.length) {
        profileSel.replaceChildren(el('option', { value: '', text: 'No profiles in ~/.aws' }));
        profileStatus.textContent = 'Nothing configured on this machine yet.';
        return;
      }
      profileSel.replaceChildren(...profiles.map((p) => el('option', {
        value: p.name,
        text: p.name + (p.sso ? ' — SSO' : p.assumesRole ? ' — assumed role' : p.staticKey ? ' — key' : ''),
      })));
      if (initial.credentials?.profile) profileSel.value = initial.credentials.profile;
      const chosen = profiles.find((p) => p.name === profileSel.value) || profiles[0];
      profileStatus.textContent = chosen?.region ? `Region from the profile: ${chosen.region}` : '';
    } catch (e) {
      profileSel.replaceChildren(el('option', { value: '', text: 'Could not read ~/.aws' }));
      profileStatus.textContent = e.message;
    }
  };

  const checkProfile = async () => {
    profileStatus.textContent = 'Resolving…';
    try {
      const r = await window.api.aws.profileCheck(profileSel.value || 'default');
      profileStatus.textContent = `${r.accessKeyId} via ${r.source}`
        + (r.temporary ? ' — temporary' : '')
        + (r.expiration ? `, expires ${new Date(r.expiration).toLocaleString()}` : '')
        + (r.region ? ` · ${r.region}` : '');
      if (!regionIn.value.trim() && r.region) regionIn.value = r.region;
      toast('Profile resolved', 'success');
    } catch (e) {
      profileStatus.textContent = e.message;
      toast(e.message, 'error');
    }
  };
  profileSel.addEventListener('change', () => { profileStatus.textContent = ''; });

  const loadApps = async () => {
    appStatus.textContent = 'Listing AWS applications…';
    try {
      const apps = await window.api.aws.apps();
      if (!apps.length) {
        appSel.replaceChildren(el('option', { value: '', text: 'No AWS apps on this cluster' }));
        appStatus.textContent = 'No application with cloud: AWS is visible to you.';
        return;
      }
      appSel.replaceChildren(...apps.map((a) => el('option', {
        value: a.name,
        text: a.accountId ? `${a.name} (${a.accountId})` : a.name,
      })));
      if (initial.credentials?.app) appSel.value = initial.credentials.app;
      appStatus.textContent = `${apps.length} AWS application${apps.length === 1 ? '' : 's'}.`;
      await loadRoles();
    } catch (e) {
      appSel.replaceChildren(el('option', { value: '', text: 'Could not list apps' }));
      appStatus.textContent = e.message;
    }
  };

  const loadRoles = async () => {
    if (!appSel.value) return;
    roleSel.replaceChildren(el('option', { value: '', text: 'Loading roles…' }));
    try {
      const roles = await window.api.aws.roles(appSel.value);
      roleSel.replaceChildren(
        el('option', { value: '', text: roles.length ? 'Choose a role…' : 'Already logged in' }),
        ...roles.map((r) => el('option', { value: r.name, text: r.name })));
      if (initial.credentials?.role) roleSel.value = initial.credentials.role;
    } catch (e) {
      roleSel.replaceChildren(el('option', { value: '', text: 'Could not list roles' }));
      appStatus.textContent = e.message;
    }
  };
  appSel.addEventListener('change', () => loadRoles());

  const doAppLogin = async () => {
    if (!appSel.value) return toast('Choose an application first', 'error');
    appStatus.textContent = `Logging in to ${appSel.value}…`;
    try {
      await window.api.aws.login(appSel.value, roleSel.value || undefined);
      appStatus.textContent = `Logged in to ${appSel.value}${roleSel.value ? ' as ' + roleSel.value : ''}.`;
      toast('Logged in to the AWS app', 'success');
    } catch (e) {
      appStatus.textContent = e.message;
      toast(e.message, 'error');
    }
  };

  const collect = () => ({
    id: initial.id,
    name: nameIn.value.trim() || bucketIn.value.trim(),
    bucket: bucketIn.value.trim(),
    region: regionIn.value.trim(),
    prefix: prefixIn.value.trim(),
    endpoint: endpointIn.value.trim(),
    pathStyle: !!endpointIn.value.trim(),
    defaultStorageClass: classSel.value,
    credentials: modeSel.value === 'teleport'
      ? { mode: 'teleport', app: appSel.value, role: roleSel.value || '' }
      : modeSel.value === 'profile'
        ? { mode: 'profile', profile: profileSel.value || 'default' }
        : modeSel.value === 'env'
        ? { mode: 'env', envPrefix: envPrefixIn.value.trim() }
        : {
          mode: 'explicit',
          accessKeyId: keyIn.value.trim(),
          secretAccessKey: secretIn.value || '',
        },
  });

  const res = await modal({
    title: initial.id ? 'Edit S3 bucket' : 'Register an S3 bucket',
    width: 'min(660px, 95vw)',
    render: (body) => {
      body.append(
        field('Credentials', modeSel),
        modeBlock,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        el('div', { class: 'field-row' },
          field('Bucket', bucketIn),
          field('Region', regionIn)),
        el('div', { style: 'display:flex;gap:6px;margin:-4px 0 12px' },
          el('button', {
            class: 'ghost-btn sm', text: 'Browse buckets…',
            title: 'List what these credentials can see and pick one',
            onClick: () => browseIntoField(),
          }),
          el('button', { class: 'ghost-btn sm', text: 'Test', onClick: () => testNow() })),
        el('div', { class: 'field-row' },
          field('Name', nameIn),
          field('Default storage class', classSel)),
        field('Prefix', prefixIn, 'Restricts this bucket to one folder.'),
        field('Endpoint', endpointIn, 'Leave blank for AWS. Setting one switches to path-style addressing.'));
      syncMode();
      if ((initial.credentials?.mode || 'teleport') === 'teleport') loadApps();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary-btn',
        onClick: ({ close }) => {
          const t = collect();
          if (!t.bucket) return toast('Give a bucket name', 'error');
          close(t);
        },
      },
    ],
  });

  async function browseIntoField() {
    const picked = await browseBuckets(collect());
    if (!picked) return;
    bucketIn.value = picked.name;
    if (picked.region) regionIn.value = picked.region;
    if (!nameIn.value.trim()) nameIn.value = picked.name;
  }

  async function testNow() {
    const t = collect();
    if (!t.bucket) return toast('Give a bucket name first', 'error');
    status('Testing ' + t.bucket + '…', 0);
    try {
      const r = await window.api.s3.test(t);
      status('');
      toast(`Reached ${r.bucket} in ${r.region}`, 'success');
      if (!regionIn.value.trim() && r.region) regionIn.value = r.region;
    } catch (e) { status(''); toast(e.message, 'error'); }
  }

  if (!res) return null;
  const saved = await window.api.s3.save(res);
  await loadS3Targets();
  return saved;
}

/* ------------------------------------------------------------------ */
/* Browse                                                              */
/* ------------------------------------------------------------------ */

/**
 * Every bucket the credentials can see. Needs s3:ListAllMyBuckets, which plenty
 * of roles withhold — hence the fallback message rather than an empty list.
 */
export async function browseBuckets(target) {
  let listing = null;
  let error = null;
  let body = null;
  const search = el('input', { class: 'tagb-search', placeholder: 'Filter buckets…', spellcheck: 'false' });

  const render = (close) => {
    if (!body) return;
    clear(body);
    if (error) {
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red)' },
        el('div', { text: error }),
        el('div', { style: 'margin-top:6px;opacity:.8', text: 'Type the bucket name instead — listing all buckets is a separate permission from using one.' })));
      return;
    }
    if (!listing) { body.append(el('div', { class: 'sb-empty', text: 'Listing buckets…' })); return; }

    const q = search.value.trim().toLowerCase();
    const shown = q ? listing.buckets.filter((b) => b.name.toLowerCase().includes(q)) : listing.buckets;
    if (!shown.length) { body.append(el('div', { class: 'sb-empty', text: 'No bucket matches.' })); return; }

    const list = el('div', { class: 'picker-list' });
    for (const b of shown) {
      list.append(el('div', {
        class: 'picker-item',
        onClick: async () => {
          // The region is needed to sign; ask S3 rather than making the user know.
          let region = '';
          try { region = await window.api.s3.bucketRegion({ ...target, bucket: b.name }); } catch { /* no region: the bucket opens in the default one */ }
          close({ name: b.name, region });
        },
      },
        el('span', { class: 'pname', text: b.name }),
        el('span', { class: 'pmeta', text: b.createdAt ? fmtDate(b.createdAt) : '' })));
    }
    body.append(list);
  };

  return modal({
    title: 'Buckets',
    subtitle: target?.bucket ? '' : 'Pick one to register',
    width: 'min(620px, 94vw)',
    render: (b, { close }) => {
      body = el('div', { style: 'max-height:min(52vh,440px);overflow-y:auto;margin-top:10px' });
      search.addEventListener('input', () => render(close));
      b.append(search, body);
      render(close);
      window.api.s3.buckets({ ...target, bucket: target?.bucket || '' })
        .then((r) => { listing = r; render(close); })
        .catch((e) => { error = e.message; render(close); });
    },
    buttons: [{ label: 'Cancel', value: null }],
  });
}

/* ------------------------------------------------------------------ */
/* Manage                                                              */
/* ------------------------------------------------------------------ */

export async function openS3Manager() {
  let body = null;
  const render = () => {
    if (!body) return;
    clear(body);
    const targets = state.s3Targets || [];
    if (!targets.length) {
      body.append(el('div', { class: 'sb-empty' },
        el('div', { text: 'No buckets registered.' }),
        el('div', { style: 'margin-top:6px;opacity:.75', text: 'Register one and it appears in every file explorer’s source list.' })));
      return;
    }
    for (const t of targets) {
      const card = el('div', { class: 'req-card' });
      card.append(el('div', { class: 'req-head' },
        el('span', { style: 'font-weight:600', text: t.name }),
        el('span', { class: 'tag', text: credentialLabel(t) })));
      card.append(el('div', { class: 'req-meta' },
        el('div', { text: `bucket: ${t.bucket}${t.region ? ' · ' + t.region : ''}` }),
        t.prefix ? el('div', { text: 'prefix: ' + t.prefix }) : null,
        t.endpoint ? el('div', { text: 'endpoint: ' + t.endpoint }) : null,
        el('div', { text: 'uploads as: ' + (t.defaultStorageClass || 'STANDARD') })));
      card.append(el('div', { class: 'req-actions' },
        el('button', {
          class: 'ghost-btn', text: 'Test',
          onClick: async () => {
            status('Testing ' + t.bucket + '…', 0);
            try { const r = await window.api.s3.test(t.id); status(''); toast(`Reached ${r.bucket} in ${r.region}`, 'success'); }
            catch (e) { status(''); toast(e.message, 'error'); }
          },
        }),
        el('button', { class: 'ghost-btn', text: 'Edit…', onClick: async () => { await openS3Editor(t); render(); } }),
        el('button', {
          class: 'ghost-btn danger-btn', text: 'Remove',
          onClick: async () => {
            if (!await confirm({
              title: 'Remove bucket',
              message: `Remove “${t.name}”?`,
              detail: 'Only the registration is removed. Nothing in S3 is touched.',
              confirmLabel: 'Remove', danger: true,
            })) return;
            await window.api.s3.remove(t.id);
            await loadS3Targets();
            render();
          },
        })));
      body.append(card);
    }
  };

  await modal({
    title: 'S3 buckets',
    width: 'min(700px, 94vw)',
    render: (b) => { body = b; render(); },
    buttons: [
      { label: 'Register a bucket…', onClick: async () => { await openS3Editor({}); render(); } },
      { label: 'Close', value: null },
    ],
  });
}

function credentialLabel(t) {
  const m = t.credentials?.mode || 'env';
  if (m === 'teleport') return 'teleport' + (t.credentials.app ? ': ' + t.credentials.app : '');
  if (m === 'profile') return 'profile: ' + (t.credentials.profile || 'default');
  if (m === 'explicit') return 'stored key';
  return 'environment';
}
