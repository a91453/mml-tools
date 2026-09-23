// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// 3MLE .mml/.mmi writer.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { bareTrack, stripPrograms, stripWrapper } from "./mml.mjs";
import { buildExtension } from "./mml-ext.mjs";
import { markColor } from "./config.mjs";

const CRLF = "\r\n";

const MMI_NAMES = [
  "main", "chord1", "chord2", "chord3", "chord4", "chord5",
  "sub1", "sub2", "sub3", "sub4", "sub5", "sub6", "sub7", "sub8", "sub9",
];

const positionName = i => MMI_NAMES[i] ?? `track${i + 1}`;

const isEmpty = t => bareTrack(t).length === 0;

function keep(texts) {
  const out = [...(texts ?? [])];
  while (out.length > 1 && isEmpty(out[out.length - 1])) out.pop();
  return out;
}

const oneLine = t => stripPrograms(bareTrack(t));

const multiLine = t =>
  stripPrograms(stripWrapper(t ?? ""))
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(CRLF);

function channelBody(t) {
  const s = multiLine(t);
  return /^[ \t]*\[/m.test(s) ? oneLine(t) : s;
}

const iniValue = s => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();

export function toMml(texts, { title = "", programs = null, meters = [], marks = [] } = {}) {
  const list = keep(texts);
  const lines = [
    "[Settings]",
    "Encoding=utf-8",
    `Title=${iniValue(title)}`,
    "Source=",
    "Memo=",
  ];
  list.forEach((t, i) => lines.push(`[Channel${i + 1}]`, channelBody(t)));

  const ext = programs
    ? buildExtension(list.map((_, i) => ({
      channelNumber: i + 1,
      name: positionName(i),
      program: Number.isInteger(programs[i]) ? programs[i] : 0,
    })), meters.find(m => m.tick === 0) ?? null,
    marks.map((m, i) => ({ tick: Math.round(m.tick / 5), text: m.text, color: markColor(i) })))
    : null;
  return lines.join(CRLF) + CRLF + (ext ?? "");
}

export function toMmi(texts, { title = "", programs = [], bpm = 120, meters = [], marks = [] } = {}) {
  const head = meters.find(m => m.tick === 0) ?? { num: 4, den: 4 };
  const changes = meters.filter(m => m.tick > 0);
  const lines = [
    "[mml-score]",
    "version=1",
    `title=${iniValue(title)}`,
    "author=",
    `time=${head.num}/${head.den}`,
    `tempo=0T${Math.max(1, Math.round(bpm) || 120)}`,
  ];
  keep(texts).forEach((t, i) => lines.push(
    `mml-track=MML@${oneLine(t)},,;`,
    `name=${positionName(i)}`,
    `program=${Number.isInteger(programs?.[i]) ? programs[i] : 0}`,
    "songProgram=-1",
    "panpot=64",
    "visible=true"));

  if (changes.length) {
    lines.push("[time-signature]");
    for (const m of changes) lines.push(`${Math.round(m.tick / 5)}=${m.num}/${m.den}`);
  }
  if (marks.length) {
    lines.push("[marker]");
    for (const m of marks) lines.push(`${Math.round(m.tick / 5)}=${m.text}`);
  }
  return lines.join(CRLF) + CRLF;
}

export { DEFAULT_NAME, stripExt, safeFileName } from "./util.mjs";
