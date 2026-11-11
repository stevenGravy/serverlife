import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { linter, lintGutter } from '@codemirror/lint';
import { autocompletion } from '@codemirror/autocomplete';
import { inferYamlPath, topLevelKind } from './yamlpath.js';
import { appEditorTheme } from './cmtheme.js';

/**
 * Replaces the plain `<textarea>` `textModal()` used to show and edit
 * YAML with a real editor: syntax highlighting always; when also
 * editable, live validation and autocomplete, both asked straight from
 * the cluster/kubectl (`kube:validateYaml`/`kube:explainFields`) rather
 * than a bundled schema — nothing here goes stale as the cluster's own
 * CRDs change. `lang: 'text'` (for `kubectl describe` output, which
 * isn't YAML) turns all of that off and is just a plain, highlight-free
 * editor shell.
 */
export function createYamlEditor({ value = '', readOnly = false, spec = null, lang = 'yaml' } = {}) {
  // Per-kind, for the life of this one editor — explain output for a
  // given kind/apiVersion never changes mid-edit, and re-asking on every
  // keystroke would make autocomplete feel like it was waiting on the network.
  const explainCache = new Map();
  async function explainFieldsCached(kind, apiVersion) {
    const key = `${kind}|${apiVersion || ''}`;
    if (explainCache.has(key)) return explainCache.get(key);
    let fields = [];
    try {
      const r = await window.api.kube.explainFields({ spec, target: { kind, apiVersion } });
      if (r?.ok) fields = r.fields;
    } catch { /* no autocomplete this time — not worth failing the editor over */ }
    explainCache.set(key, fields);
    return fields;
  }

  const extensions = [basicSetup, appEditorTheme, EditorState.readOnly.of(!!readOnly)];
  if (lang === 'yaml') extensions.push(yamlLang());

  if (lang === 'yaml' && !readOnly) {
    extensions.push(lintGutter(), linter(async (view) => {
      const text = view.state.doc.toString();
      if (!text.trim()) return [];
      let r;
      try { r = await window.api.kube.validateYaml({ spec, yaml: text }); }
      catch { return []; }
      if (!r || r.ok) return [];
      const message = r.error || 'kubectl rejected this.';
      // kubectl's own "unknown field" errors name the offending field —
      // locate it in the text for a line to point at; otherwise, flag the
      // top of the document rather than nothing at all.
      const field = message.match(/field "([^"]+)"/);
      let from = 0;
      let to = Math.min(text.length, 1);
      if (field) {
        const key = field[1].split('.').pop();
        const idx = text.indexOf(key + ':');
        if (idx >= 0) { from = idx; to = idx + key.length; }
      }
      return [{ from, to, severity: 'error', message }];
    }, { delay: 700 }));

    extensions.push(autocompletion({
      override: [async (context) => {
        const text = context.state.doc.toString();
        const top = topLevelKind(text);
        if (!top) return null;
        const word = context.matchBefore(/[A-Za-z0-9_-]*/);
        if (!word || (word.from === word.to && !context.explicit)) return null;
        const prefix = inferYamlPath(text, context.pos).join('.');
        const fields = await explainFieldsCached(top.kind, top.apiVersion);
        const options = fields
          .filter((f) => f.path.slice(0, Math.max(0, f.path.lastIndexOf('.'))) === prefix)
          .map((f) => ({ label: f.path.split('.').pop(), detail: f.type, type: 'property' }));
        return options.length ? { from: word.from, options } : null;
      }],
    }));
  }

  const dom = document.createElement('div');
  dom.className = 'yaml-editor';
  const view = new EditorView({
    state: EditorState.create({ doc: value, extensions }),
    parent: dom,
  });

  return {
    dom,
    getValue: () => view.state.doc.toString(),
    setValue: (v) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v || '' } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
