import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/*
 * The app's look for every CodeMirror editor — YAML, phase.yaml, ssh_config,
 * kubeconfig. Built from the stylesheet's own variables rather than fixed
 * colours, so it is right in the dark and light themes and under a skin;
 * without it CodeMirror falls back to its light defaults, dark blue on the
 * app's dark panels.
 */
const chrome = EditorView.theme({
  '&': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--text-dim)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 32%, transparent)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)', outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-3)', border: '1px solid var(--border)', color: 'var(--text-dim)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel-3)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-dim)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--amber) 30%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--amber) 55%, transparent)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--red)' },
}, { dark: true });

const highlight = HighlightStyle.define([
  // Keys — a YAML mapping's, an ssh_config option name.
  { tag: [t.definition(t.propertyName), t.propertyName], color: 'var(--accent)' },
  // Host and Match lines, YAML directives.
  { tag: t.keyword, color: 'var(--purple)', fontWeight: '600' },
  { tag: [t.string, t.attributeValue], color: 'var(--green)' },
  // The | or > that opens a block of text, such as a shell script.
  { tag: t.special(t.string), color: 'var(--amber)' },
  { tag: t.content, color: 'var(--text)' },
  { tag: [t.lineComment, t.comment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.labelName, t.typeName], color: 'var(--purple)' },
  { tag: [t.separator, t.punctuation, t.squareBracket, t.brace], color: 'var(--text-dim)' },
  { tag: t.meta, color: 'var(--muted)' },
  // An ssh option ssh does not know — usually a typo.
  { tag: t.invalid, color: 'var(--red)', textDecoration: 'underline wavy var(--red)' },
]);

export const appEditorTheme = [chrome, syntaxHighlighting(highlight)];
