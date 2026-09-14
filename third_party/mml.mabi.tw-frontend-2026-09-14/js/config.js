// ────────────────────────────────────────────────────────────────────────────
//  常數與預設樂譜
//  所有「跟遊戲對不上就改這裡」的旋鈕都集中在這一個檔案。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 專案根目錄底下的檔案路徑。用 import.meta.url 算，不是寫 "./vendor/…" —— 後者對
 * addModule()／fetch() 是相對於「文件」而不是「這個模組」，搬動 js/ 就會悄悄壞掉。
 */
export const assetURL = p => new URL("../" + p, import.meta.url).href;

export const WORKLET = assetURL("vendor/spessasynth_processor.js");
export const BOOT    = assetURL("worklet-boot.js");

/** 開站自動載入竹的那份。檔名同時要拿去顯示，所以名字和 URL 分開存。 */
export const BUILTIN_BANK = "Fury_Sound_Pack_v150.dls";
export const BUILTIN_DEF  = "Fury_Sound_Pack_v150.def";

// ─── 軌 ─────────────────────────────────────────────────────────────────────

/**
 * 編輯器開得出幾個分頁。**遊戲只吃前 6 軌**，後面 9 個是本站的輔助軌。
 *
 * 15 是**硬天花板**：一軌直接對到一個合成器 channel（見 chanOf），MIDI 有 16 個，
 * 而 channel 9 在 GM 裡固定是打擊組。
 *
 * 「哪 6 軌會進遊戲」= **前 6 個分頁**，位置就是身分（沒有軌 ID 這種東西）。
 */
export const MAX_TRACKS = 15;
/** 遊戲的空白樂譜吃幾軌。剪貼簿與分享只送這麼多。 */
export const GAME_TRACKS = 6;
export const MIN_TRACKS = 3;     // 一開始就有、也刪不掉的三軌

/**
 * 軌號 → 合成器／MIDI channel。**這是唯一的定義**，播放、另存 MIDI、選音色三個
 * 呼叫端都必須走它。
 *
 * channel 9 跳過，因為 vendor 裡的打擊組判定是**無條件**的：
 *
 *   spessasynth_core.js   ch.isDrum = i % 16 === 9
 *                         this.setDrums(this.channel % 16 === 9)
 *                         presets.find(p => p.isDrum) ?? presets[0]
 *
 * 所以第 10 個分頁若照 index 對到 channel 9，它**在站上播放時就會變成打擊樂**。改送
 * bank select 關掉打擊模式行不通：瑪奇、3MLE、別人的 DAW 卜還是會把 channel 10 當打擊組。
 */
export const chanOf = track => (track < 9 ? track : track + 1);

/**
 * 試聽專用的 channel（第 17 條，index 16）。**任何一軌都不會用到它** —— 借用當前軌
 * 自己的 channel 的話，放開琴鍵送出的 `noteOff` 會切掉曲子裡同音高的那個音，而且被
 * 靜音的軌試不出聲音。
 *
 * 打擊組判定是 `i % 16 === 9`，而 `16 % 16 = 0`，所以它是普通的旋律 channel；
 * **存在**是靠 `engine.loadBank` 多開的那一條（MIDI 只定義 16 個）。
 *
 * **`chanOf` 永遠不會回傳它**，`applyMutes` 也因此碰不到它 —— 那正是「試聽不套用軌
 * 靜音」的實作依據。
 */
export const AUDITION_CH = 16;

/**
 * 單軌的字數上限 —— **遊戲的硬限制**。算的是「去掉空白之後」的長度（匯出時空白會被
 * 剝掉，見 clipboard.exportText）。編輯器不擋超過，只把字數變紅。
 */
export const MAX_TRACK_CHARS = 2400;

/** 純粹為了效能的煞車，跟遊戲無關。**只有這一條會真的截掉內容。** */
export const HARD_TRACK_CHARS = 40000;

/**
 * 一軌的**壓縮模式**。`null` = 沒壓過（編輯一律產生照實版），`ZIP_LOSSLESS` = 按過
 * 「優化」，之後每一次程式寫回都會再無損壓一次（見 ui 的 zipFinal）。
 *
 *  只有無損這一種**進得了狀態**。三個有損規則（fill / partial / release）按了也只標成
 * `ZIP_LOSSLESS` —— 自動重跑有損等於每動一個音就悄悄改一次音樂，而且是累積的。
 */
export const ZIP_LOSSLESS = "lossless";
// 軌名搬到語言檔了（key 是 track.name.<n>），用 i18n.trackName(i) 取。

/**
 * 15 個軌色。
 *
 * **前三個同時是整個 App 的品牌色**（`--t1` / `--t2` / `--t3`，見 Index.cshtml 的
 * `:root`），所以前 6 個一個都不能動。
 *
 * 後 9 個：S 38–68%、L 52–68%（跟舊色同一帶），而且**打散指派、不按色相排序** ——
 * 沿色相環跑的話相鄰兩個分頁最近只差 22°，打散之後是 66°，而相鄰的軌常常同時發聲。
 */
export const TRACK_COLORS = [
  // 主 6 十軌：H38 金 / H169 青綠 / H281 紫 / H215 藍 / H347 玫瑰 / H81 黃綠
  "#e0ae5a", "#57b6a4", "#b487c9", "#7aa5e0", "#e0788f", "#a3c464",
  // 輔助 1–9：H12 朱橙 / H192 天青 / H105 綠 / H305 洋紅 / H58 黃
  "#db7e66", "#64b9ce", "#74bc5c", "#c577be", "#cfcb59",
  //          H240 靛 / H135 深綠 / H328 玫紅 / H262 紫藍
  "#8585d6", "#56b36d", "#d373a6", "#9f84cd",
];

/**
 * 影片瀑布的調色盤，30 色。**跟 `TRACK_COLORS` 是兩份，那是刻意的。**
 *
 * `TRACK_COLORS` 是為鋼琴捲軸調的中低飽和色，而且前三個同時是品牌色 —— 動不得。但那一組搬到
 * 瀑布上偏灰：影片是深底、音符會發光，`lighter` 加法混色底下中低飽和的顏色存在感明顯不足。
 * 所以影片自己一份，飽和度與亮度都往上拉。
 *
 * 前 16 色的索引已經進入使用者偏好，不能重排；新增的 14 色追加在後面。UI 的色相排列另由
 * `NOTE_COLOR_ORDER` 決定，所以顯示順序與持久化 ID 可以分開演進。
 *
 * 這份只有影片在用。編輯器的分頁、鋼琴捲軸、琴弦、混音舞台全部還是走 `TRACK_COLORS` —— 那邊
 * 需要 `MAX_TRACKS`（15）個，砍成 6 個的話後 9 個分頁會沒有顏色。
 */
