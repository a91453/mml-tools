// Raw MML pasted or picked straight into the listening panel (listen-ui.mjs).
//
// One to four complete MML@…; strings, an optional title and an optional
// meter text become one local listening session: the first version is the
// one heard as A, the others are its comparison versions (B, and the rest
// selectable). Nothing here uploads, opens a project or touches a gate; this
// module only checks the shape before the session is created, the parser
// (parseListening) still reports what the text actually contains.
import { LISTEN_LIMITS } from './listen-link.mjs';
import { parseMeterText } from './listen-timeline.mjs';
import { segmentRoles } from './mml-highlight.mjs';

export const PASTE_MAX_VERSIONS = 4;
export const PASTE_LABEL_CHARS = 80;
// A text file larger than this is not an MML string (40 000 characters of
// UTF-8 fit in well under it) and is refused before it is read.
export const PASTE_MAX_FILE_BYTES = 262144;
export const PASTE_FILE_EXTENSIONS = Object.freeze(['.mml', '.txt']);
export const defaultVersionLabel = index => `版本 ${String.fromCharCode(65 + index)}`;

/** A file name without its folder or extension, for a version label. */
export function labelFromFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').trim();
  return base.slice(0, PASTE_LABEL_CHARS);
}

/** Whether a picked or dropped file looks like MML text by its name. */
export function isPasteFile(file) {
  const name = String(file?.name ?? '').toLowerCase();
  return PASTE_FILE_EXTENSIONS.some(ext => name.endsWith(ext));
}

/**
 * Check a paste draft and return what the session is made from.
 * @param {{ title?: string, meter?: string, versions: Array<{ label?: string, mml?: string }> }} draft
 * @returns {{ title: string, meterText: string|null, versions: Array<{ label: string, mml: string }> }}
 */
export function preparePastedVersions({ title = '', meter = '', versions = [] }) {
  const filled = versions.map((item, index) => ({ index, label: String(item?.label ?? '').trim().slice(0, PASTE_LABEL_CHARS) || defaultVersionLabel(index), mml: String(item?.mml ?? '').trim() }))
    .filter(item => item.mml);
  if (!filled.length) throw Error('請貼上至少一份完整的 MML@…; 字串，或選擇 .mml／.txt 檔案。');
  if (filled.length > PASTE_MAX_VERSIONS) throw Error(`一次最多比較 ${PASTE_MAX_VERSIONS} 個版本。`);
  const seen = new Map();
  for (const item of filled) {
    if (!segmentRoles(item.mml).wrapped) throw Error(`「${item.label}」不是完整的 MML@…; 字串（需以 MML@ 開頭、以 ; 結尾）。`);
    if (item.mml.length > LISTEN_LIMITS.mmlChars) throw Error(`「${item.label}」超過 ${LISTEN_LIMITS.mmlChars} 字，無法建立試聽工作階段。`);
    if (seen.has(item.mml)) throw Error(`「${item.label}」與「${seen.get(item.mml)}」完全相同，不需要比較。`);
    seen.set(item.mml, item.label);
  }
  const labels = new Set();
  for (const item of filled) {
    if (labels.has(item.label)) throw Error(`有兩個版本都叫「${item.label}」，請改用不同名稱。`);
    labels.add(item.label);
  }
  const meterText = String(meter ?? '').trim();
  if (meterText) {
    if (meterText.length > LISTEN_LIMITS.meterChars) throw Error(`拍號圖超過 ${LISTEN_LIMITS.meterChars} 字。`);
    if (meterText.split(/\r\n?|\n/).length > LISTEN_LIMITS.meterLines) throw Error(`拍號圖超過 ${LISTEN_LIMITS.meterLines} 行。`);
    try { parseMeterText(meterText); } catch (error) { throw Error(`拍號圖無法使用：${error.message}`); }
  }
  const named = String(title ?? '').trim();
  return {
    title: (named || (filled.length > 1 ? filled.map(item => item.label).join(' vs ') : filled[0].label === defaultVersionLabel(filled[0].index) ? '貼上的 MML' : filled[0].label)).slice(0, LISTEN_LIMITS.titleChars),
    meterText: meterText || null,
    versions: filled.map(({ label, mml }) => ({ label, mml })),
  };
}
