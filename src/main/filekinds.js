'use strict';

/**
 * Kinds of file, by extension — what colours a building in the 3D view.
 *
 * Shared by the scanner in the main process and the renderer, which bundles
 * it, so the two can never disagree about what a `.tgz` is. No requires on
 * purpose: it has to load in both places.
 */

const KINDS = {
  code: 'js mjs cjs ts tsx jsx py go rs c h cc cpp hpp java kt rb php sh bash zsh swift m cs scala lua pl r sql vue svelte css scss html htm',
  config: 'json yaml yml toml ini conf cfg xml env properties plist service tf hcl lock',
  docs: 'md txt rst pdf doc docx odt rtf xls xlsx csv tsv ppt pptx key pages numbers tex epub',
  images: 'png jpg jpeg gif svg webp ico bmp tif tiff heic psd raw ai',
  media: 'mp4 mov mkv avi webm mp3 wav flac aac ogg m4a m4v',
  archives: 'zip gz tgz tar bz2 xz 7z rar zst dmg iso pkg deb rpm jar war whl',
  logs: 'log out err journal',
  data: 'db sqlite sqlite3 parquet avro bin dat img qcow2 vmdk vdi pack idx',
  binaries: 'so dylib dll exe o a class pyc node wasm',
  secrets: 'pem crt cer pub p12 pfx jks gpg asc',
};

const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(KINDS)) {
  for (const ext of list.split(' ')) if (!EXT_KIND.has(ext)) EXT_KIND.set(ext, kind);
}

/** The extension the scanner groups by: lower case, short, or '' for none. */
function extOf(name) {
  const base = String(name).split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  // Rotated logs: syslog.1, app.log.3 — a number is not a file type.
  if (/^\d+$/.test(ext)) return extOf(base.slice(0, dot)) === 'log' ? 'log' : '';
  return ext.length <= 10 ? ext : '';
}

function kindOf(name) {
  return EXT_KIND.get(extOf(name)) || 'other';
}

module.exports = { KINDS, EXT_KIND, extOf, kindOf };