export const NOTE_COLORS = [
  // 01 天空藍 / 02 蜜柑橙 / 03 翡翠綠 / 04 薔薇粉
  "#4FC3F7", "#FF9F45", "#4CD97B", "#FF6E9C",
  // 05 琥珀金 / 06 紫水晶 / 07 薄荷青 / 08 珊瑚紅
  "#FFC93C", "#B06AF0", "#45E0C0", "#FF5C5C",
  // 09 寶石藍 / 10 萊姆綠 / 11 蘭花紫 / 12 湖水青
  "#5B8DEF", "#A8E05F", "#E06AD4", "#35C9DD",
  // 13 紫藤 / 14 檸檬黃 / 15 柿子橘 / 16 月光白
  "#8B7BF7", "#F2E25C", "#FF8A65", "#E8ECF4",
  // 17 栗子棕 / 18 烈焰橙 / 19 深橄欖 / 20 松林綠
  "#8A4B32", "#FF6A00", "#66712D", "#246B4A",
  // 21 深孔雀青 / 22 霓虹青 / 23 電光藍 / 24 暮灰藍
  "#126C78", "#00D9FF", "#1677FF", "#505C78",
  // 25 午夜藍 / 26 深靛紫 / 27 電光紫 / 28 桃紅
  "#243B7A", "#43327A", "#7D35FF", "#FF2DAA",
  // 29 酒莓紅 / 30 緋紅
  "#87354F", "#FF2442",
];

/**
 * 選色 UI 的色相順序。持久化仍使用 `NOTE_COLORS` 的穩定索引，避免舊偏好靜默換色。
 */
export const NOTE_COLOR_ORDER = [
  7, 14, 16, 17, 1, 4, 13, 18, 9, 2, 19, 6, 20, 11, 21,
  0, 22, 8, 23, 24, 12, 25, 26, 5, 10, 27, 28, 3, 29, 15,
];

/**
 * 六個影片軌的預設顏色，值是 `NOTE_COLORS` 的索引。
 *
 * **不是 `[0,1,2,3,4,5]`，而是「每一軌對到色相最接近的那個新色」。** 編輯器的分頁顏色與影片
 * 裡的音符顏色維持同一個色系，是使用者唯一能把「畫面上這條」對回「我寫的那一軌」的線索 ——
 * 換掉調色盤不該把那條線索一起換掉。六組的色相差只有 1～10°，而名字本身就在呼應：
 *
 *   主旋律 金 → 琥珀金 ‧ 和弦1 青綠 → 薄荷青 ‧ 和弦2 紫 → 紫水晶
 *   和弦3 藍 → 寶石藍 ‧ 和弦4 玫瑰 → 薔薇粉 ‧ 和弦5 黃綠 → 萊姆綠
 *
 * **改 `NOTE_COLORS` 的順序就會改到這裡**，兩份要一起看。
 */
export const NOTE_DEFAULTS = [4, 6, 5, 8, 3, 9];

// ─── 瑪奇 MML 的語言常數 ────────────────────────────────────────────────────

export const OCT_BASE = 12;          // o<n>c 的 MIDI = n*12 + OCT_BASE，故 o4c = 60
export const N_BASE   = OCT_BASE;    // n0 = o0c = 12（對齊 MabiMmlPlayer 的 note + 12）
export const PPQ      = 480;         // 每個四分音符幾個 tick。先算 tick 再換秒。

// ─── 音域 ───────────────────────────────────────────────────────────────────

/**
 * 音高「準」的那一段是 **o2c–o7e**（GAME_MIN/GAME_MAX），不是限制 —— 編輯器允許的
 * 範圍是 PITCH_MIN/PITCH_MAX（o1c–o7b）。
 *
 * 底下寫成「第幾個八度 + OCT_BASE」而不是硬寫 36／100，是因為 `N_BASE === OCT_BASE`：
 * 實測的那兩個 n 值換成 o 標記時**跟基準的絕對值無關**。
 *
 * **o7 是半個八度**（只到 o7e）。`o` 的夾範圍放行整個 o7，是最終音高那道夾（mml.js
 * 的 push）擋掉 o7f 女以上。
 *
 * 解析器把 o 夾在 OCT_MIN..OCT_MAX，也把最終音高夾在 PITCH_MIN..PITCH_MAX —— 升降
 * 記號（o2c-）與 n 指令（n200）都能繞過前者。後者是鋼琴捲軸的地基不變式：**每個解析
 * 出來的音都保證在捲軸上有一格**。
 */
export const OCT_MIN = 1;
export const OCT_MAX = 7;

/**
 * **超出去的音不擋，因為遊戲也不擋。**
 *
 * 實測到的那兩個邊界**量到的是音色庫，不是遊戲的解析器** ——
 * `Fury_Sound_Pack_v150.dls` 的 region 就是這樣接的（`wsmp` 的 unity note）：
 *
 *   key  24- 27  unity  16  → 發出 36-39   ＝ 聽起來高一個八度
 *   key  28- 51  unity  28  → 發出 28-51   ＝ 正常
 *   key  77-100  unity  77  → 發出 77-100  ＝ 正常
 *   key 101-112  unity  89  → 發出 89-100  ＝ 低一個八度
 *   key 113-119  unity 101  → 發出 89- 95  ＝ 低兩個八度
 *
 * 「n89 聽起來是 n77」音色庫自己就會產生，所以**站上什麼都不用做**：原封不動把那個
 * key 送給合成器，聽到的就跟遊戲一樣。
 *
 * 於是音域就是**捲軸畫得出來的範圍**，o1c–o7b、84 列。折八度（`foldIntoRange`）只剩
 * 一個角色：`o0c`、`n200` 這種**連捲軸都畫不出來**的音。
 */
export const PITCH_MIN = 1 * 12 + OCT_BASE;              //  24 = o1c = n12
export const PITCH_MAX = 7 * 12 + OCT_BASE + 11;         // 107 = o7b = n95

/**
 * **音高「準」的那一段**：`o1e`–`o7e`（= `n16`–`n88`），剛好 6 個整八度 —— 兩個邊界
 * **跟上面那張 unity note 竹的表逐一吻合**（key 28 是 region 28–51 的 unity note，
 * key 101 開始那段的 unity note 是 89）。
 *
 * 它**不限制任何東西**，只決定捲軸怎麼畫（見 pianoroll 的 `C.dimRow` / `C.dimKey`），
 * 而且**跟著音色庫走**：換一個音色庫，折的位置就不一樣。
 */
