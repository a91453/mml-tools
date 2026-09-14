// ────────────────────────────────────────────────────────────────────────────
//  MP4 mux：encoded chunk → 一個 .mp4 的 bytes
//
//  WebCodecs 給的是 **encoded chunk，不是檔案**。這個檔案負責把 H.264 與 AAC 的 chunk 包成
//  ISO BMFF 容器。純函式，不碰 DOM、不碰 WebCodecs —— 進去是 byte 陣列出來是 byte 陣列，
//  所以它是整條影片匯出路徑上**唯一算得出對錯的部分**（同 `mixnotes.js` 之於 mp3）。
//
//  ─── 為什麼自己寫而不是 vendor 一個 ───
//
//  兩個候選都實測過。`mp4-muxer` 69 KB、MIT、剛好夠用，**但官方已經 deprecate**，要人改用
//  `mediabunny`；而 `mediabunny` 的「體積很小」建立在 tree-shaking 上，**而這個專案沒有建置
//  流程** —— 沒有 bundler 就是整包 658 KB 全下載，會變成 vendor 裡第二大的檔案，只為了做
//  mux。既然兩條路都不理想，而我們要的又只是「一支影片軌 + 一支音訊軌、非分片、fastStart、
//  全在記憶體」這個很窄的子集，就自己寫。約 500 行，換掉 658 KB 的永久增重與一條 MPL-2.0。
//
//  **`mp4-muxer` 仍然在 `devDependencies` 裡，當對照組。** `test/mp4.test.mjs` 餵同一批
//  sample 給兩邊比對輸出 —— 那比任何結構斷言都強，因為它把對方多年來對真實播放器的相容性
//  整個繼承過來。它**不進 wwwroot、不被 SW precache、不出貨**。
//
//  ─── B-frame：跟對照組一樣punt 給呼叫端，但多一道保險 ───
//
//  有 B-frame 時 `cts ≠ dts`，要寫 `ctts`。但 WebCodecs 的 `EncodedVideoChunk` **只給
//  presentation timestamp，沒有 decode timestamp** —— 對照組的作法是讓呼叫端自己傳
//  `compositionTimeOffset`，我們照做（預設 0，於是 `ctts` 全零而被省略）。
//
//  差別是我們多一道檢查：**chunk 的 timestamp 一旦不是遞增的就丟例外**。那代表編碼器真的吐了
//  B-frame 而呼叫端沒給 offset，而它的症狀是「影片畫面順序錯亂」—— 一個做完整支才會發現、
//  而且看起來像繪製壞掉的錯。寧可當場停下來。
//
//  ─── timescale 選得讓取整完全不發生 ───
//
//  影片 timescale = fps、音訊 timescale = sampleRate。於是第 f 幀的時間點是 `f`（整數）、
//  AAC 每個 frame 是 1024 個單位（整數）—— 兩邊都沒有小數，所以**沒有累積誤差**，三分鐘之後
//  音畫也不會飄。這不是調味，是這條路上唯一不必擔心 drift 的理由。
// ────────────────────────────────────────────────────────────────────────────

/** 1904-01-01 到 1970-01-01 的秒數。MP4 的時間原點是 1904。 */
const EPOCH_1904 = 2082844800;

/** `mvhd` / `tkhd` 用的整片時間軸單位。1000 = 毫秒。 */
const GLOBAL_TIMESCALE = 1000;

/** 幾秒切一個 chunk（交錯的粒度）。同對照組。太大會讓播放器為了讀音訊而長距離 seek。 */
const CHUNK_SEC = 0.5;

// ─── 位元組 ─────────────────────────────────────────────────────────────────

