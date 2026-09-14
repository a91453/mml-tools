// ────────────────────────────────────────────────────────────────────────────
//  混音匯出：樂譜 → 合成器事件序列
//
//  離線合成沒有排程器（`player.js` 那套 look-ahead 綁在 AudioContext 的時鐘上，而離線渲染是
//  「用最快速度算完」）。所以這裡把整首歌一次攤平成一串**帶 sample 位置**的事件。
//
//  這個檔案是整條匯出路徑上**唯一算得出對錯的部分** —— 進去是樂譜出來是數字，所以它獨立成
//  一個檔案並且有測試；其餘那些（Worker、OfflineAudioContext、LAME）只能靠耳朵。
//
//  ─── 只做前 GAME_TRACKS 軌 ───
//
//  匯出的定位是「別人在遊戲裡會聽到的那首曲子」，而遊戲只讀前 6 軌 —— 輔助軌是本站的工作
//  區，它們發出來的聲音是遊戲裡不可能存在的。所以這裡在**產生事件時**就切掉，不是在合成器
//  那端靜音：沒產生的事件不會佔 voice，也不會有人得去記得那幾條 channel 要關。
//
//  **靜音旗標不看。** `tracks.js` 那條規矩是「產出檔案的地方一律當它不存在」，而 mp3 是檔
//  案。靜音刻意不進暫存（重整就回預設），拿它決定檔案內容的話，使用者會拿到一個少一軌而且
//  他不會發現的 mp3。
// ────────────────────────────────────────────────────────────────────────────

import { chanOf, GAME_TRACKS } from "./config.js";

/**
 * 尾巴：整首之後還要多渲染幾秒。釋放包絡與殘響衰減都發生在 `song.duration` 之後。3 秒是估的
 * 上限，渲染完再自動裁掉尾端的靜音。
 *
 * 不能改成「等 voice 數歸零」：殘響的尾巴不算 voice（它在效果器裡）。
 */
export const TAIL_SEC = 3;

/** 一個事件佔幾個 int：`[frame, ch, midi, vel]`。 */
export const EV_STRIDE = 4;

/**
 * note off 的力度編碼。用 -1 而不是 0：MIDI 慣例裡 velocity 0 的 noteOn 等於 note off，但那是
 * **訊息層**的約定，而這裡是直接呼叫兩個不同的函式 —— 0 在這裡是合法的 note on 力度。
 */
export const VEL_OFF = -1;

/**
 * 太短的音要整個丟掉，門檻同 `player.js` 的 `off - on < 0.001`。保留這個門檻是為了**跟即時播放
 * 聽起來一樣**：長度 0 的音會排出「noteOn 緊接著同一時刻的 noteOff」，聽起來是一聲爆音 —— 匯出
 * 沒有同一個門檻就會出現「編輯器裡沒有、mp3 裡有」的爆音。
 *
 * **影片的 `waterfall.prepare` 用的也是這一個。** 各養一份的話，症狀是「畫面上有一根音符卻沒有聲音」
 * （或反過來），而那是靠眼睛絕對抓不到的一格。
 */
export const MIN_DUR = 0.001;

/**
 * 有音符的軌，只看前 `GAME_TRACKS` 軌。**舞台上畫誰問的就是這一個函式** —— 舞台上看得到一張
 * 牌子、匯出卻沒有那一軌是最難解釋的一種錯。
 *
 * 靜音的軌照常在裡面（見檔頭）。沒有音符的完全不畫 —— 空的軌是常態，畫出來只是噪音。
 *
 * @returns {number[]} 軌號，由小到大
 */
export function notedTracks(song) {
  const out = [];
  song.tracks.slice(0, GAME_TRACKS).forEach((tr, i) => { if (tr.notes.length) out.push(i); });
  return out;
}

/**
 * 有幾軌會被丟掉。**這是「按下去之前」要講的那句話的資料來源** —— 使用者在編輯器裡放了 9 條
 * 輔助軌，匯出卻只有 6 軌，事後才發現已經來不及了。同 sharebox 的事前警告。
 *
 * 只回報**真的有音符**的。空的輔助軌不講話，那是常態。
 *
 * @returns {number[]} 被丟掉的軌號（1-based，給人看的）
 */
export function droppedTracks(song) {
  return song.tracks.slice(GAME_TRACKS)
    .map((tr, i) => (tr.notes.length ? GAME_TRACKS + i + 1 : 0))
    .filter(Boolean);
}

/**
 * 開場要送的音色選擇。**這是離線合成器唯一需要的初始狀態** —— 查過整份程式碼，站上對合成器的
 * per-channel 控制只有 `engine.selectProgram`（CC0／CC32＋programChange）與
 * `engine.setChannelMute`，沒有音量、pan、expression，也沒有使用者調得動的主音量。這個結論
 * 讓「匯出跟編輯器不一樣」的可能原因少掉一整類。
 *
 * @param {(number[]|null)[]} presets 每一軌選到的 `[msb, lsb, program]`，同 tracks.presetOf
 * @returns {{ch:number, msb:number, lsb:number, prog:number}[]}
 */
export function buildSetup(presets) {
  const out = [];
  presets.slice(0, GAME_TRACKS).forEach((p, i) => {
    if (!p) return;
    out.push({ ch: chanOf(i), msb: p[0], lsb: p[1], prog: p[2] });
  });
  return out;
}

/**
 * 整首歌攤平成一串事件，照 sample 位置排好。
 *
 * **同一個 frame 上 note off 排在 note on 前面** —— 一個音剛好結束在下一個同音高的音開始的那一刻
 * （MML 裡很常見）如果先發 on 再發 off，那個 off 會把剛按下去的音立刻殺掉，症狀是「連續的相同音
 * 只響第一個」。`frame` 用 `Math.round` 而不是 `floor`（後者會讓每個音早半個 sample）。
 *
 * `totalFrames` 用的是 `song.duration`（**整首**，含輔助軌）而不是前 6 軌自己的結尾 —— 尾巴多
 * 算一點會被 `trimTail` 還回去，算少了則是把音樂切掉。
 *
 * @param {{tracks:{notes:{start:number,dur:number,midi:number,vel:number}[]}[], duration:number}} song
 * @param {{sampleRate?:number, tailSec?:number}} opts
 * @returns {{events:Int32Array, count:number, totalFrames:number}}
 */
export function buildEvents(song, { sampleRate = 44100, tailSec = TAIL_SEC } = {}) {
  const raw = [];
  song.tracks.slice(0, GAME_TRACKS).forEach((tr, i) => {
    const ch = chanOf(i);
    for (const n of tr.notes) {
      if (n.dur < MIN_DUR) continue;
      raw.push({ frame: Math.round(n.start * sampleRate), ch, midi: n.midi, vel: n.vel });
      raw.push({ frame: Math.round((n.start + n.dur) * sampleRate), ch, midi: n.midi, vel: VEL_OFF });
    }
  });

  // off 先於 on（見上面）。`vel < 0 ? 0 : 1` 就是那個次序鍵。
  raw.sort((a, b) => a.frame - b.frame || (a.vel < 0 ? 0 : 1) - (b.vel < 0 ? 0 : 1));

  const events = new Int32Array(raw.length * EV_STRIDE);
  raw.forEach((e, i) => {
    const o = i * EV_STRIDE;
    events[o] = e.frame;
    events[o + 1] = e.ch;
    events[o + 2] = e.midi;
    events[o + 3] = e.vel;
  });

  return {
    events,
    count: raw.length,
    totalFrames: Math.ceil((song.duration + tailSec) * sampleRate),
  };
}