export const GAME_MIN = 1 * 12 + OCT_BASE + 4;           //  28 = o1e = n16
export const GAME_MAX = 7 * 12 + OCT_BASE + 4;           // 100 = o7e = n88

/** 這個音高在遊戲裡聽起來就是譜上寫的那個嗎？（不準的那幾列畫暗一點） */
export const soundsAsWritten = midi => midi >= GAME_MIN && midi <= GAME_MAX;

/**
 * 捲軸畫的列：**o1c–o7b，84 列**，跟音域同一個範圍。刻意**分成兩組常數**：列座標與
 * 「這個音高合不合法」是兩件事。**列座標一律用 ROLL_MIN／ROLL_MAX 算**，混用的症狀
 * 是音符整批偏幾列。
 */
export const ROLL_MIN = PITCH_MIN;                       //  24 = o1c
export const ROLL_MAX = PITCH_MAX;                       // 107 = o7b
export const PITCH_ROWS = ROLL_MAX - ROLL_MIN + 1;       //  84 列

/** 這一列按得下去嗎（畫音符、選取、拖曳、左側鍵盤試聽都問它）。 */
export const playable = midi => midi >= PITCH_MIN && midi <= PITCH_MAX;

/**
 * `o1c`–`o7b` 之外的音 → **折整數個八度**塞進來，音級不變。
 *
 * 這**不是音域政策**（見 PITCH_MIN 那段），它服務的是捲軸的地基不變式：**每人個解析
 * 出來的音都要在捲軸上有一格**。折八度而不是夾邊界，因為夾邊界會把 `o0cdefg` 壓成
 * 同一個音，折八度是 `o1cdefg`、旋律線完整。範圍寬 84 > 12，折完一定落在範圍內。
 */
export const foldIntoRange = midi => {
  let m = midi;
  while (m < PITCH_MIN) m += 12;
  while (m > PITCH_MAX) m -= 12;
  return m;
};

/**
 * 音高 → MML 的一種寫法（`o4c`）。**給訊息與標籤用**，不是產生器（產生器要在 `b+`
 * / `c-` / `n<num>` 之間挑最短的，見 mml-compress）。訊息裡的邊界得講到音級：說
 * 「超出 o1–o7」的話，寫了 o7g 的人會覺得訊息在騙他。
 */
const SEMI_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
export const pitchName = midi =>
  `o${Math.floor((midi - OCT_BASE) / 12)}${SEMI_NAMES[((midi - OCT_BASE) % 12 + 12) % 12]}`;

/**
 * **一個 4/4 小節**幾個 tick。拍號上線之後小節長度是變動的，所以**要問「這個位置的
 * 小節多長」一律用 `barTicksAt(tick)`**。這個常數仍然是三件跟拍號無關的事的答案：
 *
 *   1. **預設拍號的小節長**（拍號圖為空 = 今天的行為）
 *   2. `lenTicks` 的分子 —— `l4` 是「四分音符」不是「四分之一小節」，在 3/4 裡 `c4`
 *      一樣是 480 tick。**MML 的音長從來不看拍號。**
 *   3. 一個現成的、好讀的 tick 單位
 */
export const BAR_TICKS = PPQ * 4;

// ─── 鋼琴捲軸 ───────────────────────────────────────────────────────────────

/**
 * 一木格幾個 tick，以及**一個 4/4 小節**幾格。「格子是 32 分音符（`PPQ / 8`）」是第一
 * 性的，「一小節幾格」只是拍號的結果 —— 反過來寫的話 3/4 會讓整個格線系統跟著拍號
 * 變形。所有合法拍號的小節長都是 60 的倍數，所以每一種都**剛好**是整數格。
 */
export const CELL_TICKS = PPQ / 8;                      // 60，最細支援到 32 分音符
export const CELLS_PER_BAR = BAR_TICKS / CELL_TICKS;    // 32，**4/4 的**一小節幾格

/**
 * 拖曳中用方向鍵微調的步長。**30 tick = `l64` = 半格。**
 *
 * `lenTicks` 是 `floor(1920/分母)`，所以最短的單一時值就是 `l64` 的 30，而 30 的倍數
 * 全部寫得出來，**不需要動 `STD_NUMS`**。再細一階要付三件事：STD_NUMS 的 tick 最大
 * 公因數從 5 掉到 1、`pickAlign` 的對齊優化失效、`l5`／`l7`／`l9` 沒有人在遊戲裡驗過。
 */
export const FINE_TICKS = 30;

/**
 * 一格的寬與一列的高（CSS px）。12 是**建議**下限：音符右邊框的抓取區要留 4–5px，而
 * 一個 32 分音符方塊只有 CELL_W 寬（30 tick 的微調音符更只有 6px，見 pianoroll.locate
 * 的 zone）。解是水平縮放，而縮放同時讓使用者縮得到 12 以下 —— 見 `ZOOM_W` 的 ⚠️。
 *
 * 這兩個是**預設檔位**：pianoroll.js 把它們複製成模組層變數，縮放就是改那兩個變數。
 */
export const CELL_W = 12;
export const ROW_H  = 12;

/**
 * 縮放的檔位。**離散而不是連續**：格線要落在整數像素上才不會糊，捲軸位置的換算也不
 * 會累積浮點誤差。兩軸分開：橫向是為了抓得到右邊框，縱向是為了看清楚音高。
 *
 * 檔位都挑戈成「`c64`（30 tick = 半格）落在整數像素」，所以格寬一律取偶數（2→1、4→2、
 * 6→3、8→4、12→6、16→8、24→12、32→16）。
 *
 * **往下開到 2px 是知情的取捨**：抓取區是 `min(RESIZE_ZONE, max(2, 寬/3))`，4px 檔
 * 的 `c64` 實質上抓不到。縮到那裡是為了**看**，不是為了編。格線減層見 `gridStep`。
 *
 * **高的下限是 6，不能再往下開**：音符方塊的高度是 `ROW_H - 4`（見 pianoroll 的
 * drawNotes），4px 檔會讓它變成 0 —— 音符直接消失。橫線減層見 `rowLinesAt`。
 */
export const ZOOM_W = [2, 4, 6, 8, 12, 16, 24, 32];
export const ZOOM_H = [6, 8, 12, 16, 24, 32];

