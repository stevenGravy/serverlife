import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import sshoptions from '../../main/sshoptions.js';
import { appEditorTheme } from './cmtheme.js';

/*
 * ssh_config, coloured: what a line *is* at a glance — a Host or Match line
 * that starts a block, an option name, its value, a comment — and an option
 * name ssh would not recognise underlined as wrong while it is typed, before
 * Save has ssh check the whole file. The option list is the one the app
 * already checks "extra ssh options" against (main/sshoptions.js), so the
 * two never disagree.
 */
const KNOWN = sshoptions.KNOWN_SSH_OPTIONS;
const BLOCK = new Set(['host', 'match']);

const sshConfigLanguage = StreamLanguage.define({
  name: 'ssh_config',
  startState: () => ({ atValue: false }),
  token(stream, st) {
    if (stream.sol()) st.atValue = false;
    if (stream.eatSpace()) return null;
    if (stream.peek() === '#') { stream.skipToEnd(); return 'comment'; }
    if (!st.atValue) {
      const m = stream.match(/^[A-Za-z][A-Za-z0-9]*/);
      if (m) {
        st.atValue = true;
        // The `=` some people write between name and value is just a separator.
        stream.match(/^\s*=/);
        const name = m[0].toLowerCase();
        if (BLOCK.has(name)) return 'keyword';
        return KNOWN.has(name) ? 'propertyName' : 'invalid';
      }
      stream.next();
      return 'invalid';
    }
    if (stream.match(/^"[^"]*"?/)) return 'string';
    // A Host line's patterns, a negation, and an option's value.
    if (stream.match(/^!?[^\s#]+/)) return 'string';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
});

/** A CodeMirror editor for an ssh config: highlighting, Tab indents, insert at the cursor. */
export function createSshConfigEditor({ value = '' } = {}) {
  const dom = document.createElement('div');
  dom.className = 'yaml-editor sshconfig-editor';
  // The box it sits in has a fixed height and clips; without a height of its
  // own the editor grew to the whole file and the rest was cut off with no
  // way to scroll to it. Filling the box makes CodeMirror scroll inside it.
  dom.style.height = '100%';
  const view = new EditorView({
    state: EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        EditorState.tabSize.of(2),
        sshConfigLanguage,
        appEditorTheme,
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', fontSize: '12px' } }),
      ],
    }),
    parent: dom,
  });
  return {
    dom,
    getValue: () => view.state.doc.toString(),
    // Lines of their own: a newline before when the cursor is mid-line.
    insert: (text) => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const pad = from > line.from && view.state.doc.sliceString(line.from, from).trim() ? '\n' : '';
      view.dispatch(view.state.replaceSelection(pad + text + '\n'));
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