const u8 = v => [v & 0xff];
const u16 = v => [(v >> 8) & 0xff, v & 0xff];
const u24 = v => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const u32 = v => [(v / 0x1000000) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const i16 = v => u16(v < 0 ? v + 0x10000 : v);

/** 64 位元無號。JS 的位元運算只有 32 位元，所以高低位要用除法拆。 */
const u64 = v => [...u32(Math.floor(v / 0x100000000)), ...u32(v >>> 0)];

/** 16.16 定點數。矩陣與解析度用。 */
const fixed_16_16 = v => u32(Math.round(v * 0x10000));
/** 8.8 定點數。音量用。 */
const fixed_8_8 = v => u16(Math.round(v * 0x100));

/** ASCII。`nulTerminated` 是 `hdlr` 的元件名稱要的。 */
const ascii = (s, nulTerminated = false) => {
  const out = [...s].map(c => c.charCodeAt(0));
  if (nulTerminated) out.push(0);
  return out;
};

const fitsU32 = v => v >= 0 && v < 0x100000000;

/** 秒 → 某個 timescale 的整數單位。 */
const scaled = (sec, timescale) => Math.round(sec * timescale);

// ─── box ────────────────────────────────────────────────────────────────────

/**
 * 一個 box：`[長度(4) 型別(4) 內容 子box…]`。
 *
 * 長度**含自己那 4 個 byte**，這是最容易寫錯的一個地方 —— 少算 8 的話所有後面的 box 位置
 * 全錯，而症狀是播放器完全打不開（那還算好的；有些播放器會讀出垃圾）。
 */
const box = (type, contents = null, children = null) => ({ type, contents, children });

/** 帶 version / flags 的 box。ISO BMFF 裡大部分的表格都是 full box。 */
const fullBox = (type, version, flags, contents = [], children = null) =>
  box(type, [u8(version), u24(flags), contents], children);

/**
 * box 樹 → 總長度。`measure` 與 `emit` 必須逐字對應，不然 stco 的偏移量會錯。
 *
 * 結果**快取在 box 上**：`emit` 會對每一層各叫一次，而 `stsz` 這種表在長曲上有上萬個項目，
 * 不快取的話深度六層就等於把整份 moov 走六遍（再乘上 fastStart 的兩趟）。box 是每一趟重建
 * 的，所以快取不會過期。
 */
function measure(b) {
  if (b.size !== undefined) return b.size;
  let n = 8;
  if (b.contents) n += flatLength(b.contents);
  if (b.children) for (const c of b.children) if (c) n += measure(c);
  b.size = n;
  return n;
}

/** 巢狀陣列的總長度。攤平一次算一次太貴（moov 會被算兩遍）。 */
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

/** box 樹 → bytes。 */
function emit(b, out) {
  const size = measure(b);
  flatInto([u32(size), ascii(b.type)], out);
  if (b.contents) flatInto(b.contents, out);
  if (b.children) for (const c of b.children) if (c) emit(c, out);
}

// ─── 版面 box ───────────────────────────────────────────────────────────────

/**
 * 單位矩陣。每一列的**前兩個是 16.16 定點、第三個是 2.30 定點** —— 所以右下角那個 1 是
 * `0x40000000` 而不是 `0x00010000`。寫成 16.16 的 1 的話畫面會被縮成 1/16384，而且只有部分
 * 播放器會照做（很多播放器根本不看這個矩陣），是最難查的那種「有些人看起來正常」。
 */
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
    fixed_16_16(1),          // rate
    fixed_8_8(1),            // volume
    Array(10).fill(0),       // reserved
    IDENTITY_MATRIX,
    Array(24).fill(0),       // pre-defined
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
    Array(8).fill(0),        // reserved
    u16(0),                  // layer
    u16(0),                  // alternate group
    fixed_8_8(video ? 0 : 1),
    u16(0),                  // reserved
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
    u16(0x55c4),             // language = "und"
    u16(0),                  // quality
  ]);
}

const hdlr = sub => fullBox("hdlr", 0, 0, [
  ascii("mhlr"), ascii(sub), u32(0), u32(0), u32(0), ascii("mml-workshop", true),
]);

const vmhd = () => fullBox("vmhd", 0, 1, [u16(0), u16(0), u16(0), u16(0)]);
const smhd = () => fullBox("smhd", 0, 0, [u16(0), u16(0)]);
const dinf = () => box("dinf", null, [
  fullBox("dref", 0, 0, [u32(1)], [fullBox("url ", 0, 1)]),
]);