/**
 * 往上／往下挪一檔。到頂／到底回 `null`。目前的值不在檔位表裡也回 `null` —— 那代表
 * 有人繞過這條路直接寫了 `CELL_W`，安靜地跳到最近的檔位會把那個 bug 蓋掉。
 *
 * @param {number[]} steps 檔位表（由小到大）
 * @param {number} cur 目前的值
 * @param {number} dir +1 放大、-1 縮小
 * @returns {number|null} 下一檔的值
 */
export const zoomStep = (steps, cur, dir) => {
  const i = steps.indexOf(cur);
  if (i < 0) return null;
  const n = i + dir;
  return n >= 0 && n < steps.length ? steps[n] : null;
};

/**
 * 縮放之後捲到哪裡，才能讓錨點底下的那一格／那一列**留在原地**。換算走「第幾格／第
 * 幾列」這個**跟縮放無關**的單位：直接算像素比例會在連按十幾次之後漂掉。下限自己夾
 * （負的 `scrollLeft` 不會被瀏覽器夾回去，上限會）。
 *
 * @param {number} scroll 目前竹的捲動位移（px）
 * @param {number} anchor 錨點離內容區左上角有多遠（px，不隨縮放變）
 * @param {number} oldSize 舊的格寬／列高
 * @param {number} newSize 新的格寬／列高
 */
export const zoomScroll = (scroll, anchor, oldSize, newSize) =>
  Math.max(0, ((scroll + anchor) / oldSize) * newSize - anchor);

/**
 * 直線格線要**幾格畫一條**：≥12 每格、8–11 每 2 格（半拍）、6–7 每 4 格（一拍）、
 * ≤4 每 8 格（兩拍）。準則是**線距**（每一檔都落在 12–32px），不是音符時值。
 *
 * 減層用「跳過」而不是換一套分類：拍線是 8 的倍數、小節線是 32 的倍數，都被 2 / 4 / 8
 * 整除，所以無論跳成哪一檔它們都還在。
 */
export const gridStep = cellW => (cellW >= 12 ? 1 : cellW >= 8 ? 2 : cellW >= 6 ? 4 : 8);

/**
 * 橫線要不要畫**每一列**那層（八度線一律留著）。理由同 `gridStep`。門檻放在 8 ——
 * 那是原本的最小列高，那個密度是驗過的。
 */
export const rowLinesAt = rowH => rowH >= 8;

/**
 * 雙指張合的三個門檻。三個都是**獨立的問題**，不要合併：
 *
 *   PINCH_SLOP  間距要變這麼多才算「他在張合」而不是「他在平移」（兩指平移時相對
 *               距離本來就會晃幾像素）。
 *   PINCH_SPAN  某一軸的間距低於這個就**不拿它判軸向、也不拿它算比值**：兩指垂直
 *               對齊時水平間距趨近 0，比值會炸掉或全是抖動。
 *   PINCH_STEP  間距變成這個倍數 = 換一檔。1.35 是因為兩張檔位表相鄰兩檔的比值幾乎
 *               都在 1.33～1.5 之間，所女以縮放跟著手指走。
 */
export const PINCH_SLOP = 12;    // px
export const PINCH_SPAN = 40;    // px
export const PINCH_STEP = 1.35;

/**
 * 雙指在動 —— 是張合（縮放哪一軸），還是不算張合？
 *
 * **拿兩軸的間距、不拿兩指的直線距離與角度**：斜擺著兩指做水平張開是很常見的握法，
 * 用「連線角度」判軸向會判成對角、再四捨五入到錯的那一軸。各軸分開量之後判準變成
 * 「哪一軸的間距**變化**比較大」。兩指一起移動時間距幾乎不變，所以「間距變化量」與
 * 「質心位移量」不會同時大 —— 回 `null` 表示「還不算張合」。兩軸相等時給格寬。
 *
 * @param {{x:number,y:number}} span 現在兩指在各軸上的間距（絕對值）
 * @param {{x:number,y:number}} span0 手勢開始時的間距
 * @param {number} dPan 質心從手勢開始到現在移動了多遠
 * @returns {"w"|"h"|null} 要縮放的軸，或 null（還不算張合）
 */
export function pinchAxis(span, span0, dPan) {
  const dx = span0.x >= PINCH_SPAN ? Math.abs(span.x - span0.x) : 0;
  const dy = span0.y >= PINCH_SPAN ? Math.abs(span.y - span0.y) : 0;
  const dSpan = Math.max(dx, dy);
  if (dSpan < PINCH_SLOP || dSpan <= dPan) return null;
  return dx >= dy ? "w" : "h";
}

/**
 * 縮放中：間距從基準變到現在，該換幾檔、往哪邊換。**跟滾輪是同一個模式** —— 留一個
 * 基準，跨過倍數才換一檔並把基準推到當下的位置。
 *
 * @param {number} cur 現在那一軸的間距
 * @param {number} ref 上次換檔時的日間距
 * @returns {-1|0|1} 放大／不動／縮小
 */
export const zoomTick = (cur, ref) =>
  (cur / ref >= PINCH_STEP ? 1 : cur / ref <= 1 / PINCH_STEP ? -1 : 0);

/** 譜的結尾之後要多留幾小節空白。沒有格子就沒辦法用捲軸延長曲子，只能回去打字。 */
export const PAD_BARS = 4;
export const MIN_BARS = 16;      // 空譜也要有東西可以點

export const GUTTER_W = 46;      // 左側鋼琴鍵盤的寬（固定，不隨水平捲動）
export const RULER_H  = 18;      // 上方小節號尺的高（固定，不隨垂直捲動）

/** 拖分隔線時，捲軸至少要留幾個八度看得到（再加上小節號尺與水平捲軸的高度）。 */
export const MIN_ROLL_OCTAVES = 1;

/** 捲軸座標的純算術。放在這裡是為了能在 node 裡測 —— pianoroll.js 匯入 engine.js，而它在 node 裡載不起來。 */
export const midiToRow = midi => ROLL_MAX - midi;
export const rowToMidi = row => ROLL_MAX - row;
export const tickToPx = (tick, cellW = CELL_W) => (tick / CELL_TICKS) * cellW;
export const pxToTick = (px, cellW = CELL_W) => (px / cellW) * CELL_TICKS;

