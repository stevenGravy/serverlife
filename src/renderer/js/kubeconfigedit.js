import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { el } from './util.js';
import { modal, toast } from './ui.js';

/*
 * A kubeconfig, edited here — the same shape as the ssh config editor
 * (sshpresets.js): the file colour-coded on the left, suggestions on the
 * right to copy or drop in at the cursor, and nothing saved until kubectl
 * itself has read the new text (main.js, kubeconfig:write). A context that
 * names a cluster or user the file does not have is said before saving.
 */

const SNIPPETS = [
  {
    label: 'A cluster, a user and a context',
    help: 'The three pieces kubectl needs, tied together by the context. Paste under the matching lists, or replace them all in a new file.',
    text: [
      'clusters:',
      '  - name: my-cluster',
      '    cluster:',
      '      server: https://203.0.113.10:6443',
      '      certificate-authority-data: <base64 CA>',
      'users:',
      '  - name: my-user',
      '    user:',
      '      token: <bearer token>',
      'contexts:',
      '  - name: my-context',
      '    context:',
      '      cluster: my-cluster',
      '      user: my-user',
      '      namespace: default',
      'current-context: my-context',
    ].join('\n'),
  },
  {
    label: 'Another context',
    help: 'Under contexts: — a cluster and a user already in the file, with a namespace to start in.',
    text: '  - name: staging\n    context:\n      cluster: my-cluster\n      user: my-user\n      namespace: staging',
  },
  {
    label: 'A user through Teleport (tsh)',
    help: 'Under users: — what tsh kube login writes. tsh fetches a short-lived certificate on each use.',
    text: [
      '  - name: teleport-my-kube',
      '    user:',
      '      exec:',
      '        apiVersion: client.authentication.k8s.io/v1beta1',
      '        command: tsh',
      '        args:',
      '          - kube',
      '          - credentials',
      '          - --kube-cluster=my-kube',
      '          - --teleport-cluster=teleport.example.com',
      '          - --proxy=teleport.example.com:443',
      '        interactiveMode: IfAvailable',
    ].join('\n'),
  },
  {
    label: 'A user for Amazon EKS',
    help: 'Under users: — the aws CLI hands out a token for the cluster.',
    text: [
      '  - name: eks-user',
      '    user:',
      '      exec:',
      '        apiVersion: client.authentication.k8s.io/v1beta1',
      '        command: aws',
      '        args: [eks, get-token, --cluster-name, my-cluster, --region, us-west-2]',
    ].join('\n'),
  },
  {
    label: 'A user for Google GKE',
    help: 'Under users: — needs gke-gcloud-auth-plugin installed.',
    text: [
      '  - name: gke-user',
      '    user:',
      '      exec:',
      '        apiVersion: client.authentication.k8s.io/v1beta1',
      '        command: gke-gcloud-auth-plugin',
      '        provideClusterInfo: true',
    ].join('\n'),
  },
  {
    label: 'A user with a client certificate',
    help: 'Under users: — files on disk, or the same as *-data with base64.',
    text: '  - name: cert-user\n    user:\n      client-certificate: ~/.kube/certs/user.crt\n      client-key: ~/.kube/certs/user.key',
  },
  {
    label: 'Skip TLS verification (labs only)',
    help: 'Under a cluster: — for a self-signed lab cluster. Never for a real one.',
    text: '      insecure-skip-tls-verify: true',
  },
  { label: 'Which context kubectl uses', help: 'At the top level.', text: 'current-context: my-context' },
];

function createKubeconfigEditor(value) {
  const dom = document.createElement('div');
  dom.className = 'yaml-editor kubeconfig-editor';
  dom.style.height = '100%'; // fill the fixed-height box, so it scrolls instead of being cut off
  const view = new EditorView({
    state: EditorState.create({
      doc: value,
      extensions: [
        basicSetup, keymap.of([indentWithTab]), EditorState.tabSize.of(2), yamlLang(),
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', fontSize: '12px' } }),
      ],
    }),
    parent: dom,
  });
  return {
    dom,
    getValue: () => view.state.doc.toString(),
    setValue: (v) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v || '' } }),
    insert: (text) => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const pad = from > line.from && view.state.doc.sliceString(line.from, from).trim() ? '\n' : '';
      view.dispatch(view.state.replaceSelection(pad + text + '\n'));
      view.focus();
    },
  };
}

