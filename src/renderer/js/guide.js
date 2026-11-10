import GUIDE_MD from '../../../GUIDE.md';
import { el, clear } from './util.js';
import { modal, status, toast } from './ui.js';

/**
 * The guide, in the app.
 *
 * The README is for someone deciding whether to build this; the guide is for
 * someone using it and wondering what a button does. That question happens
 * while the app is open, so the answer lives here rather than in a file they
 * would have to go and find — bundled as text at build time, because inside a
 * packaged app the markdown is in app.asar where nothing else can open it.
 *
 * The renderer below handles the subset of Markdown the guide is written in.
 * Deliberately not a library: the whole of it is a few hundred lines, it
 * cannot execute anything it is given, and a documentation viewer is not worth
 * a dependency that has to be audited.
 */

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

/** Inline spans: code, bold, italic, links. Text is escaped by construction. */
function inline(text) {
  const out = [];
  let rest = String(text);
  // Code first: nothing inside backticks is markup.
  const RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/;
  let m;
  while ((m = RE.exec(rest)) !== null) {
    if (m.index > 0) out.push(document.createTextNode(rest.slice(0, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(el('code', { text: tok.slice(1, -1) }));
    } else if (tok.startsWith('**')) {
      out.push(el('strong', { text: tok.slice(2, -2) }));
    } else if (tok.startsWith('*')) {
      out.push(el('em', { text: tok.slice(1, -1) }));
    } else {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      // Only real links open; an anchor scrolls, and anything else is text.
      if (/^https?:\/\//i.test(href)) {
        const a = el('a', { href: '#', text: label, title: href });
        a.addEventListener('click', (e) => { e.preventDefault(); window.open(href, '_blank'); });
        out.push(a);
      } else if (href.startsWith('#')) {
        const a = el('a', { href: '#', text: label, dataset: { anchor: href.slice(1) } });
        out.push(a);
      } else {
        out.push(document.createTextNode(label));
      }
    }
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) out.push(document.createTextNode(rest));
  return out;
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Markdown to DOM. Headings, paragraphs, lists, tables, fenced code, block
 * quotes and rules — which is everything the guide uses.
 */
function render(md) {
  const root = el('div', { class: 'guide-body' });
  const sections = [];
  const lines = String(md).split(/\r?\n/);
  let i = 0;

  const flushPara = (buf) => {
    if (!buf.length) return;
    root.append(el('p', {}, ...inline(buf.join(' '))));
    buf.length = 0;
  };
  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (/^```/.test(line)) {
      flushPara(para);
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      root.append(el('pre', { class: 'guide-pre' }, el('code', { text: body.join('\n') })));
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(para);
      const level = h[1].length;
      const text = h[2].replace(/\s+#*$/, '');
      const id = slug(text);
      root.append(el('h' + Math.min(4, level + 1), { class: 'guide-h guide-h' + level, id: 'g-' + id, text }));
      if (level <= 2) sections.push({ id: 'g-' + id, text, level });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(para);
      root.append(el('hr', { class: 'guide-hr' }));
      i++;
      continue;
    }

    // Tables: a header row, a separator, then rows.
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      flushPara(para);
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const table = el('table', { class: 'guide-table' });
      const thead = el('thead', {}, el('tr', {}, ...head.map((c) => el('th', {}, ...inline(c)))));
      const tbody = el('tbody', {});
      while (i < lines.length && /^\|/.test(lines[i])) {
        tbody.append(el('tr', {}, ...cells(lines[i]).map((c) => el('td', {}, ...inline(c)))));
        i++;
      }
      table.append(thead, tbody);
      root.append(table);
      continue;
    }

    // Lists, including nested ones by indent.
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flushPara(para);
      const ordered = /^\s*\d+\./.test(line);
      const list = el(ordered ? 'ol' : 'ul', { class: 'guide-list' });
      /*
       * An item's text is gathered across its continuation lines and parsed
       * once at the end.
       *
       * Parsing each line on its own split every `**bold span**` that happened
       * to wrap, and a half-open span then swallowed the asterisks of the
       * spans after it — which turned a wrapped bullet into visible markup.
       */
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        const item = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (item) items.push({ indent: item[1].length, text: item[3] });
        else if (items.length) items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      }
      for (const it of items) {
        const li = el('li', {}, ...inline(it.text));
        // An indented bullet belongs to the item above it.
        if (it.indent >= 2 && list.lastElementChild) {
          let sub = list.lastElementChild.querySelector(':scope > ul');
          if (!sub) { sub = el('ul', { class: 'guide-list' }); list.lastElementChild.append(sub); }
          sub.append(li);
        } else {
          list.append(li);
        }
      }
      root.append(list);
      continue;
    }

    // Block quote / callout
    if (/^>\s?/.test(line)) {
      flushPara(para);
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      const note = el('div', { class: 'guide-note' });
      // GitHub-style [!NOTE] markers become the note's own heading.
      const first = body[0] || '';
      const tag = first.match(/^\[!(\w+)\]\s*$/);
      if (tag) { note.append(el('div', { class: 'guide-note-head', text: tag[1].toLowerCase() })); body.shift(); }
      note.append(el('div', {}, ...inline(body.join(' '))));
      root.append(note);
      continue;
    }

    if (!line.trim()) { flushPara(para); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara(para);
  return { root, sections };
}

/* ------------------------------------------------------------------ */
/* The window                                                          */
/* ------------------------------------------------------------------ */

let openModal = null;

/**
 * Open the guide, optionally at a section.
 *
 * `topic` is matched against headings, so a button elsewhere in the app can
 * open the guide *at* the thing it is about rather than at the top.
 */
export async function openGuide({ topic = '' } = {}) {
  const { root, sections } = render(GUIDE_MD);

  const search = el('input', {
    class: 'guide-search', type: 'text', placeholder: 'Search the guide…', spellcheck: 'false',
  });
  const nav = el('div', { class: 'guide-nav' });
  const content = el('div', { class: 'guide-content' }, root);
  const count = el('div', { class: 'guide-count' });

  const scrollTo = (id) => {
    const target = content.querySelector('#' + CSS.escape(id));
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  /*
   * The section list stays whole while searching.
   *
   * Filtering it to the matching headings looked like a broken panel — a
   * search for a word that appears in a paragraph rather than a heading
   * emptied it — and a table of contents is for navigating, not for results.
   * Sections that contain a hit are marked instead.
   */
  const navItems = new Map();
  const drawNav = () => {
    clear(nav);
    navItems.clear();
    for (const s of sections) {
      const item = el('div', {
        class: 'guide-nav-item lvl' + s.level,
        text: s.text,
        onClick: () => scrollTo(s.id),
      });
      navItems.set(s.id, item);
      nav.append(item);
    }
  };

  /** Mark the sections a search actually hit. */
  const markNavHits = () => {
    for (const item of navItems.values()) item.classList.remove('hit');
    for (const m of marks) {
      // Walk up to the heading this match sits under.
      let node = m;
      let heading = null;
      while (node && node !== root) {
        let prev = node.previousElementSibling;
        while (prev) {
          if (/^H[1-5]$/.test(prev.tagName) && prev.id) { heading = prev; break; }
          prev = prev.previousElementSibling;
        }
        if (heading) break;
        node = node.parentElement;
      }
      if (heading) navItems.get(heading.id)?.classList.add('hit');
    }
  };

  /**
   * Search marks every match in the text and jumps to the first.
   *
   * Marks rather than filters: a guide read with its surrounding paragraphs
   * removed is a list of fragments, and the sentence *next to* the match is
   * usually the one that answers the question.
   */
  let marks = [];
  let markAt = 0;
  const clearMarks = () => {
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    }
    marks = [];
    markAt = 0;
  };
  const doSearch = (q) => {
    clearMarks();
    count.textContent = '';
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) { markNavHits(); return; }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue;
      const at = text.toLowerCase().indexOf(needle);
      if (at >= 0 && node.parentNode && !node.parentNode.classList?.contains('guide-mark')) {
        hits.push({ node, at });
      }
    }
    for (const hit of hits.slice(0, 400)) {
      const { node, at } = hit;
      const after = node.splitText(at);
      after.splitText(needle.length);
      const mark = el('span', { class: 'guide-mark', text: after.nodeValue });
      after.parentNode.replaceChild(mark, after);
      marks.push(mark);
    }
    count.textContent = marks.length
      ? `${marks.length} match${marks.length === 1 ? '' : 'es'}`
      : 'no matches';
    markNavHits();
    if (marks.length) {
      markAt = 0;
      marks[0].classList.add('on');
      marks[0].scrollIntoView({ block: 'center' });
    }
  };
  const step = (dir) => {
    if (!marks.length) return;
    marks[markAt]?.classList.remove('on');
    markAt = (markAt + dir + marks.length) % marks.length;
    marks[markAt].classList.add('on');
    marks[markAt].scrollIntoView({ block: 'center' });
    count.textContent = `${markAt + 1} of ${marks.length}`;
  };
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => doSearch(search.value), 140);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); search.value = ''; doSearch(''); }
  });

  // In-document links jump instead of doing nothing.
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-anchor]');
    if (!a) return;
    e.preventDefault();
    scrollTo('g-' + a.dataset.anchor);
  });

  drawNav();

  openModal = modal({
    title: 'ServerLife guide',
    subtitle: 'What everything does',
    width: 'min(1080px, 96vw)',
    resize: 'guide',
    render: (body) => {
      // The dialog's own body must not scroll, or the search row leaves with
      // it; the text pane scrolls instead.
      body.classList.add('guide-modal-body');
      body.append(
        el('div', { class: 'guide-top' }, search, count),
        el('div', { class: 'guide-split' }, nav, content));
      setTimeout(() => {
        if (topic) {
          const hit = sections.find((s) => s.text.toLowerCase().includes(String(topic).toLowerCase()));
          if (hit) scrollTo(hit.id);
        }
        search.focus();
      }, 30);
    },
    buttons: [
      {
        label: 'Copy the whole guide',
        title: 'The Markdown source, to paste somewhere else',
        onClick: () => { window.api.clipboard.write(GUIDE_MD); status('Guide copied as Markdown'); },
      },
      {
        label: 'Save as a file…',
        onClick: async () => {
          try {
            const r = await window.api.dialog.saveText({
              text: GUIDE_MD, title: 'Save the guide', defaultPath: 'ServerLife-guide.md',
            });
            if (r) status(`Saved ${r.path}`);
          } catch (e) { toast(e.message, 'error'); }
        },
      },
      { label: 'Close', value: null, class: 'primary-btn' },
    ],
  });
  return openModal;
}

/** The section titles, for anything that wants to link into the guide. */
export function guideSections() {
  return render(GUIDE_MD).sections.map((s) => s.text);
}