// ─── 拍號圖 ─────────────────────────────────────────────────────────────────
//
//  **MML 沒有拍號**，所以拍號對聲音是**零影響**的 —— 它只決定小節線畫在哪，以及所有
//  「以小節為單位」的操作算出來的邊界在哪。改拍號**不會動到任何一個音符的 tick**。
//
//    [ { tick: 0, num: 4, den: 4 }, { tick: 23040, num: 3, den: 4 }, … ]
//
//  不變量（由 `cleanMeters` 人保證，不是由呼叫端保證）：照 tick 遞增、tick 不重複、
//  **`tick: 0` 那一筆一定在**。
//
//  **一個變拍的 tick 永遠是一條小節線**，所以前一個拍號的最後一小節可能**被截短**。
//  這讓「任何 tick 集合都有唯一解」成立，不需要「吸到哪一條線」的規則，也就不會偷偷
//  搬動使用者設好的記號。
// ────────────────────────────────────────────────────────────────────────────

/** 沒有任何拍號資訊時就是它。跟 `BAR_TICKS` 是同一件事的兩種寫法。 */
export const DEFAULT_METER = Object.freeze({ num: 4, den: 4 });

/**
 * 一個拍號的小節長度（tick）。`PPQ * 4 / den` 是「一個分母音符」多長，乘上分子就是
 * 一小節。跟 `lenTicks` 是**同一個算法**卻是**不同的問題**。
 */
export const meterTicks = ({ num, den }) => num * (PPQ * 4 / den);

/** 拍號寫成字串。`{num:3,den:4}` → `"3/4"`。給標籤與訊息用。 */
export const meterName = ({ num, den }) => `${num}/${den}`;

/**
 * 分母的白名單。**音樂上分母必然是 2 的冪**，所以這不是這裡訂的限制，是格式本身的
 * 性質。上限 32 對齊 `CELL_TICKS`（`1/32` 剛好一格）。
 *
 * 這是**清洗**用的範圍，不是**輸入**用的範圍（後者見 ui.js 的 `METER_NUMS` /
 * `METER_DENS`）—— 匯進來的檔案什麼都可能有，而把 5/8 硬轉成 4/4 會讓小節線錯位。
 */
const DEN_OK = new Set([1, 2, 4, 8, 16, 32]);
const NUM_MAX = 99;

/**
 * 把來源不明竹的拍號陣列洗成可用的圖。**存檔、暫存、匯入三條路都要先過這裡。**
 *
 * 壞掉的**逐筆丟掉**，不是整張圖丟掉，更不是讓整份存檔判定損毀 —— 舊存檔根本沒有這
 * 個欄位，而它們必須照開。
 *
 * @param {unknown} raw 不是陣列就當成「沒有拍號」。
 * @returns {{tick:number,num:number,den:number}[]} 至少有一筆（tick 0）
 */
export function cleanMeters(raw) {
  const ok = [];
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      const { tick, num, den } = m;
      if (!Number.isInteger(tick) || tick < 0) continue;
      if (!Number.isInteger(num) || num < 1 || num > NUM_MAX) continue;
      if (!Number.isInteger(den) || !DEN_OK.has(den)) continue;
      ok.push({ tick, num, den });
    }
  }
  // `sort` 是穩定的，所以同 tick 的相對順序不變 —— 下面「取後者」才有意義
  ok.sort((a, b) => a.tick - b.tick);

  const out = [];
  for (const m of ok) {
    if (out.length && out[out.length - 1].tick === m.tick) out[out.length - 1] = m;
    else out.push(m);
  }
  // 曲首拍號一定要在。缺了的話 `meterAt(0)` 沒有答案，而所有小節計算都從 0 開始走。
  if (!out.length || out[0].tick !== 0) out.unshift({ tick: 0, ...DEFAULT_METER });
  return out;
}

/**
 * 拍號田圖 → 一組小節座標換算。**純函式**（不碰模組狀態），所以測得動。
 *
 * 內部切成「段落」：一個拍號從它的 tick 管到下一個變拍為止，段落內每一小節等長，只有
 * **最後一小節可能被截短**（見檔頭）。段落數量是個位數，線性掃過去就夠了。
 */
export function makeBarMap(rawMeters) {
  const meters = cleanMeters(rawMeters);

  // 每個段落：起始 tick、拍號、小節長、**這個段落之前總共有幾小節**。
  // 最後一個段落沒有結尾（曲子可以無限往後延），所以 `bars` 是 Infinity。
  const segs = meters.map((m, i) => {
    const start = m.tick;
    const end = meters[i + 1]?.tick ?? Infinity;
    const len = meterTicks(m);
    // 截短的那一小節**照算一小節**：它在畫面上是一小節、在小節號上也佔一個號碼。
    const bars = end === Infinity ? Infinity : Math.ceil((end - start) / len);
    return { start, end, len, bars, meter: m };
  });
  let acc = 0;
  for (const s of segs) { s.bar0 = acc; acc += s.bars; }

  const segAtTick = tick => {
    const t = Math.max(0, tick);
    for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start) return segs[i];
    return segs[0];
  };
  const segAtBar = n => {
    for (let i = segs.length - 1; i >= 0; i--) if (n >= segs[i].bar0) return segs[i];
    return segs[0];
  };

  /** 卜這個 tick 在哪個拍號底下。 */
  const meterAt = tick => segAtTick(tick).meter;

  /** 這個 tick 所在的小節，從 0 數起。 */
  const barIndexOf = tick => {
    const s = segAtTick(tick);
    return s.bar0 + Math.floor((Math.max(0, tick) - s.start) / s.len);
  };

  /** 第 n 小節（0 起）從哪個 tick 開始。夾在它所屬段落的範圍內。 */
  const barStartTick = n => {
    const b = Math.max(0, Math.floor(n));
    const s = segAtBar(b);
    const t = s.start + (b - s.bar0) * s.len;
    return s.end === Infinity ? t : Math.min(t, s.end);
  };

  /**
   * 這個 tick 所在的小節有多長 —— **最後一小節可能被截短**，所以這是唯一一個「不能
   * 直接拿 `meterTicks` 算」的查詢。插入小節、跳一小節都吃它。
   */
  const barTicksAt = tick => {
    const s = segAtTick(tick);
    const start = barStartTick(barIndexOf(tick));
    return s.end === Infinity ? s.len : Math.min(s.len, s.end - start);
  };

  /** 涵蓋 `endTick` 需要幾個**完整**小節。剛好落在小節線上時不多算一個。 */
  const barCountFor = endTick =>
    endTick <= 0 ? 0 : barIndexOf(endTick - 1) + 1;

  /** 整首歌要幾小節寬。留白日是為了能在結尾之後新增音符。 */
  const barsFor = endTick =>
    Math.max(MIN_BARS, barCountFor(Math.max(0, endTick)) + PAD_BARS);

  /**
   * 畫布要多長（tick）。**不能用 `barsFor() * BAR_TICKS`** —— 小節不等長之後那個
   * 乘法就沒有意義了，而它正是捲軸寬度的來源。
   */
  const contentTicks = endTick => barStartTick(barsFor(endTick));

  return {
    meters, segs,
    meterAt, barIndexOf, barStartTick, barTicksAt, barCountFor, barsFor, contentTicks,
  };
}

