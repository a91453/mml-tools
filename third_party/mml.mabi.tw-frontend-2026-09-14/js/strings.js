// ────────────────────────────────────────────────────────────────────────────
//  簽名元素：一軌一條弦
//  每個音符起始就撥一下，弦按阻尼正弦衰減。只讀 player 竹的狀態，不改它。
// ────────────────────────────────────────────────────────────────────────────

import { TRACK_COLORS, MAX_TRACKS } from "./config.js";
import { clamp } from "./util.js";
import * as engine from "./engine.js";
import * as player from "./player.js";

let cv = null, g = null;
let rowsWhenIdle = () => 1;   // 沒在播的時候畫幾條 = 目前開了幾軌

const DECAY = 1.4;   // 一次撥弦畫多久（秒）；超過就沒有視覺貢獻了
const plucks = [];   // {track, t0, amp01, freq}
let lastDrawn = 0;

export function init(canvas, getTrackCount) {
  cv = canvas;
  g = cv.getContext("2d");
  rowsWhenIdle = getTrackCount;
  addEventListener("resize", () => { resize(); if (!player.isPlaying()) draw(); });
  resize();
}

export function resize() {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  cv.width = r.width * d; cv.height = r.height * d;
  g.setTransform(d, 0, 0, d, 0, 0);
}

/** 開始演奏：清掉上一輪的撥弦，把時間游標對到起點，然後啟動動畫。 */
export function kick(startAt) {
  plucks.length = 0;
  lastDrawn = startAt - 0.001;
  requestAnimationFrame(draw);
}

/** 從暫停恢復時重新啟動動畫迴圈（暫停時 draw() 會停下來，不空轉 rAF）。 */
export function wake() {
  requestAnimationFrame(draw);
}

export function draw() {
  const W = cv.clientWidth, H = cv.clientHeight;
  g.clearRect(0, 0, W, H);
  const now = engine.now();
  const { song, startAt, playing, paused } = player.state();

  // 收集這一幀剛開始的音 → 撥弦。amp 存正規化的 0–1，實際振幅到畫的日時候才乘（弦數會變）
  if (playing && song) {
    song.tracks.forEach((tr, ch) => {
      for (const n of tr.notes) {
        const at = startAt + n.start;
        if (at > lastDrawn && at <= now) {
          plucks.push({ track: ch, t0: at, amp01: n.vel / 127, freq: 6 + (n.midi - 36) * 0.55 });
        }
      }
    });
  }
  lastDrawn = now;
  // 衰減完的丟掉。這也是動畫的停止條件 —— 只砍到上限的話陣列永遠不會空，停止演奏後 rAF
  // 會一直空轉下去。
  for (let k = plucks.length - 1; k >= 0; k--) if (now - plucks[k].t0 > DECAY) plucks.splice(k, 1);
  while (plucks.length > 40 * MAX_TRACKS / 3) plucks.shift();

  const rows = clamp(song ? song.tracks.length : rowsWhenIdle(), 1, MAX_TRACKS);
  const pad = 26;
  const gap = rows > 1 ? (H - pad * 1.6) / (rows - 1) : 0;
  const unit = (rows > 1 ? gap : H / 3) * 0.42;   // 一條弦最大能擺多遠，不撞到鄰居
  for (let r = 0; r < rows; r++) {
    const y = rows > 1 ? pad + r * gap : H / 2;
    const live = plucks.filter(p => p.track === r && now - p.t0 < DECAY);
    const col = TRACK_COLORS[r];

    // 弦
    g.beginPath();
    for (let x = 0; x <= W; x += 4) {
      let dy = 0;
      for (const p of live) {
        const dt = now - p.t0;
        dy += p.amp01 * unit * Math.sin(Math.PI * x / W) * Math.cos(2 * Math.PI * p.freq * dt) * Math.exp(-dt * 2.6);
      }
      x ? g.lineTo(x, y + dy) : g.moveTo(x, y + dy);
    }
    const hot = live.length && now - live[live.length - 1].t0 < 0.25;
    g.strokeStyle = hot ? col : "rgba(127,155,152,.42)";
    g.lineWidth = 1 + r * (1.1 / Math.max(1, rows - 1));
    g.shadowBlur = hot ? 12 : 0; g.shadowColor = col;
    g.stroke();
    g.shadowBlur = 0;

    // 兩端竹的琴枕
    g.fillStyle = "rgba(127,155,152,.28)";
    g.fillRect(0, y - 5, 2, 10); g.fillRect(W - 2, y - 5, 2, 10);
  }

  // 暫停時 engine.now() 是凍住的，弦不會再變化也不會衰減完 —— 繼續要 rAF 只是用 60fps 重
  // 畫同一張圖。停在這裡，等 wake() 叫醒。
  if (paused) return;
  if (playing || plucks.length) requestAnimationFrame(draw);
}