/** `avc1`。`avcC` 的內容就是編碼器給的 `description`（AVCDecoderConfigurationRecord）。 */
const avc1 = tr => box("avc1", [
  Array(6).fill(0), u16(1),          // reserved, data reference index
  u16(0), u16(0), Array(12).fill(0), // pre-defined / reserved
  u16(tr.width), u16(tr.height),
  u32(0x00480000), u32(0x00480000),  // 72 dpi
  u32(0),
  u16(1),                            // frame count
  Array(32).fill(0),                 // compressor name
  u16(24),                           // depth
  i16(-1),                           // pre-defined
], [box("avcC", [...tr.description])]);

/**
 * `mp4a` + `esds`。
 *
 * `esds` 是三層巢狀的 MPEG-4 descriptor（ObjectDescriptor → ESDescriptor →
 * DecoderConfigDescriptor → DecoderSpecificInfo），而每一層的長度欄位都要含它裡面那幾層。
 * 寫錯的症狀是**整條音軌不出聲，而影片照播** —— 沒有錯誤訊息。所以這裡的長度是算出來的，
 * 不是抄一個常數。
 */
function mp4a(tr) {
  const d = [...tr.description];
  // descriptor 的長度欄位是**可變長度**的：每個 byte 的最高位表示「後面還有」。這裡一律用
  // 四個 byte（`80 80 80 <len>`）的長格式，跟絕大多數真實 muxer 一致 —— 短格式也合法，但
  // 那會讓每一層的長度都跟著變，而長度算錯的症狀是整條音軌不出聲、影片照播。
  const tag = (t, len) => [u8(t), u8(0x80), u8(0x80), u8(0x80), u8(len)];
  const esds = fullBox("esds", 0, 0, [
    tag(0x03, 32 + d.length),         // ES_Descr
    u16(1), u8(0),                    // ES_ID = 1, flags = 0
    tag(0x04, 18 + d.length),         // DecoderConfigDescr
    u8(0x40),                         // objectTypeIndication = MPEG-4 Audio
    u8(0x15),                         // streamType=5(audio), upStream=0, reserved=1
    u24(0),                           // buffer size
    u32(130071), u32(130071),         // max / avg bitrate
    tag(0x05, d.length), d,           // DecSpecificInfo = AudioSpecificConfig
    tag(0x06, 1), u8(2),              // SLConfigDescr
  ]);
  return box("mp4a", [
    Array(6).fill(0), u16(1),
    u16(0), u16(0), u32(0),
    u16(tr.numberOfChannels), u16(16),
    u16(0), u16(0),
    fixed_16_16(tr.sampleRate),
  ], [esds]);
}

// ─── sample table ───────────────────────────────────────────────────────────

/** 連續相同的值壓成 `{count, value}`。`stts` / `ctts` / `stsc` 都是這個形狀。 */
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
    // 全部都是關鍵幀就整個省略：`stss` 不在的意思就是「每一個都是」，寫出來反而是冗餘。
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

// ─── 準備軌道 ───────────────────────────────────────────────────────────────

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * 一軌的 chunk → 內部形式：算出每個 sample 的 delta（下一個 sample 減這一個）與 cto。
 *
 * **最後一個 sample 的 delta 沒有「下一個」可以減**，所以用它自己的 `duration`；連那個都沒有
 * 就沿用前一個 delta。少了這一條的症狀是影片最後一幀長度 0（有些播放器直接吃掉它）。
 */
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

    // 見檔頭「B-frame」。遞增的 dts 是「decode order = 送進來的順序」這個假設的全部內容，
    // 而那個假設一旦不成立，寫出來的檔案畫面順序是錯的。
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

  // delta 一律用「下一個的 dts 減這一個的 dts」，而不是 chunk 自己報的 duration ——
  // 後者在多數編碼器上是估的，累積起來會跟 timestamp 對不上。
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