/**
 * **目前生效的**拍號圖 —— config.js 裡唯一一塊可變狀態，而它是刻意的：`BAR_TICKS`
 * 本來就被七個檔案當常數直接 import，把拍號當參數傳下去要動到 `mml-compress` 那些純
 * 函式的簽章。
 *
 * **「生效」不等於「這首歌存了什麼」**：關掉拍號功能時 ui 會推一張空圖進來（＝全曲
 * 4/4），歌曲自己的拍號原封不動留在快照裡。這就是那個開關的全部實作。
 */
let live = makeBarMap([]);

/** 換一張圖。回傳洗過的結果，呼叫端要存的是這一份。 */
export function setMeters(list) { live = makeBarMap(list); return live.meters; }

export const meters       = () => live.meters;
export const meterAt      = tick => live.meterAt(tick);
export const barIndexOf   = tick => live.barIndexOf(tick);
export const barStartTick = n => live.barStartTick(n);
export const barTicksAt   = tick => live.barTicksAt(tick);
export const barCountFor  = endTick => live.barCountFor(endTick);
export const contentTicks = endTick => live.contentTicks(endTick);

/** 整首歌要幾小節寬。留白是為了能在結尾之後新增卜音符。 */
export const barsFor = endTick => live.barsFor(endTick);

// ─── 段落標記 ───────────────────────────────────────────────────────────────
//
//  「前奏 / A段 / 副歌」那種標記。**跟拍號一樣對聲音零影響** —— MML 裡寫不下它。
//
//    [ { tick: 0, text: "前奏" }, { tick: 23040, text: "副歌" } ]
//
//  **顏色不在資料裡**，由「照 tick 排序後的第幾個」算出來（見 markColor），所以刪掉
//  中間一個之後後面的標記全部換色。靠位置決定才能保證**畫面上相鄰的兩個標記顏色一定
//  分得開**。也因此**沒有任何格式需要為了來回轉換而帶顏色**：一律重算（匯出時仍然寫
//  顏色，3MLE 的 tag 0x09 有那個欄位，只是讀回來時丟掉）。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 8 色循環。**順序是照相鄰對比度排的**，不是色相環的順序。白字配這八個底色都讀得清
 * 楚 —— **不要換成別的色**而不重新驗白字的對比度。
 */
export const MARK_COLORS = [
  "#ef7d7d",   // 1 珊瑚紅
  "#4ec9b0",   // 2 青綠
  "#e08bd4",   // 3 粉紫
  "#a8d05f",   // 4 黃綠
  "#f2c744",   // 5 金黃
  "#a89bf0",   // 6 薰衣草
  "#f0995a",   // 7 橙
  "#7ab8f5",   // 8 天藍
];

/** 第 i 人個標記（照 tick 排序）的顏色。 */
export const markColor = i => MARK_COLORS[((i % MARK_COLORS.length) + MARK_COLORS.length) % MARK_COLORS.length];

/**
 * 標記的數量上限。16 不是技術限制，是**畫面**限制：8 色循環到第 9 個就開始重複，而
 * 總覽尺上 16 個 4px 的點在 400px 的軌道上已經很密了。
 */
export const MAX_MARKS = 16;

/** 標記文字的長度上限，單位是**顯示寬度**（見 textWidth）。 */
export const MARK_WIDTH = 20;

/**
 * 字串的顯示寬度：全形算 2、其餘算 1。
 *
 * **不用位元組數**：需求是「20 個字節，中文只能 10 字」，那兩句只有在「一個寬字 = 2」
 * 時才同時成立 —— 那是 Big5 的位元組數，但 **Big5 編不出日文假名**，而這個站有日韓
 * 介面（UTF-8 更不行：20 bytes 只夠 6 個中文字）。
 *
 * ⚠️ 這**不是**完整的 UAX #11 表。漏掉的字會被當成寬度 1 —— 那個方向是安全竹的。
 */
export function textWidth(str) {
  let w = 0;
  for (const ch of String(str ?? "")) {
    const c = ch.codePointAt(0);
    w += (
      (c >= 0x1100 && c <= 0x115F) ||    // 諺文字母（初聲）
      (c >= 0x2E80 && c <= 0x303E) ||    // CJK 部首、康熙、CJK 符號
      (c >= 0x3041 && c <= 0x33FF) ||    // 假名、注音、諺文相容、CJK 相容
      (c >= 0x3400 && c <= 0x4DBF) ||    // CJK 擴充 A
      (c >= 0x4E00 && c <= 0x9FFF) ||    // CJK 基本區
      (c >= 0xA000 && c <= 0xA4CF) ||    // 彝文
      (c >= 0xAC00 && c <= 0xD7A3) ||    // 諺文音節
      (c >= 0xF900 && c <= 0xFAFF) ||    // CJK 相容表意
      (c >= 0xFE30 && c <= 0xFE6F) ||    // CJK 相容形式、小型形式
      (c >= 0xFF00 && c <= 0xFF60) ||    // 全形 ASCII
      (c >= 0xFFE0 && c <= 0xFFE6) ||    // 全形符號
      (c >= 0x1F300 && c <= 0x1F64F) ||  // emoji（符號與人物）
      (c >= 0x1F900 && c <= 0x1F9FF) ||  // emoji（補充）
      (c >= 0x20000 && c <= 0x3FFFD)     // CJK 擴充 B 以後
    ) ? 2 : 1;
  }
  return w;
}

/**
 * 夾到 `MARK_WIDTH` 的顯示寬度。**從尾巴砍**，不砍到一半的碼位（用 `for...of` 走
 * 字元而不是索引，所以代理對與組合字不會被切斷）。
 */
export function clampMarkText(str) {
  const flat = String(str ?? "")
    // 膠囊是單行：換行與控制字元一律移除（貼上多行文字時最容易發生）
    .replace(/[ -]/g, " ")
    .trim();
  let out = "", w = 0;
  for (const ch of flat) {
    const cw = textWidth(ch);
    if (w + cw > MARK_WIDTH) break;
    out += ch; w += cw;
  }
  return out;
}

