// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Minimal MP4 (ISO BMFF) muxer for WebCodecs output.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
const EPOCH_1904 = 2082844800;

const GLOBAL_TIMESCALE = 1000;

const CHUNK_SEC = 0.5;

const u8 = v => [v & 0xff];
const u16 = v => [(v >> 8) & 0xff, v & 0xff];
const u24 = v => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const u32 = v => [(v / 0x1000000) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const i16 = v => u16(v < 0 ? v + 0x10000 : v);

const u64 = v => [...u32(Math.floor(v / 0x100000000)), ...u32(v >>> 0)];

const fixed_16_16 = v => u32(Math.round(v * 0x10000));
const fixed_8_8 = v => u16(Math.round(v * 0x100));

const ascii = (s, nulTerminated = false) => {
  const out = [...s].map(c => c.charCodeAt(0));
  if (nulTerminated) out.push(0);
  return out;
};

const fitsU32 = v => v >= 0 && v < 0x100000000;

const scaled = (sec, timescale) => Math.round(sec * timescale);

const box = (type, contents = null, children = null) => ({ type, contents, children });

const fullBox = (type, version, flags, contents = [], children = null) =>
  box(type, [u8(version), u24(flags), contents], children);

function measure(b) {
  if (b.size !== undefined) return b.size;
  let n = 8;
  if (b.contents) n += flatLength(b.contents);
  if (b.children) for (const c of b.children) if (c) n += measure(c);
  b.size = n;
  return n;
}

function flatLength(x) {
  if (typeof x === "number") return 1;
  let n = 0;
  for (const y of x) n += flatLength(y);
  return n;
}

function flatInto(x, out) {
  if (typeof x === "number") { out.push(x); return; }
  for (const y of x) flatInto(y, out);
}

function emit(b, out) {
  const size = measure(b);
  flatInto([u32(size), ascii(b.type)], out);
  if (b.contents) flatInto(b.contents, out);
  if (b.children) for (const c of b.children) if (c) emit(c, out);
}

const IDENTITY_MATRIX = [
  fixed_16_16(1), fixed_16_16(0), u32(0),
  fixed_16_16(0), fixed_16_16(1), u32(0),
  fixed_16_16(0), fixed_16_16(0), u32(0x40000000),
];

const ftyp = () => box("ftyp", [
  ascii("isom"), u32(512), ascii("isom"), ascii("avc1"), ascii("mp41"),
]);

function mvhd(creationTime, durationSec, nextTrackId) {
  const duration = scaled(durationSec, GLOBAL_TIMESCALE);
  const big = !fitsU32(creationTime) || !fitsU32(duration);
  const t = big ? u64 : u32;
  return fullBox("mvhd", big ? 1 : 0, 0, [
    t(creationTime), t(creationTime), u32(GLOBAL_TIMESCALE), t(duration),
    fixed_16_16(1),
    fixed_8_8(1),
    Array(10).fill(0),
    IDENTITY_MATRIX,
    Array(24).fill(0),
    u32(nextTrackId),
  ]);
}

function tkhd(tr, creationTime) {
  const duration = scaled(tr.durationSec, GLOBAL_TIMESCALE);
  const big = !fitsU32(creationTime) || !fitsU32(duration);
  const t = big ? u64 : u32;
  const video = tr.kind === "video";
  return fullBox("tkhd", big ? 1 : 0, 3, [
    t(creationTime), t(creationTime), u32(tr.id), u32(0), t(duration),
    Array(8).fill(0),
    u16(0),
    u16(0),
    fixed_8_8(video ? 0 : 1),
    u16(0),
    IDENTITY_MATRIX,
    fixed_16_16(video ? tr.width : 0),
    fixed_16_16(video ? tr.height : 0),
  ]);
}

function mdhd(tr, creationTime) {
  const duration = scaled(tr.durationSec, tr.timescale);
  const big = !fitsU32(creationTime) || !fitsU32(duration);
  const t = big ? u64 : u32;
  return fullBox("mdhd", big ? 1 : 0, 0, [
    t(creationTime), t(creationTime), u32(tr.timescale), t(duration),
    u16(0x55c4),
    u16(0),
  ]);
}

const hdlr = sub => fullBox("hdlr", 0, 0, [
  ascii("mhlr"), ascii(sub), u32(0), u32(0), u32(0), ascii("studio-workshop", true),
]);

const vmhd = () => fullBox("vmhd", 0, 1, [u16(0), u16(0), u16(0), u16(0)]);
const smhd = () => fullBox("smhd", 0, 0, [u16(0), u16(0)]);
const dinf = () => box("dinf", null, [
  fullBox("dref", 0, 0, [u32(1)], [fullBox("url ", 0, 1)]),
]);

const avc1 = tr => box("avc1", [
  Array(6).fill(0), u16(1),
  u16(0), u16(0), Array(12).fill(0),
  u16(tr.width), u16(tr.height),
  u32(0x00480000), u32(0x00480000),
  u32(0),
  u16(1),
  Array(32).fill(0),
  u16(24),
  i16(-1),
], [box("avcC", [...tr.description])]);

function mp4a(tr) {
  const d = [...tr.description];
  const tag = (t, len) => [u8(t), u8(0x80), u8(0x80), u8(0x80), u8(len)];
  const esds = fullBox("esds", 0, 0, [
    tag(0x03, 32 + d.length),
    u16(1), u8(0),
    tag(0x04, 18 + d.length),
    u8(0x40),
    u8(0x15),
    u24(0),
    u32(130071), u32(130071),
    tag(0x05, d.length), d,
    tag(0x06, 1), u8(2),
  ]);
  return box("mp4a", [
    Array(6).fill(0), u16(1),
    u16(0), u16(0), u32(0),
    u16(tr.numberOfChannels), u16(16),
    u16(0), u16(0),
    fixed_16_16(tr.sampleRate),
  ], [esds]);
}

function runLength(values) {
  const out = [];
  for (const v of values) {
    const lastRun = out[out.length - 1];
    if (lastRun && lastRun.value === v) lastRun.count++;
    else out.push({ count: 1, value: v });
  }
  return out;
}

function stbl(tr) {
  const sizes = tr.samples.map(s => s.data.length);
  const deltas = runLength(tr.samples.map(s => s.delta));
  const offsets = runLength(tr.samples.map(s => s.cto));
  const needsCtts = offsets.length > 1 || offsets.some(o => o.value !== 0);
  const allKey = tr.samples.every(s => s.type === "key");

  return box("stbl", null, [
    fullBox("stsd", 0, 0, [u32(1)], [tr.kind === "video" ? avc1(tr) : mp4a(tr)]),
    fullBox("stts", 0, 0, [u32(deltas.length), deltas.map(d => [u32(d.count), u32(d.value)])]),
    allKey ? null : fullBox("stss", 0, 0, [
      u32(tr.samples.filter(s => s.type === "key").length),
      tr.samples.map((s, i) => (s.type === "key" ? u32(i + 1) : [])),
    ]),
    fullBox("stsc", 0, 0, [
      u32(tr.stsc.length),
      tr.stsc.map(e => [u32(e.firstChunk), u32(e.samplesPerChunk), u32(1)]),
    ]),
    fullBox("stsz", 0, 0, [u32(0), u32(sizes.length), sizes.map(u32)]),
    tr.co64
      ? fullBox("co64", 0, 0, [u32(tr.chunks.length), tr.chunks.map(c => u64(c.offset))])
      : fullBox("stco", 0, 0, [u32(tr.chunks.length), tr.chunks.map(c => u32(c.offset))]),
    needsCtts
      ? fullBox("ctts", 0, 0, [u32(offsets.length), offsets.map(o => [u32(o.count), u32(o.value)])])
      : null,
  ]);
}

const trak = (tr, creationTime) => box("trak", null, [
  tkhd(tr, creationTime),
  box("mdia", null, [
    mdhd(tr, creationTime),
    hdlr(tr.kind === "video" ? "vide" : "soun"),
    box("minf", null, [tr.kind === "video" ? vmhd() : smhd(), dinf(), stbl(tr)]),
  ]),
]);

const moov = (tracks, creationTime, durationSec) => box("moov", null, [
  mvhd(creationTime, durationSec, Math.max(...tracks.map(t => t.id)) + 1),
  ...tracks.map(t => trak(t, creationTime)),
]);

const fail = (code, message) => Object.assign(new Error(message), { code });

function buildTrack(id, kind, src, timescale) {
  const samples = [];
  const list = src.samples;
  if (!list.length) throw fail("empty", `${kind} 軌沒有任何 sample`);

  let prevDts = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const cto = s.compositionTimeOffset ?? 0;
    const pts = s.timestamp / 1e6;
    const dts = pts - cto / 1e6;

    if (dts < prevDts) {
      throw fail("bframes",
        `${kind} 軌的第 ${i} 個 chunk 時間倒退（${dts} < ${prevDts}）—— ` +
        "編碼器吐了 B-frame 但呼叫端沒有提供 compositionTimeOffset");
    }
    prevDts = dts;

    samples.push({
      data: s.data,
      type: s.type === "key" ? "key" : "delta",
      dts, pts, cto: scaled(cto / 1e6, timescale),
      duration: s.duration ? s.duration / 1e6 : 0,
    });
  }

  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i], next = samples[i + 1];
    const sec = next ? next.dts - cur.dts : (cur.duration || (samples[i - 1]?.deltaSec ?? 0));
    cur.deltaSec = sec;
    cur.delta = scaled(sec, timescale);
  }

  const lastSample = samples[samples.length - 1];
  return {
    id, kind, timescale, samples,
    description: new Uint8Array(src.description),
    durationSec: lastSample.pts + lastSample.deltaSec,
    width: src.width, height: src.height,
    sampleRate: src.sampleRate, numberOfChannels: src.numberOfChannels,
  };
}