const card = (s, editor) => el('div', { style: 'border:1px solid var(--border-soft);border-radius:6px;padding:6px 8px;margin-bottom:8px' },
  el('div', { style: 'font-weight:600;font-size:12px', text: s.label }),
  el('div', { style: 'color:var(--muted);font-size:11px;margin:2px 0 4px', text: s.help }),
  el('pre', { style: 'font-family:var(--mono);font-size:11px;margin:0 0 6px;white-space:pre-wrap;user-select:text', text: s.text }),
  el('div', { style: 'display:flex;gap:6px' },
    el('button', { class: 'ghost-btn sm', type: 'button', text: 'Copy', onClick: async () => { await window.api.clipboard.write(s.text); toast('Copied'); } }),
    el('button', { class: 'ghost-btn sm', type: 'button', text: 'Insert at cursor', onClick: () => editor.insert(s.text) })));

/** Open the kubeconfig editor — on `file`, or the first kubeconfig ServerLife reads. */
export async function editKubeconfig(file = null) {
  const files = await window.api.kube.kubeconfigFiles().catch(() => []);
  if (!files.length) return toast('No kubeconfig file to edit', 'error');
  let current = file || files.find((f) => f.exists)?.path || files[0].path;
  let loaded;
  try { loaded = await window.api.kube.readKubeconfig(current); } catch (e) { return toast(e.message, 'error'); }
  const editor = createKubeconfigEditor(loaded.text);
  const note = el('div', { class: 'hint', style: 'min-height:1.3em;white-space:pre-wrap' });
  const say = (text, bad = false) => { note.textContent = text; note.style.color = bad ? 'var(--red)' : ''; };
  const fileSel = el('select', { style: 'max-width:100%' },
    ...files.map((f) => el('option', { value: f.path, text: f.path + (f.exists ? '' : '  (new)') })));
  fileSel.value = current;
  fileSel.addEventListener('change', async () => {
    try {
      const r = await window.api.kube.readKubeconfig(fileSel.value);
      current = r.path; editor.setValue(r.text); say('');
    } catch (e) { fileSel.value = current; toast(e.message, 'error'); }
  });
  const report = (r) => {
    if (!r.ok) return say(`kubectl can't read it:\n${(r.errors || []).join('\n')}`, true);
    return say(r.warnings?.length ? `kubectl reads it, but:\n${r.warnings.join('\n')}` : `kubectl reads it fine${r.contexts !== undefined ? ` — ${r.contexts} context${r.contexts === 1 ? '' : 's'}` : ''}.`, !!r.warnings?.length);
  };
  const save = async () => {
    say('Checking with kubectl…');
    const r = await window.api.kube.writeKubeconfig({ file: current, text: editor.getValue() }).catch((e) => ({ ok: false, errors: [e.message] }));
    if (!r.ok) { report(r); return false; }
    toast(`Saved ${r.path} — the previous version is in ${r.backup.split('/').pop()}${r.warnings?.length ? `\n${r.warnings.join('\n')}` : ''}`, r.warnings?.length ? 'error' : 'info', 8000);
    const { refreshKubeContexts } = await import('./kubepanel.js');
    refreshKubeContexts();
    return true;
  };
  const side = el('div', { style: 'overflow:auto;max-height:62vh;padding-right:4px' },
    el('div', { style: 'font-weight:600;margin-bottom:6px', text: 'Suggestions' }),
    el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'Copy one, or put the cursor where it belongs and insert it. Indentation matters in YAML — each lands at the depth shown.' }),
    ...SNIPPETS.map((s) => card(s, editor)));
  await modal({
    title: 'Edit kubeconfig', width: 'min(1200px, 96vw)', resize: 'kubeconfig-editor',
    render: (body) => body.append(
      files.length > 1 ? el('div', { style: 'margin-bottom:8px' }, fileSel) : el('div', { class: 'hint', style: 'margin-bottom:8px', text: current }),
      el('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:12px;align-items:stretch' },
        el('div', { style: 'height:60vh;border:1px solid var(--border);border-radius:6px;overflow:hidden' }, editor.dom), side),
      note),
    buttons: [
      { label: 'Check', onClick: async () => report(await window.api.kube.checkKubeconfig({ file: current, text: editor.getValue() })) },
      { label: 'Cancel', value: false },
      { label: 'Save', class: 'primary-btn', onClick: async ({ close }) => { if (await save()) close(true); } },
    ],
  });
}
