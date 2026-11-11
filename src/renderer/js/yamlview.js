import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { appEditorTheme } from './cmtheme.js';

/*
 * A plain YAML editor or view, colour-coded — for phase.yaml and Phase
 * add-ins, which are not Kubernetes resources, so none of yamleditor.js's
 * kubectl checking applies. `readOnly` makes it a view whose text is set
 * from outside (setValue); otherwise `onChange` hears each edit.
 */
export function createYamlView({ value = '', readOnly = false, onChange = null, height = '100%', minHeight = '' } = {}) {
  const dom = document.createElement('div');
  dom.className = 'yaml-editor';
  dom.style.height = height;
  if (minHeight) dom.style.minHeight = minHeight;
  const view = new EditorView({
    state: EditorState.create({
      doc: value,
      extensions: [
        basicSetup, keymap.of([indentWithTab]), EditorState.tabSize.of(2), yamlLang(), appEditorTheme,
        EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(view.state.doc.toString()); }),
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', fontSize: '12px' } }),
      ],
    }),
    parent: dom,
  });
  const api = {
    dom,
    getValue: () => view.state.doc.toString(),
    // Only when it differs, so a view refreshed on every check keeps its scroll.
    setValue: (v) => {
      const next = v || '';
      if (next !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
  };
  // Reachable from the page (tests drive it this way: it is the same change typing makes).
  dom.yamlView = api;
  return api;
}