function chunkify(tr) {
  const chunks = [];
  for (const s of tr.samples) {
    const cur = chunks[chunks.length - 1];
    if (!cur || s.pts - cur.start >= CHUNK_SEC) chunks.push({ start: s.pts, samples: [s] });
    else cur.samples.push(s);
  }
  tr.chunks = chunks;
  tr.stsc = [];
  chunks.forEach((c, i) => {
    const lastEntry = tr.stsc[tr.stsc.length - 1];
    if (!lastEntry || lastEntry.samplesPerChunk !== c.samples.length) {
      tr.stsc.push({ firstChunk: i + 1, samplesPerChunk: c.samples.length });
    }
  });
}

export function muxMp4({ video, audio = null, creationTime = Date.now() / 1000 }) {
  if (!video) throw fail("novideo", "沒有影片軌");

  const tracks = [buildTrack(1, "video", video, video.frameRate)];
  if (audio) tracks.push(buildTrack(2, "audio", audio, audio.sampleRate));
  for (const tr of tracks) chunkify(tr);

  const movieDuration = Math.max(...tracks.map(t => t.durationSec));
  const mp4Time = Math.floor(creationTime) + EPOCH_1904;

  const order = tracks.flatMap(tr => tr.chunks.map(c => ({ tr, c })));
  order.sort((a, b) => a.c.start - b.c.start || a.tr.id - b.tr.id);

  const mdatSize = order.reduce(
    (n, { c }) => n + c.samples.reduce((m, s) => m + s.data.length, 0), 0);

  const roughSize = 0x10000 + mdatSize;
  for (const tr of tracks) tr.co64 = !fitsU32(roughSize);

  for (const tr of tracks) for (const c of tr.chunks) c.offset = 0;
  const ftypSize = measure(ftyp());
  const moovSize = measure(moov(tracks, mp4Time, movieDuration));

  let at = ftypSize + moovSize + 8;
  for (const { c } of order) {
    c.offset = at;
    for (const s of c.samples) at += s.data.length;
  }

  const out = [];
  emit(ftyp(), out);
  const moovBox = moov(tracks, mp4Time, movieDuration);
  const finalMoovSize = measure(moovBox);
  if (finalMoovSize !== moovSize) {
    throw fail("moovsize", `moov 兩趟算出來不一樣（${moovSize} → ${finalMoovSize}）`);
  }
  emit(moovBox, out);

  const header = [];
  flatInto([u32(mdatSize + 8), ascii("mdat")], header);
  out.push(...header);

  const bytes = new Uint8Array(out.length + mdatSize);
  bytes.set(out, 0);
  let p = out.length;
  for (const { c } of order) {
    for (const s of c.samples) { bytes.set(s.data, p); p += s.data.length; }
  }
  return bytes;
}