/**
 * 把 sample 切成 chunk（每 `CHUNK_SEC` 一個），並算出 `stsc`。
 *
 * `stsc` 是「從第幾個 chunk 開始，每個 chunk 有幾個 sample」的**壓縮表**，所以連續幾個
 * 大小相同的 chunk 只佔一列。
 */
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

// ─── 對外 ───────────────────────────────────────────────────────────────────

/**
 * encoded chunk → 一個完整的 MP4。
 *
 * **`fastStart` 一律開著**（`moov` 排在 `mdat` 前面），所以檔案秒開、拖進度條不必等整份下載
 * 完。做法是先用假的 chunk 偏移量把 `moov` 建一次量出大小，再用真的偏移量重建一次 —— 兩趟
 * 的前提是「偏移量不會改變 `moov` 的長度」，而那只有在 `stco`（32 bit）與 `co64`（64 bit）
 * 之間切換時會被打破，所以第一趟就先決定用哪一個。
 *
 * @param {object} o
 * @param {{width:number, height:number, frameRate:number, description:BufferSource,
 *          samples:{data:Uint8Array, timestamp:number, duration?:number,
 *                   type:string, compositionTimeOffset?:number}[]}} o.video
 * @param {{sampleRate:number, numberOfChannels:number, description:BufferSource,
 *          samples:object[]}} [o.audio] 沒有就產生只有影片的 MP4
 * @param {number} [o.creationTime] Unix 秒。預設現在。**測試會把它釘住**
 * @returns {Uint8Array}
 */
export function muxMp4({ video, audio = null, creationTime = Date.now() / 1000 }) {
  if (!video) throw fail("novideo", "沒有影片軌");

  const tracks = [buildTrack(1, "video", video, video.frameRate)];
  if (audio) tracks.push(buildTrack(2, "audio", audio, audio.sampleRate));
  for (const tr of tracks) chunkify(tr);

  const movieDuration = Math.max(...tracks.map(t => t.durationSec));
  const mp4Time = Math.floor(creationTime) + EPOCH_1904;

  // ── 交錯：兩軌的 chunk 照時間先後排成一條，就是 mdat 裡的順序 ──
  //
  // 不交錯（影片全部寫完再寫音訊）也是合法的 MP4，但播放器每讀一秒畫面就要跳到檔案另一端
  // 去拿聲音。本地播放看不出來，放到網路上就是每隔一下卡一次。
  const order = tracks.flatMap(tr => tr.chunks.map(c => ({ tr, c })));
  order.sort((a, b) => a.c.start - b.c.start || a.tr.id - b.tr.id);

  const mdatSize = order.reduce(
    (n, { c }) => n + c.samples.reduce((m, s) => m + s.data.length, 0), 0);

  // 第一趟：先決定 stco / co64。`mdat` 一定在 `moov` 後面，所以最大的偏移量約等於
  // 「ftyp + moov + mdat」，用一個寬鬆的上界判斷就夠 —— 判過頭只是多寫 4 個 byte／chunk。
  const roughSize = 0x10000 + mdatSize;
  for (const tr of tracks) tr.co64 = !fitsU32(roughSize);

  for (const tr of tracks) for (const c of tr.chunks) c.offset = 0;
  const ftypSize = measure(ftyp());
  const moovSize = measure(moov(tracks, mp4Time, movieDuration));

  // 第二趟：真的偏移量。`mdat` 的內容從它自己的 header 之後開始。
  let at = ftypSize + moovSize + 8;
  for (const { c } of order) {
    c.offset = at;
    for (const s of c.samples) at += s.data.length;
  }

  const out = [];
  emit(ftyp(), out);
  const moovBox = moov(tracks, mp4Time, movieDuration);
  const finalMoovSize = measure(moovBox);
  // 兩趟的大小必須一模一樣，否則每個 chunk 的偏移量都差一個固定值 —— 而那個檔案打得開、
  // 播出來卻是垃圾。這是整個 fastStart 兩趟法唯一的假設，所以明確檢查它。
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