/**
 * 把來源不明的標記陣列洗成可用的清單。存木檔、暫存、匯入三條路都要先過這裡。
 *
 * 跟 `cleanMeters` 同一組規則，多兩條：文字夾到 `MARK_WIDTH`（夾完是空的就丟掉那一
 * 筆），以及**排序之後**才取前 `MAX_MARKS` 筆 —— 留下的是曲子前面那 16 個，而不是
 * 檔案裡先出現的 16 個。
 */
export function cleanMarks(raw) {
  const ok = [];
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      if (!Number.isInteger(m.tick) || m.tick < 0) continue;
      const text = clampMarkText(m.text);
      if (!text) continue;
      ok.push({ tick: m.tick, text });
    }
  }
  ok.sort((a, b) => a.tick - b.tick);      // 穩定排序，所以同 tick 的相對順序不變
  const out = [];
  for (const m of ok) {
    if (out.length && out[out.length - 1].tick === m.tick) out[out.length - 1] = m;
    else out.push(m);
  }
  return out.slice(0, MAX_MARKS);
}

/**
 * 外面來的壓縮模式陣列 → 乾淨的一份。**認不得的值一律 null**（= 沒壓過）。
 *
 * 跟 `cleanMeters` / `cleanMarks` 同一組、同一個立場：暫存與存檔都可能是別的版本寫的，
 * 而「沒壓過」是唯一安全的預設 —— 猜錯成 `ZIP_LOSSLESS` 的話，使用者一份沒壓過的譜會在
 * 下一次編輯時被悄悄壓成看不懂的樣子。
 *
 * 長度補到 MAX_TRACKS，呼叫端就不必再處理短陣列。
 */
export function cleanZip(raw) {
  const out = Array(MAX_TRACKS).fill(null);
  if (Array.isArray(raw))
    for (let i = 0; i < MAX_TRACKS; i++)
      if (raw[i] === ZIP_LOSSLESS) out[i] = ZIP_LOSSLESS;
  return out;
}

/** 有沒有任何一軌在壓縮模式。存檔時用來決定要不要寫這個欄位（見 library.fromSnapshot）。 */
export const anyZip = list => Array.isArray(list) && list.some(z => z === ZIP_LOSSLESS);

/** 膠囊的寬度範圍與間隙（CSS px）。`PILL_MIN` 是「還按得到」的下限。 */
export const PILL_MIN = 14;
export const PILL_MAX = 150;
const PILL_GAP = 2;

/**
 * 膠囊的寬度：**夾成「到下一個標記的距離」**。格寬最小是 2px（`ZOOM_W[0]`），那時一
 * 個 4/4 小節只有 64px —— 一個 150px 的膠囊會把後面三四個整個蓋住，而膠囊是修改與移
 * 除**唯一**竹的入口。擠到連 `PILL_MIN` 都放不下時就停在 `PILL_MIN`，那時**後者蓋前
 * 者**，而總覽尺上的點還在。
 *
 * @param {number[]} xs 各標記的內容座標 x，**必須遞增**（`cleanMarks` 保證了）
 * @returns {number[]} 對應的最大寬度
 */
export function markPillWidths(xs) {
  return xs.map((x, i) => {
    const next = i + 1 < xs.length ? xs[i + 1] : Infinity;
    return Math.max(PILL_MIN, Math.min(PILL_MAX, next - x - PILL_GAP));
  });
}

/** 這個寬度只剩色塊（放不下任何字）。 */
export const isPillTab = w => w <= PILL_MIN;

/**
 * 原生水平捲軸**兩端各有一個角**（Windows 上的箭頭／端帽），實測約 10px —— 拇指真正
 * 走的軌道是 `[10, 寬-10]`。**量出來的、跟平台有關的數字，不是規格**（macOS 的
 * overlay scrollbar 是 0），而 CSS 沒有 API 問得到它。它只影響對齊的美觀。
 */
const SCROLLBAR_CAP = 10;

/**
 * 段落標記的色點在原生水平捲軸上的位置。兩個容易寫錯的地方，兩個都有測試釘住：
 *
 *   1. 比例算的是**整個可捲寬度**（含左側鍵盤那 46px —— `#rollpad` 是
 *      `GUTTER_W + 內容寬`）。少加那一段色點會整批往左偏。
 *   2. **兩端的端帽要扣掉**（見 `SCROLLBAR_CAP`），可用軌道還要再扣一個色點的寬 ——
 *      不扣的話曲末那個色點會壓在右邊的端帽上。
 *
 * @param {number} contentX 這個標記的內容座標（`roll.viewX(tick)`）
 * @param {number} scrollW  整個可捲寬度
 * @param {number} track    十軌道寬（≈ `#stage` 的 clientWidth）
 * @returns {number} 色點左緣的 px；`scrollW` 還沒量到時回 0
 */
export function markDotX(contentX, scrollW, track) {
  if (!(scrollW > 0) || !(track > 0)) return 0;
  const usable = Math.max(1, track - SCROLLBAR_CAP * 2 - DOT_W);
  // 比例夾在 0..1，這樣這個函式對任何輸入都給得出畫得下的答案，呼叫端不必自己防。
  const r = Math.min(1, Math.max(0, (GUTTER_W + contentX) / scrollW));
  // **上界要先夾成非負**。寫成 `Math.min(track - DOT_W, ...)` 的話，視窗被拉到
  // 比色點還窄時（track < DOT_W）那個上界是負的，於是回一個負的 left。
  const hi = Math.max(0, track - DOT_W);
  return Math.min(hi, Math.max(0, SCROLLBAR_CAP + r * usable));
}

/** 色點的寬（跟 CSS 的 `#markdots .dot` 一致）。 */
export const DOT_W = 8;

// ─── 調號 ───────────────────────────────────────────────────────────────────

/** 大調音階的級數（半音）。小調用不到 —— 理由見 KEY_SIGS。 */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

/**
 * 12 個調號，順序照五度圈。**關係小調只是標籤**：C 大調與 A 小調的音級完全相同，而
 * 「哪幾列變暗」只看音級 —— 這 12 項本質上就是**12 組音高集合**。root 是主音的音級。
 *
 * **標籤搬到語言檔了**（key 是 `keysig.<index>`，用 i18n.keySigLabel(i) 取）。留在這
 * 裡的 root 讓 config.js 人保持零 i18n 依賴，test/roll.test.mjs 才還能直接 import 它。
 */
