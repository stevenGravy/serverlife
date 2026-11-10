/**
 * CHANGELOG.md, read into the releases the version history shows.
 *
 * The history used to be a second copy of the changelog kept by hand, and it
 * stopped at 0.1.16 while the changelog went on to 0.14 — the copy nobody is
 * made to update is the one that falls behind. The markdown is bundled as
 * text at build time, the same way the guide is, so a packaged app has it
 * without reading the asar, and this turns it into data.
 *
 * Pure: a string in, a list out, so it can be tested against the real file.
 */

/** Markdown inline marks to plain text: the history draws text, not HTML. */
export function plainText(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // [text](url) -> text
    .replace(/\*\*([^*]+)\*\*/g, '$1')               // **bold**
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')   // *emphasis*
    .replace(/`([^`]+)`/g, '$1')                     // `code`
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every `## [x.y.z] — date` section, newest first as the file has them.
 *
 * The paragraph between the heading and the first `###` is the summary; each
 * `###` is a section, and each `- ` item in it is one entry, its wrapped
 * continuation lines joined back on. Anything else — the preamble, the `---`
 * rules, the link references at the foot — is not part of a release.
 */
export function parseChangelog(md) {
  const releases = [];
  let rel = null;
  let section = null;
  let item = null;
  let summary = [];

  const endItem = () => {
    if (item && section) section.items.push(plainText(item.join(' ')));
    item = null;
  };
  const endRelease = () => {
    endItem();
    if (rel) {
      rel.summary = plainText(summary.join(' '));
      releases.push(rel);
    }
    rel = null; section = null; summary = [];
  };

  for (const line of String(md || '').split('\n')) {
    const head = line.match(/^## \[([^\]]+)\]\s*[—–-]\s*(\S+)/);
    if (head) {
      endRelease();
      rel = { version: head[1], date: head[2], title: '', summary: '', sections: [] };
      continue;
    }
    if (!rel) continue;
    if (/^---\s*$/.test(line) || /^\[[^\]]+\]:\s/.test(line)) { endRelease(); continue; }
    const sub = line.match(/^### (.+)$/);
    if (sub) {
      endItem();
      section = { name: plainText(sub[1]), items: [] };
      rel.sections.push(section);
      continue;
    }
    if (section) {
      const bullet = line.match(/^- (.*)$/);
      if (bullet) { endItem(); item = [bullet[1]]; continue; }
      if (item && /^\s+\S/.test(line)) { item.push(line.trim()); continue; }
      if (!line.trim()) { endItem(); continue; }
      // Prose inside a section, outside any bullet, is kept as its own entry.
      endItem();
      item = [line.trim()];
      continue;
    }
    if (line.trim()) summary.push(line.trim());
  }
  endRelease();
  return releases.filter((r) => r.sections.length || r.summary);
}