export const KEY_SIGS = [
  { root: 0  },
  { root: 7  },
  { root: 2  },
  { root: 9  },
  { root: 4  },
  { root: 11 },
  // 6♯ 與 6♭ 是同一組音級（同音異名），一項就夠
  { root: 6  },
  { root: 5  },
  { root: 10 },
  { root: 3  },
  { root: 8  },
  { root: 1  },
];

/**
 * 某個調用到哪些音級（0–11 的 Set）。用主音算而不是手寫 84 個數字 —— 手打一定會錯
 * 一個，而錯了的表現是「某一列的顏色不對」，沒有人會發現。
 */
export const keyPitches = root =>
  new Set(MAJOR_STEPS.map(s => (root + s) % 12));

// ─── 預設樂譜 ───────────────────────────────────────────────────────────────

/**
 * 一個分頁一軌。開站看到的就是這首 —— 兩軌、113 BPM、約 3 分 11 秒。刻意放一首真的
 * 曲子而不是四小節的示範：捲軸、導播線、跟隨換頁、部份播放在四小節的譜上看不出差別。
 * 第三軌留空 —— MIN_TRACKS 是 3。t 只寫在第一軌，速度是整首歌共用竹的。
 */
export const DEMO = [
`t113v15b8>d+8f+8fc-g+f+fc+.l8c-d+f+f4d+c-g+1&g+b>d+f+f4.c-g+4f+4f16f+16fc+<g+f+c-d+f+f4d+c+g+2&g+t113a+g+f+d+d+2a+g+f+>c+c+2<g+f+ff+>c+2<ff+g+f+a+2a+g+f+d+d+2a+g+f+>c+c+2<g+f+ff+>c+2d+2c+32d+32f4.r16<<a+g+f+d+d+2a+g+f+>c+c+2<g+f+ff+g+2a+4.d+f4f+4a+g+f+d+d+2a+g+f+>c+c+2<g+f+ff+>c+2d+2c+32d+32f4r.f+2d+4>d+4d+<d+d+>d+2d+4<f>fc+c+4.<g+4f+g+a+2&a+r2d+4>d+4d+<d+d+l4>d+d+d+fc+2<g+.f+8a+l8f+g+ff+fd+c+c+16d+.l4f+n75d+8>d+d+d+fc+2<g+.l8f+a+2>f+fd+c+<a+f+4>d+4d+<d+d+l4>d+d+d+fc+2<g+2l8&g+f+32g+32a+16f+fd+<a+g+f+fd+4.d+a+g+f+>c+c+2<g+f+ff+>c+2<ff+g+f+a+2a+g+f+d+d+2a+g+f+>c+c+2<g+f+ff+l2>c+d+ff+l8n75f+>c+4<a+4g+4g+32a+16.d+f+fd+c+d+c+g+n56f+n56fd+c+<g+a+f+fd+ff+a+>c+n75d+n73d+a+4f+.a+16g+4f+c+fc+d+fc+n56c+d+fg+>c+d+f<g+d+>g+l2g<<d+d+ff+ffffd+d+ff+g+g+g+l8a+g+f+d+d+2a+g+f+>c+c+2<g+f+ff+>c+2<ff+g+f+a+4a+4a+g+f+d+d+2a+g+f+n61f2g+f+ff+l4ffc+d+ff+l8a+g+f+d+d+2ra+g+f+>c+2<g+f+ff+>c+2<ff+g+f+>d+d+a+4<a+g+f+d+d+2a+g+f+>c+c+2<g+f+ff+>c+2d+2l4ff+a+2rd+d+.d+fc+.c-8c+8rd+d+.d+ff+g+.r>d+d+.d+ff.c-8c+8r<d+d+.d+ff+g+.g2.&g16r8.g2a+2`,
`v13l1<b&bb&bl8c-f+b>c+d+g+1&g+4.<c-f+b>c+d+f+2.&f+r2<c-f+b>c+d+2<c+g+>c+d+f2<<a+>fa+>c+f2<d+a+>d+ff+2<c-f+b>c+d+2<c+g+>c+d+f2<<a+>fa+>c+4f4.<d+a+>d+f2&f<<c-f+>d+a+2&a+<c+g+>ff+2&f+<<a+>fa+>c+4<f<a+4>d+a+>d+ff+a+4.<c-f+b>d+a+2<c+g+>c+d+f+2n34fa+>c+fc+g+4<<d+a+>d+ff+a+f+f<c-4>f+b>c+d+4.<<c+g+>c+d+f2n34fa+>c+f2<d+a+>d+ff+fd+c+<c-f+b>d+f+d+4.<c+g+>c+4fg+f4<<a+>fa+>c+fg+4.<c-a+n51a+n51a+c+4c-f+b>d+f+d+4.<c+g+>c+d+fg+f4<<a+>fa+4>c+fc+4<d+a+n51a+n51a+4.c-f+bf+b>c+4.<<a+>g+>c+fg+4f4<<a+>fa+4>c+fc+4<d+a+>d+2.<c-f+b4f+2c+g+n49g+2&g+n34fa+n49f2<d+a+>d+ff+2c-f+a+4f+2c+g+n49g+2&g+n34fa+>c+ff+g+a+<d+a+>d+ff+a+f+f<c-f+b>d+f+d+g+4<c+g+>c+fg+f4.<<a+>fa+>c+c+2<<d+a+>d+ff+4f4c-f+b>d+f+d+4.<c+g+>c+4f4c+4<<a+>fa+>c+fa+f4<d+a+r2.c-f+bf+4f+bf+4f+b4.f+b4c-g+n49g+4g+n49g+4g+n49g+4g+n49g+c-f+bf+4f+bf+4f+bf+4f+bf+c-g+n49g+4g+n49g+4c-n49g+2&g+<d+b>d+bn27d+4.<f>c+g+n49c+g+4.n34fa+n49l4fn34f+g+f2l8<c-f+>f+g+<f+2c-g+c-l4g+.c-a+g+f+fl8d+a+>d+4ff+f4<d+b>d+4c-d+<b4f>c+fc+fc+f4n34fn34fn34fc+4<d+a+n39a+c+a+>c+4<c-f+>d+4n30d+4.<c+g+>fn32fn32f4<<a+>a+>f<a+>>c+fa+f<<d+a+>d+f+a+2c-f+bf+bf+b4c-g+n49g+n49g+4.c-f+bf+bf+b4c-g+n49g+n49g+>c+4<c-f+bf+bf+b4c-g+n49g+n49g+>c+r<c-f+bf+bf+b4c-g+n49g+n49g+n49g+<d+l16a+>d+fga+>d+fga+>d+fga+>d+fga+d+a+4o2d+2`,
  "",
];
