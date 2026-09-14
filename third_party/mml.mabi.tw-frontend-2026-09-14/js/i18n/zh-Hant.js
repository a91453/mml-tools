// ────────────────────────────────────────────────────────────────────────────
//  繁體中文（原文）
//
//  **基準**：其他語言都從它翻過來，缺 key 時也退回這裡。新增文字一律先寫進這裡再補其他
//  三份 —— test/i18n.test.mjs 會擋住忘記補的情形。
//
//  規則（見 i18n.js 開頭）：
//    · 純資料，不准有函式或模板字串
//    · 位置符寫成 {name}，複數寫成 { one, other }，選形只看 n
//    · 夾在字串裡的 HTML 是刻意的（say() 吃 HTML），但只准出現 <b> <code> <br>
// ────────────────────────────────────────────────────────────────────────────

export default {
  "roll.note.dotAdd":           "加上附點",
  "roll.note.dotRemove":        "取消附點",
  "roll.note.dotHint":          "{n} 個音 · 長度 ×1.5",
  "roll.note.dotBad":           "有音符無法加附點",
  "roll.note.dotBlockedLen":    "只有全／2分／4分／8分／16分／32分音符可以加附點（64 分不行）。第 {bar} 小節的 {note} 不行",
  "roll.note.dotBlockedMore":   "（另有 {n} 個音不合）",
  "roll.note.dotBlockedKill":   "加了附點會蓋掉第 {bar} 小節的 {note}。改用滑鼠拖音符的右邊框，那裡看得到會刪掉幾個音",
  "roll.note.dotDone":          "{n} 個音加上附點",
  "roll.note.dotUndone":        "{n} 個音取消附點",
  "roll.len.n1":     "全音符",
  "roll.len.n2":     "二分音符",
  "roll.len.n4":     "四分音符",
  "roll.len.n8":     "八分音符",
  "roll.len.n16":    "十六分音符",
  "roll.len.n32":    "三十二分音符",
  "roll.len.n64":    "六十四分音符",
  "roll.len.dotted": "附點{name}",
  "roll.len.idle":   "只選取模式，不會畫音符",
  "roll.len.toggle":    "加上／取消附點（長度 ×1.5）· .",
  "roll.len.noDot64":   "六十四分音符不支援附點",
  "roll.duplicate.overwritten": "覆蓋了 {n} 個既有音符，可用復原還原。",
  "compress.err.budgetExhausted": "壓縮搜尋額度已用盡，已保留原文。",
  "compat.preserved": "仍有不支援的時值，已保留原文，未調整任何時值；可繼續輸出，但瑪奇 Mobile 可能無法使用。",
  "clip.nonstd": "這份譜有 <b>{n} 個非標準時值</b>（瑪奇 PC／MabiIcco 的寫法），<b>瑪奇 Mobile 不吃</b>。原文完整保留了；要換成標準時值按工具列的「還原」。",
  "clip.compressed": "複製時已自動<b>無損壓縮 {n} 字</b>（音樂完全相同）。壓縮只影響送出去的那一份 —— 已經在壓縮模式的軌本來就是壓好的。",
  "fileBox.warn.nonstd": "有 {tracks} 軌共 <b>{n} 個非標準時值</b>（瑪奇 PC／MabiIcco 的寫法），<b>瑪奇 Mobile 不吃</b>。匯入時原文完整保留，之後可用工具列的「還原」換成標準時值。",
  "fileBox.tag.nonstd": "非標準 {n}",
  "fileBox.tag.nonstdTitle": "這一軌有非標準時值，瑪奇 Mobile 不吃。匯入後可用工具列的「還原」換成標準時值 —— 還原會讓字數變多，所以這一列的字數之後還會動。",
  "ui.nonstd.warn": "這一軌有 {n} 個非標準時值",
  "ui.nonstd.fixBtn": "還原",
  "ui.nonstd.fixHint": "用遊戲的尺重讀這一軌，換成標準時值寫回去。字數會變多。",
  "ui.nonstd.zipHint": "壓縮模式需要標準時值，按「還原」之後會自動恢復壓縮。",
  "ui.nonstd.done": "已還原 {n} 個非標準時值。不滿意按 Ctrl+Z。",
  "ui.nonstd.nothing": "這一軌的非標準時值還原不掉 —— 用標準寫法湊不出那些長度。原文保留，不動時值。",
  "compress.note.budgetExhausted": "第 {n} 軌的壓縮搜尋額度已用盡，結果可能仍有縮短空間。",

  // ─── 列舉分隔符 ───────────────────────────────────────────────────────────
  // 為什麼不月用 Intl.ListFormat：理由寫在 i18n.js 的 list() 上面。
  "list.item":   "、",
  "list.clause": "；",

  // 「已暫存 · 14:32」，中間的 · 是分隔符，英文照用。
  // 這一條沒有漢字，gen.py 抽不到（掃描只看漢字與全形標點）—— 手寫。
  "ui.store.at": "{verb} · {time}",

  // ─── 軌名 ─────────────────────────────────────────────────────────────────
  // 前 6 個是**遊戲自己的軌名**：要跟各語言版瑪奇的官方軌名，不能自己意譯。
  // 後 9 個是本站的輔助軌，可以意譯。
  "track.name.0":  "主旋律",
  "track.name.1":  "和弦1",
  "track.name.2":  "和弦2",
  "track.name.3":  "和弦3",
  "track.name.4":  "和弦4",
  "track.name.5":  "和弦5",
  "track.name.6":  "輔助1",
  "track.name.7":  "輔助2",
  "track.name.8":  "輔助3",
  "track.name.9":  "輔助4",
  "track.name.10": "輔助5",
  "track.name.11": "輔助6",
  "track.name.12": "輔助7",
  "track.name.13": "輔助8",
  "track.name.14": "輔助9",

  /** 第 n 軌 —— 軌號超出 TRACK_NAMES 或還不知道軌名時的通稱。 */
  "track.nth": "第 {n} 軌",


  // ─── 調號 ─────────────────────────────────────────────────────────────────
  // 順序照五度圈，對齊 config.js 的 KEY_SIGS。大調／小調各語言都有標準譯法；
  // **ja/ko 的音弓名體系跟中英不同**（イロハ、다라마），不是照字面翻。
  "keysig.0":  "C 大調 / A 小調",
  "keysig.1":  "G 大調 / E 小調",
  "keysig.2":  "D 大調 / B 小調",
  "keysig.3":  "A 大調 / F♯ 小調",
  "keysig.4":  "E 大調 / C♯ 小調",
  "keysig.5":  "B 大調 / G♯ 小調",
  // 6♯ 與 6♭ 是同一組音級（同音異名），標籤兩種寫法都列出來
  "keysig.6":  "F♯（G♭）大調 / D♯（E♭）小調",
  "keysig.7":  "F 大調 / D 小調",
  "keysig.8":  "B♭ 大調 / G 小調",
  "keysig.9":  "E♭ 大調 / C 小調",
  "keysig.10": "A♭ 大調 / F 小調",
  "keysig.11": "D♭ 大調 / B♭ 小調",

  // ─── 解析器警告（mml.js）───────────────────────────────────────────────────
  // {track} 是軌名，由 i18n.trackName() 填。全形冒號在中文裡是對的，英文要換成 ": "。
  "mml.warn.comma":        "{track} 裡有逗號，要分軌請用「貼上」",
  "mml.warn.pitchFolded":  "{track}：有音高超出捲軸的 {lo}–{hi}，已折八度塞進來",
  "mml.warn.nNoNumber":    "{track}：n 後面沒有數字",
  // {char} 是那個看不懂的字元本身，引號是中文的彎引號，翻譯時要換成該語言的引號
  "mml.warn.badChar":      "{track}：看不懂的字元 “{char}”",

  // ─── 引擎啟動（engine.js）─────────────────────────────────────────────────
  // 這四句會出現在標題列的 #engine 那一格，人位置很窄，英文要簡短
  "engine.step.lib":     "載入函式庫",
  "engine.step.ctx":     "建立 AudioContext",
  "engine.step.worklet": "載入合成器 processor",
  "engine.ready":        "引擎就緒 · {hz} Hz",

  // 給「站起不來」的人看的，偏技術。<code> 裡的路徑與指令不要翻。
  "error.hint.worklet": "worklet 模組載不進來。確認是用 <code>dotnet run</code> 起的站（<code>file://</code> 一定失敗），而且 <code>wwwroot/vendor/</code> 與 <code>wwwroot/worklet-boot.js</code> 都在。",
  "error.hint.lib":     "import map 指的路徑不對，確認 <code>vendor/</code> 三個檔案都在。",
  "error.hint.ctx":     "瀏覽器不給開 AudioContext，通常是頁面還沒被點過。",
  "error.hint.generic": "完整堆疊在 devtools console。若是音色庫本身的問題，先確認它真的是 DLS/SF2。",

  // ─── 帳號（account.js）───────────────────────────────────────────────────
  // {who} 是「（名字）」或空字串，**前後不加空白** —— 英文要自己把空白寫進句型裡
  // （例如 "your account{who} and "）。
  "account.delete.confirmWithShares": "會刪掉你的帳號{who}與名下 {n} 筆分享。",
  "account.delete.confirmNoShares":   "會刪掉你的帳號{who}。你目前沒有分享過任何樂譜。",
  "account.delete.confirmWithSaves":  "會刪掉你的帳號{who}與名下 {n} 份 web 存檔。",
  "account.delete.andSaves":          "名下 {n} 份 web 存檔也會一起刪掉。",
  "account.delete.failedHttp":        "刪除失敗（HTTP {status}）。",
  "account.delete.offline":           "連不上伺服器，帳號沒有刪除。",
  "account.signedIn":                 "已登入",
  "account.signedOut":                "未登入",
  // 卜這兩句**只給「登入過但剛剛失效」的人**（見 account.wasExpired）。主詞是「登入」（它
  // 過期了）不是「你」—— 對這個人講「你沒登入」是錯的，他登了。
  "account.expired":                  "你的登入已經過期，請重新登入。你正在編輯的樂譜不會受到影響。",
  "account.expiredWhy":               "你的登入已經過期了。這通常是隔了太久沒回來，重新登入一次就好 —— 編輯器裡的東西都還在。",
  // 只有架站的人會看到（沒填 appsettings），但它是 title 提示，還是會被翻到
  "account.googleNotConfigured":      "伺服器還沒設定 Google 登入（appsettings 的 Google:ClientId）",
  "account.offline":                  "離線中，無法登入 —— 登入需要連上 Google",
  "account.offlineWhy":               "離線中，現在沒辦法登入 —— 登入要連上 Google。連上網路之後這裡就會恢復。",

  // ─── MIDI／MML 匯入（mml-in.js）──────────────────────────────────────────
  "mmlIn.noChannel":       "這個檔案裡沒有找到任何有內容的 Channel",
  "mmlIn.timeSigUnreadable":  "這個檔的變拍位置讀不出來，小節線先照曲首拍號畫",
  "mmlIn.partOf":          "{name} · 聲部 {n}",
  "mmlIn.part":            "聲部 {n}",
  "mmlIn.noMmlTrack":      "這個檔案裡沒有找到任何有內容的 mml-track",
  "mmlIn.emptyMmlAt":      "這個檔案裡的 MML@ 沒有任何內容",
  "mmlIn.multipleMmlAt":   "這個檔案裡有 {n} 段 MML@，只會匯入第一段",

  // ─── 進入點（main.js）────────────────────────────────────────────────────
  "main.waterfallOffline":     "目前離線，做不了影片。連上網路之後再從分享清單按一次「製作影片」。",
  "main.needHttp":     "需要 http server",
  "main.unavailable":  "無法使用",
  "main.engineFailed": "引擎載入失敗",
  "main.engineDown":   "引擎起不來",
  // <code> 裡竹的 file:// 不要翻，inline style 要原封不動搬過去。
  "main.fileProtocol":
    "這頁不能用 <code>file://</code> 或預覽窗開。<br><span style=\"color:var(--dim)\">\n" +
    "       在專案資料夾裡跑 <code>dotnet run</code>，開它印出來的網址。\n" +
    "       AudioWorklet 需要真正的 origin，而且頁面是 Razor 渲染的，一定要走 server。</span>",

  // ─── 分享（share.js）────────────────────────────────────────────────────
  // 「第 n 軌<錯誤>」用共用的 track.withError
  "share.blocked":       "{list}。遊戲的空白樂譜吃不下這些寫法，改掉之後才能分享。",
  "share.verifyFailed":  "壓縮驗證沒過，這是 bug，沒有送出。請把這首譜回報給我。",
  "share.truncated":     "第 {n} 軌壓完還有 {chars} 字，超過遊戲的 {max} 上限，已截掉尾端 {cut} 字",

  // ─── 樂器清單（instruments.js）───────────────────────────────────────────
  "instruments.filteredByDef": "依 .def 篩出 {n} 個",
  "instruments.droppedUnused": "濾掉 {n} 個未使用",

  // ─── 共用短詞與軌號 ───────────────────────────────────────────────────────
  // track.withError：{error} 十直接黏後面（中文不需要空白）。
  // common.close 是「把這個框收起來」= Close；設定抽屜裡自動存檔的「關閉」是 Off，在
  // .resx 那邊另一個 key —— **中文同字，英文不同字**。
  "track.withError":  "第 {n} 軌{error}",
  "common.cancel":    "取消",
  "common.close":     "關閉",

  // ─── 壓縮器（mml-compress.js） ────────────────────────────────────────────
  // 這些 err 會被接在「第 n 軌」後面當**片段**，要能接在軌號後面讀得通，不要自己補主詞。
  "compress.err.doubleDotFailed":    "有雙附點但改寫不了（{reason}）",
  "compress.err.uncodable":          "有無法編碼的時值或音高",
  "compress.err.uncodableAfterOpt":  "優化後有無法編碼的時值",
  "compress.note.keptTrack":         "第 {n} 軌保留原樣：{reason}",
  "compress.note.verifyFailed":      "驗證沒過，已退回原字串。這是 bug，請回報這首譜。",
  "compress.note.noVerify":          "沒有傳 verifyWith，未驗證。正式使用請傳入 parseAll。",
  "compress.note.alreadyTight":      "整首都壓不動，原本就很緊湊。",

  // ─── 音軌分頁（tracks.js） ────────────────────────────────────────────────
  // confirmRemove 竹的換行是真的換行（confirm 分兩行），要保留。
  // tabTitle 的 {muted} 是 mutedSuffix 或空字串；它後面那個是**全形空白**，不是兩個半形
  // —— 英文要改成一般空白或分隔符。
  "tracks.removeTitle":      "移除這一軌",
  "tracks.instrumentLabel":  "樂器",
  "tracks.loadBankFirst":    "先載入音色庫",
  "tracks.bankEmpty":        "音色庫是空的",
  "tracks.muteAria":         "靜音 {track}",
  "tracks.addTab":           "＋ 新增",
  "tracks.confirmRemove":    "{track} 還有內容，確定移除？\n後面的軌會往前移一格。",
  "tracks.mutedSuffix":      "（已靜音）",
  "tracks.tabTitle":         "{track}{muted}　拖曳分頁可以改變音軌順序",
  "tracks.muteOnHint":       "{track} 已靜音：試聽時不出聲。匯出、另存與分享不受影響。",
  "tracks.muteOffHint":      "把 {track} 靜音：只影響試聽，匯出、另存與分享照舊完整。",
  // 單聽／顯示／單看，跟靜音同一類。ghost 的方向跟 muted **相反**：ghostOnHint 日是「按下
  // 去會顯示」。
  "tracks.soloPlayAria":     "只聽 {track}",
  "tracks.soloPlayOnHint":   "目前只聽 {track}。再按一下解除全部靜音。",
  "tracks.soloPlayOffHint":  "只聽 {track}：其他軌全部靜音。只影響試聽。",
  "tracks.ghostHint":        "點圓點可以把這一軌從鋼琴捲軸上收掉",
  "tracks.ghostAria":        "在捲軸上顯示 {track}",
  "tracks.ghostOnHint":      "把 {track} 畫回捲軸上。",
  "tracks.ghostOffHint":     "把 {track} 從捲軸上收掉：只影響畫面，它照樣出聲、照樣編得動。",
  "tracks.soloAria":         "只看 {track}",
  "tracks.soloOnHint":       "目前只看 {track}。再按一下全部顯示。",
  "tracks.soloOffHint":      "只看 {track}：其他軌從捲軸上收掉。",
  "tracks.counter":          "{notes} 音 · {len}/{max} 字",
  "tracks.counterHint":      "匯出後的字數，空白與換行不計",
  "tracks.zipLossless":      "壓縮模式：這一軌的編輯會自動再無損壓縮一次",
  "tracks.overLimit":        "超過遊戲上限 {n} 字，這一軌貼不進空白樂譜。空白與換行不計。",

  // ─── 鋼琴捲軸（pianoroll.js） ─────────────────────────────────────────────
  // fineResize／fineMove／pausedSuffix 是接在狀態列後面的**片段**，開頭的 " · " 要留著。
  "roll.markStartAfterEnd":     "部份播放開始無法設置在結束之前",
  "roll.markEndBeforeStart":    "部份播放結束無法設置在開始之前",
  // 工具列那兩個 stepper 的 title。快捷鍵寫進字串裡 —— 這是另外兩個縮放入口唯一被說出來
  // 竹的地方。
  "roll.zoom.wIn":              "格寬放大（橫向看得更細）· Ctrl+滾輪",
  "roll.zoom.wOut":             "格寬縮小（橫向看得更多）· Ctrl+滾輪",
  "roll.zoom.hIn":              "列高放大（音高看得更清楚）· Ctrl+Shift 或 Alt+滾輪",
  "roll.zoom.hOut":             "列高縮小（一次看得到更多八度）· Ctrl+Shift 或 Alt+滾輪",
  "roll.fineResize":            " · ←→微調長度",
  "roll.fineMove":              " · ↑↓←→微調",
  "roll.willDelete":            "會刪掉 {n} 個音",
  "roll.willTrim":              "會截短 {n} 個音",
  "roll.mode.playing":          "演奏中",
  "roll.mode.paused":           "暫停中",
  "roll.mode.editing":          "編輯中",
  "roll.hint.playingReadonly":  "播放中兩邊唯讀 · 尺上左／右鍵可即時挪動播放範圍",
  "roll.hint.edit":             "左鍵畫 · 拖曳搬動 · 拖右邊框改長度 · 右鍵開選單",
  "roll.hint.editNoDraw":       "拖曳搬動 · 拖右邊框改長度 · 右鍵開選單",
  "roll.hint.pausedSuffix":     " · 改動按繼續後生效",

  // ─── 剪貼簿（clipboard.js） ───────────────────────────────────────────────────
  // 夸軌的 {list} 由 i18n.list()／clause() 接好才送卜進來。
  "clip.noMml":            "剪貼簿裡沒有看起來像 MML 的東西。",
  "clip.empty":            "剪貼簿是空的。",
  "clip.title.in":         "貼上 MML",
  "clip.title.out":        "複製 MML",
  "clip.manualIn":         "這個瀏覽器不讓網頁直接讀剪貼簿。在下面按 Ctrl+V，然後按載入。",
  "clip.manualOut":        "這個瀏覽器不讓網頁直接寫剪貼簿。內容已經選起來了，按 Ctrl+C 帶走。",
  "clip.tooManyTracks":    "有 {n} 軌，只吃前 {max} 軌",
  "clip.overLimitTracks":  "{n} 軌超過遊戲的 {max} 字上限，內容留著，但那幾軌貼不回遊戲",
  "clip.pastedNotes":      "貼上的 MML {list}。",
  "clip.blocked":          "沒有複製：{list}。遊戲的空白樂譜吃不下這些寫法。",
  "clip.durSnapped":       "第 {list} 軌有遊戲不吃的非標準時值，已改成最接近的合法長度（位移 {drift} tick，音符位置有動）。",
  "clip.doubleDotFixed":   "第 {list} 軌的雙附點已改寫成等長的合法寫法（遊戲不吃 <code>..</code>）。",
  "clip.droppedTracks":    "<b>{list}</b> 沒有複製進去（遊戲的空白樂譜只吃前 {max} 軌）。",
  "clip.copied":           "已複製 {tracks} 軌 · {chars} 字元到剪貼簿。{note}",

  // ─── MIDI 匯入（midi-in.js） ──────────────────────────────────────────────
  // mode.all／mode.smart 是**本站自創的詞**，詞彙表要先定，而且得是名詞組（填進
  // nothingPicked／fewerLanes 的 {mode}）。someTrack 是沒名字時的代用主詞，填 {track}。
  // up／down 填進 octaveShift 的 {dir}：**英文拆不開**（shifted up / down），整句重寫、把
  // {dir} 當一整個詞組。multiProgram 開頭的空白與 ▸ 日是分隔符，要留著。
  "midiIn.err.notMidi":         "這不是一個 MIDI 檔（找不到 MThd 檔頭）。",
  "midiIn.err.smpte":           "這個檔用 SMPTE 時間碼（影片同步用），沒有節拍資訊，無法轉成 MML。",
  "midiIn.warn.truncated":      "有音軌讀到一半就結束了，那幾軌只採到中斷的地方",
  "midiIn.warn.tempoClamped":   "有速度超出遊戲的 t32–t255，已夾到範圍內",
  "midiIn.multiProgram":        " ▸ {n} 種音色",
  "midiIn.mode.all":            "和弦全採",
  "midiIn.mode.smart":          "智能分弦",
  "midiIn.someTrack":           "有一軌",
  "midiIn.up":                  "升",
  "midiIn.down":                "降",
  "midiIn.warn.nothingPicked":  "{track} 的{mode}採不出任何東西",
  "midiIn.warn.chordOnly":      "{track} 判定為純和弦伴奏（最高聲部只有 {pct}% 的音有自己的節奏），不留旋律軌",
  "midiIn.warn.lostNotes":      "{track} 有 {n} 個音沒有採進來（同時發聲的音超過軌數）",
  "midiIn.warn.fewerLanes":     "{track} 的{mode}採出 {n} 軌（這個聲部就只有這麼多條線）",
  "midiIn.warn.monoSame":       "{track} 是單音的，根音那一軌會跟旋律完全重複，所以只採出一軌",
  "midiIn.warn.manyTempos":     "這個檔有 {n} 次速度變化，只採用開頭的 t{bpm}",
  "midiIn.warn.tempoMismatch":  "這個檔的速度是 t{theirs}，現有的譜是 t{ours}，追加進來的軌會照現有的速度播放",
  "midiIn.warn.octaveShift":    "{track} 整組{dir}了 {n} 個八度",
  "midiIn.warn.outOfRange":     "{track} 有 {n} 個音超出 {lo}–{hi}，已夾到範圍內",
  "midiIn.warn.tooLong":        "第 {list} 軌有音超過 MML 寫得出的最長時值（{bars} 小節），已截短並補上等長的休止符",
  "midiIn.warn.writeFailed":    "第 {list} 軌寫不成 MML（時值或音高超出範圍），那幾軌是空的",
  "midiIn.warn.overLimit":      "第 {list} 軌超過遊戲的 {max} 字上限，那幾軌貼不進空白樂譜",
  "midiIn.moreWarnings":        "…等 {n} 項",

  // ─── 五線譜匯入（musicxml-in.js） ─────────────────────────────────────────
  // 人使用者手上只有一張圖和一段 MML，中間丟掉了什麼**完全不可見** —— 所以每一種資料損失都
  // 有自己的一條話，不合併成「有些東西被略過」。
  "musicxmlIn.err.empty":         "沒有可以匯入的內容",
  "musicxmlIn.err.notMusicXml":   "這不是 MusicXML 檔（根元素不是 score-partwise）",
  "musicxmlIn.err.timewise":      "這是 score-timewise 排法的 MusicXML，目前只支援 score-partwise",
  "musicxmlIn.err.noNotes":       "辨識結果裡沒有任何音符",
  "musicxmlIn.warn.badMeasures":   "有 {n}／{of} 個小節的音符加起來不等於一整個小節（辨識把時值讀錯了），那幾處的節奏會頓一下",
  "musicxmlIn.warn.noTempo":      "辨識不出速度記號，用的是預設速度 —— 譜上印的速度請自己填",
  "musicxmlIn.warn.tiesMerged":   "有 {n} 條連結線併成了長音",
  "musicxmlIn.warn.tuplets":      "有 {n} 個連音的時值對不上 60 tick 的格線，位置會歪掉",
  "musicxmlIn.warn.graces":       "有 {n} 個裝飾音被略過（它們沒有時值，留著會讓後面的音全部錯位）",
  "musicxmlIn.warn.slurs":        "有 {n} 條圓滑線被略過（那是句法記號，不是時值）",
  "musicxmlIn.warn.repeats":      "有 {n} 個反覆記號沒有展開，只會播一遍",
  "musicxmlIn.warn.repeatGuessedStart": "有 {n} 個反覆記號只認到結束記號，起點是照慣例推出來的（曲子開頭，或上一個反覆之後）—— 請對一下小節數",
  "musicxmlIn.warn.unclosed":     "有 {n} 條線沒有收尾（跨頁的連結線會這樣），那幾個音沒有接起來",
  "musicxmlIn.warn.pitchless":    "有 {n} 個音符讀不出音高，已略過",
  "musicxmlIn.moreWarnings":      "…等 {n} 項",

  // ─── 分享框（sharebox.js） ────────────────────────────────────────────────
  // alreadyTight／saved 竹的「壓縮」後面是**兩個半形空白**（對齊用），不是一個。
  // delWhat 裡面兩個分隔是**全形空白**。
  // op.* 是表格裡的操作鈕，位置很窄，英文要短（Load / Copy / Delete）；完整說明在 *Title。
  "shareBox.needLogin":         "分享需要登入",
  "shareBox.emptyScore":        "樂譜是空的，沒有東西可以分享",
  "shareBox.offlineWhy":        "離線中，產生不了連結 —— 剪貼簿與檔案匯出照樣可以用",
  "shareBox.droppedTracks":     "<b>{list}</b> 有內容，但不會被分享 —— 遊戲的空白樂譜只吃前 {max} 軌。要分享它們就先拖到前面。",
  "shareBox.postFailed":        "分享沒有成功（HTTP {status}）。",
  "shareBox.postOffline":       "連不上伺服器，分享沒有成功。",
  "shareBox.reused":            "這份內容你之前分享過，給你同一條連結。",
  "shareBox.alreadyTight":      "壓縮  {before} → {after} 字元 · 已經是最省的寫法",
  "shareBox.saved":             "壓縮  {before} → {after} 字元 · 省 {saved} 字（{pct}%）",
  "shareBox.durSnapped":        "第 {list} 軌的非標準時值已改成最接近的合法長度，音符位置動了 {drift} tick",
  "shareBox.doubleDotFixed":    "第 {list} 軌的雙附點已改寫成等長的合法寫法（遊戲不吃 ..）",
  "shareBox.copied":            "已複製",
  "shareBox.listFailed":        "讀不到分享紀錄（HTTP {status}）。",
  "shareBox.listOffline":       "連不上伺服器，讀不到分享紀錄。",
  "shareBox.listEmpty":         "還沒有分享過任何樂譜。",
  "shareBox.total":             "共 {n} 筆",
  "shareBox.cell.sum":          "{tracks} 軌 · {chars} 字",
  "shareBox.op.load":           "載入",
  "shareBox.op.loadTitle":      "把這一份載入到現在的編輯器（可以 Ctrl+Z 復原）",
  "shareBox.op.copyLink":       "複製連結",
  "shareBox.op.copyLinkTitle":  "把這一筆的網址複製到剪貼簿",
  "shareBox.op.video":          "製作影片",
  "shareBox.op.videoTitle":     "用這一份做一支鋼琴瀑布影片（開新分頁）",
  "shareBox.op.delete":         "刪除",
  "shareBox.op.deleteTitle":    "刪掉這一筆分享，連結會立刻失效",
  "shareBox.linkNotFound":      "這個分享連結不存在，可能是打錯了或已經被移除。編輯器照常可以用。",
  "shareBox.offlineLink":       "離線中，這個分享連結要連上網才打得開。這份是你自己的編輯器，那份譜沒有不見。",
  // 卜這個分頁先前已經載入過這一份分享（見 sharebox.boot）。畫面上留著的是他自己的東西，所
  // 以要先講「為什麼你沒看到那份譜」，再給回去的路。
  "shareBox.alreadyAdopted":    "這個分享連結先前已經載入過，所以畫面上留著你自己的編輯。要重看分享的那一份，開分享框按「載入」。",
  "shareBox.loadFailed":        "載入失敗（HTTP {status}）。",
  "shareBox.emptyShare":        "這一筆分享沒有內容。",
  "shareBox.loadedReplaced":    "已載入 {id}… 的樂譜，取代了你原本的內容。<b>Ctrl+Z</b> 可以回到原本那份。",
  "shareBox.loaded":            "已載入 {id}… 的樂譜。",
  "shareBox.loadOffline":       "連不上伺服器，沒有載入。",
  "shareBox.delWhat":           "{id}…　{tracks} 軌 · {chars} 字　{when}",
  "shareBox.delFailed":         "刪除失敗（HTTP {status}）。",
  "shareBox.delOffline":        "連不上伺服器，沒有刪除。",

  // ─── 檔案框（filebox.js） ─────────────────────────────────────────────────
  // mode.voices／mode.all 就日是 midiIn 那兩個自創詞（多帶了軌數），兩邊要一致。
  // tag.* 是清單上的小標籤，位置極窄，英文要簡短；完整說明在 *Title。
  // beyondGame 開頭的「。」是接在 appended／imported 後面的連接，要留著（英文改成 ". "）。
  // capLeft／capTotal 填進 picked／pickedOver 的 {cap}。
  "fileBox.mode.melody":         "旋律重視",
  "fileBox.mode.root":           "根音重視",
  "fileBox.mode.both":           "旋律 + 根音（2 軌）",
  "fileBox.mode.voices":         "智能分弦（{n} 軌）",
  "fileBox.mode.all":            "和弦全採（{n} 軌）",
  "fileBox.modeTitle":           "同時按下多個音時要保留哪一個。分解和弦（音錯開進場）兩個模式都採得到。",
  "fileBox.colUnit":             "聲部",
  "fileBox.importAria":          "匯入 {label}",
  // 表頭那顆勾。{max} 是全卜選勾到第幾列 —— 要講出上限，不然看起來像會勾滿整份清單。
  "fileBox.pickAllAria":         "全選（最多前 {max} 列）／全部取消",
  "fileBox.tag.melody":          "有旋律",
  "fileBox.tag.melodyTitle":     "最高聲部有自己的節奏。智能分弦會留一軌主旋律，最多 4 軌",
  "fileBox.tag.chords":          "純伴奏",
  "fileBox.tag.chordsTitle":     "最高聲部從來不自己動，是和弦的一部分。智能分弦不留旋律軌，最多 3 軌",
  "fileBox.tag.drum":            "打擊",
  "fileBox.tag.drumTitle":       "GM 的第 10 個 channel 是打擊組，音高是鼓的編號不是音階。智能分弦與和弦全採是照音高分聲部的，對打擊組沒有意義",
  "fileBox.tag.readonly":        "唯讀",
  "fileBox.tag.readonlyTitle":   "匯入後這一軌不能用鋼琴捲軸編輯（{why}），文字照樣可以改",
  "fileBox.tag.chars":           "{n} 字",
  "fileBox.tag.charsTitle":      "超過遊戲的 {max} 字上限，這一軌貼不進空白樂譜",
  "fileBox.tag.willCut":         "會被截斷",
  "fileBox.tag.willCutTitle":    "超過編輯器的 {max} 字上限，匯入時後面會被切掉",
  "fileBox.capLeft":             "剩 {n} 軌",
  "fileBox.capTotal":            "{n} 軌",
  "fileBox.picked":              "已選 {n} / {cap}",
  "fileBox.pickedOver":          "已選 {n} / {cap} —— 超過 {extra} 軌",
  "fileBox.allNoRoom":           "（和弦全採要用掉全部 {max} 軌，追加放不下 —— 改選新採譜）",
  "fileBox.allTakesAll":         "（和弦全採會用掉 {max} 軌，不能再勾別的）",
  "fileBox.wipeHint":            "會清空全部 15 軌的內容，重新從第 1 軌開始建置。按 Ctrl+Z 可以復原。",
  "fileBox.appendHint":          "從第 {from} 軌開始寫，前面 {keep} 軌不動。",
  "fileBox.appendEmpty":         "目前的譜是空的，追加跟新採譜結果一樣。",
  "fileBox.okWipe":              "清空並匯入",
  "fileBox.okImport":            "匯入",
  "fileBox.readFailed":          "讀不了這個檔案：{msg}",
  "fileBox.noNotes":             "這個檔裡沒有找到任何音符。",
  "fileBox.format2":             "這是 Format 2 的 MIDI（每個音軌是獨立的樂段），同時勾多個音軌會疊在一起",
  "fileBox.unknownFile":         "認不出這個檔案。可以吃 .mid、3MLE 的 .mml、瑪奇的 .mmi，或是只有 MML@…; 的純文字檔。",
  "fileBox.savedMmlMeters":   ".mml 只帶得走曲首拍號，曲中的變拍不會保留 —— 要保留請存成 .mid",
  "fileBox.savedMmi":            "已存 {n} 軌的 .mmi。<b>超過 6 軌的 .mmi 只保證本站讀得回來</b> —— 3MLE 等第三方工具能不能讀還沒驗證過。要給別人用建議存成 .mml。",
  "fileBox.newed":               "已開新檔案，留下 {n} 軌空白樂譜。調號與換行設定保留。按 Ctrl+Z 可以復原。",
  "fileBox.cleared":             "已清空所有音符，留下 {n} 個空白音軌。樂器與設定都保留。按 Ctrl+Z 可以復原。",
  "fileBox.warn.readonly":       "{n} 軌有看不懂的字元，那幾軌的鋼琴捲軸是唯讀的（文字可以改）",
  "fileBox.warn.overLimit":      "{n} 軌超過遊戲的 {max} 字上限，貼不回遊戲",
  "fileBox.warn.cut":            "{n} 軌超過 {max} 字，後面已經被截掉",
  "fileBox.warn.tempoInAppend":  "追加的軌裡有速度指令，可能會改變整首歌的速度",
  "fileBox.appended":            "已追加 {n} 軌（第 {from}–{to} 軌）",
  "fileBox.imported":            "已匯入 {n} 軌",
  "fileBox.beyondGame":          "。第 {n} 軌之後貼不進遊戲的空白樂譜，那些是素材",

  // ─── 主 UI：音色庫與狀態列（ui.js） ───────────────────────────────────────
  // stat.* 竹的 <span class="k"> 留在程式碼裡，這裡只有那個字。
  // play.* 前面的 ▶ ❚❚ 與後面兩個半形空白是刻意的（按鈕寬度靠它穩住），要保留。
  // filterNoteWrap 是全形括號 —— 英文要換半形，前面還要補一個空白。
  "ui.bankLabel":          "{bank} · {n} 個音色",
  "ui.filterNoteWrap":     "（{note}）",
  "ui.defLabel":           "{def} · {n} 項",
  // 接在 defLabel 後面的尾段，**只有對得到時才接** —— 合成一條會出現「，對到　個」。
  "ui.defMatched":         "，對到 {matched} 個",
  "ui.defUnknown":         "{name} · 認不出格式（{lines} 行）",
  "ui.parseFailed":        "解析失敗：{msg}",
  "ui.defaultBpm":         "120 BPM（預設）",
  "ui.stat.tracks":        "<span class=\"k\">軌</span> {n} / {max}",
  "ui.stat.notes":         "<span class=\"k\">音符</span> {n}",
  "ui.stat.tempo":         "<span class=\"k\">速度</span> {bpm}",
  "ui.stat.length":        "<span class=\"k\">長度</span> {mm}:{ss}",
  "ui.saved":              "已暫存",
  "ui.store.broken":       "這個瀏覽器不給暫存",
  "ui.store.off":          "自動存檔已關閉",
  "ui.store.never":        "尚未暫存",
  "ui.store.restored":     "已接回上次的樂譜",
  "ui.play.resume":        "▶  繼續",
  "ui.play.pause":         "❚❚  暫停",
  "ui.play.play":          "▶  演奏",
  "ui.bankBuiltinFailed":  "內建音色庫載入失敗，請自行載入",
  "ui.bankReading":        "讀取中…",
  "ui.bankFailed":         "載入失敗",
  "ui.bankLoadError":      "音色庫載不進來",

  // ─── 離線卜音色庫（設定抽屜。狀態的意義見 offline.js） ───
  "ui.offlineBankInactive":       "離線功能還沒啟用 · 重新開啟這一頁之後生效",
  "ui.offlineBankAbsent":         "未保留在這台裝置 · 離線時不會有聲音",
  "ui.offlineBankWorking":        "取得中…",
  "ui.offlineBankReady":          "已備妥 · {mb} MB",
  "ui.offlineBankReadyEvictable": "已備妥 · {mb} MB · 系統空間不足時可能清除",
  "ui.offlineBankFailed":         "這次沒成功，可以再試一次",

  "ui.defUnparsed":        "這個 .def 的 <code>[Instrument presets]</code> 區塊我沒認出來。把前幾行貼給我，我把 parser 調成對的。",
  "ui.defNoMatch":         "這份 .def 的 {n} 個編號在目前的音色庫裡一個都找不到，八成是配錯音色庫了。下拉維持原樣。",

  // ─── 主 UI：捲軸與壞音提示（ui.js） ───────────────────────────────────────
  // count.notes／count.rests 由 count.and 接起來 —— 英文得改寫戈成 "3 notes and 2 rests"。
  // charsOfLimit 開頭有一個空白，是接在字數後面的尾段。
  // errorLine 的全形冒號與 <br><span> 都要照搬；stepWrap 是全形括號。
  //
  // 右鍵選單（openRollMenu／openNoteMenu）：「本軌」是當前這一軌，「全部軌」是所有分頁
  // —— 含輔助軌，它們跟正式軌一起播。
  // 「曲首拍號」管的是整首歌，不是某一小節。段落標記那句 why 是使用者唯一會知道「膠囊可
  // 以按」的地方。
  "mark.menu.add":              "加入段落標記",
  "mark.menu.addHint":          "第 {bar} 小節",
  "mark.menu.exists":           "這一小節已經有標記，右鍵那個膠囊可以改",
  "mark.menu.full":             "段落標記最多 {n} 個",
  "mark.menu.aria":             "段落標記選單",
  "mark.menu.title":            "第 {bar} 小節：{text}",
  "mark.menu.edit":             "修改標記文字",
  "mark.menu.remove":           "移除這個標記",
  "mark.box.addTitle":          "加入段落標記",
  "mark.box.editTitle":         "修改段落標記",
  "mark.box.at":                "第 {bar} 小節",
  "mark.box.left":              "剩 {n}",
  "mark.added":                 "第 {bar} 小節加入標記「{text}」",
  "mark.edited":                "第 {bar} 小節的標記改成「{text}」",
  "mark.removed":               "第 {bar} 小節的標記移除了",
  "bar.menu.aria":              "小節尺選單",
  "bar.menu.title":             "第 {bar} 小節",
  "bar.menu.clear":             "清除範圍播放",
  "bar.menu.clearHint":         "回到全曲播放",
  "bar.menu.clearNone":         "現在就是全曲播放",
  "bar.menu.velocity":          "此位置加入力度",
  "bar.menu.velocityHint":      "第 {track} 軌，從這裡開始",
  "bar.menu.velocityDone":      "第 {track} 軌從第 {bar} 小節開始力度 {v}",
  "bar.menu.meter":             "此小節改成 {meter}",
  "bar.menu.meterHint":         "從這裡開始到下一個變拍",
  "bar.menu.meterRemove":       "移除此小節的變拍",
  "bar.menu.meterRemoveHint":   "後面接回 {meter}",
  "bar.menu.meterHead":         "曲首拍號請在左上角改",
  "bar.menu.meterOff":          "拍號功能在設定裡是停用的",
  "bar.menu.meterDone":         "第 {bar} 小節改成 {meter}",
  "bar.menu.meterGone":         "第 {bar} 小節的變拍移除了",
  "meter.menu.aria":            "拍號選單",
  "meter.menu.title":           "曲首拍號",
  "meter.menu.beats":           "每小節拍數",
  "meter.menu.unit":            "以幾分音符為一拍",
  "meter.menu.less":            "調小",
  "meter.menu.more":            "調大",
  "meter.menu.apply":           "改成 {meter}",
  "meter.menu.same":            "目前就是 {meter}",
  "meter.menu.applied":         "曲首拍號改成 {meter}",
  "meter.menu.tempo":           "修改曲速（BPM）",
  "meter.menu.tempoHint":       "目前 {bpm} BPM",
  "roll.menu.aria":             "鍉琴捲軸選單",
  "roll.menu.title":            "第 {bar} 小節",
  "roll.menu.less":             "減少小節數",
  "roll.menu.more":             "增加小節數",
  "roll.menu.playStart":        "設定演奏開始線",
  "roll.menu.playEnd":          "設定演奏結束線",
  "roll.menu.selectBefore":     "選擇前方所有音符",
  "roll.menu.selectAfter":      "選擇後方所有音符",
  "roll.menu.selectCount":      "{n} 個音",
  "roll.menu.selectNone":       "這一側沒有音符",
  "roll.menu.insertTrack":      "本軌插入 {n} 小節",
  "roll.menu.insertSong":       "全部軌插入 {n} 小節",
  "roll.menu.deleteTrack":      "本軌刪除 {n} 小節",
  "roll.menu.deleteSong":       "全部軌刪除 {n} 小節",
  "roll.menu.insertAt":         "插在第 {bar} 小節之前",
  "roll.menu.deleteOne":        "第 {bar} 小節",
  "roll.menu.deleteRange":      "第 {from}–{to} 小節",
  "roll.menu.idle":             "這裡之後沒有音符",
  "roll.menu.playing":          "播放中不能編輯",
  // 右鍵點**卜音符**的選單。八列全部作用在「選取」，單選只是「選取剛好只有一個」。
  "roll.note.aria":             "音符選單",
  "roll.note.title":            "第 {bar} 小節 · {n} 個音",
  "roll.note.less":             "降低力度",
  "roll.note.more":             "提高力度",
  "roll.note.playStart":        "演奏開始設置在音符前",
  "roll.note.playEnd":          "演奏結束設置在音符後",
  "roll.note.velocity":         "設定力度",
  "roll.note.velocityOne":      "目前 {v}",
  "roll.note.velocityHint":     "目前 {min}–{max}",
  "roll.note.velocityDone":     "{n} 個音的力度設成 {v}",
  "roll.note.velocitySame":     "這些音的力度已經是 {v}",
  "roll.note.copy":             "複製音符",
  "roll.paste.noWhere":         "先選幾個音，或把滑鼠移到要貼上的位置",
  "roll.note.paste":            "貼上音符",
  "roll.note.pasteAt":          "貼在第 {bar} 小節第 {beat} 拍",
  "roll.note.cut":              "剪下音符",
  "roll.note.delete":           "刪除音符",

  // 觸控用的操作面板（rolljoy.js）。第一個是長度推桿的無障礙標籤，其餘是按鍵。
  // 方向鍵那八顆沒有字串：整組 aria-hidden，理由見 docs/guide-i18n.md。
  "roll.pad.size":              "長度微調",
  "roll.pad.multi":             "多選",
  "roll.pad.menu":              "選單",
  "roll.pad.clear":             "取消選擇",
  "roll.pad.del":               "刪除",
  "roll.pad.multiHint":         "拖曳空白處＝框選 · 雙指捲動",

  "ui.roll.readonly":         "這一軌唯讀：{why}",
  "ui.roll.cantEdit":         "這一軌不能用捲軸編輯：{why}",
  "ui.roll.cantEncode":       "這一軌有無法重新編碼的時值，寫不回去。",
  "ui.roll.regenWarn":        "捲軸編輯會重新產生整軌的 MML，<b>註解與手動排版會消失</b>。音符內容不受影響。",
  "ui.roll.droppedBadChars":  "這一軌有<b>看不懂的字元</b>（例如 <code>r+</code>），重新產生時已經丟掉。它們本來就不發聲。",
  "ui.roll.plainFallback":    "這一軌的時值太雜，<b>找不到一個通用的預設長度</b>，所以改用最省字的寫法產生。內容完全正確，只是比較難讀。",
  "ui.roll.overLimit":        "這一軌超過遊戲的 {max} 字上限了，<b>目前的內容貼不進空白樂譜</b>。內容留著，字數在樂器列右邊會變紅。",
  "ui.roll.copyNone":         "選取裡沒有可以複製的音符。",
  "ui.roll.copied":           "已複製 {n} 個音。",
  "ui.roll.pasteBad":         "剪貼簿裡的內容認不出是 MML。",
  "ui.roll.pasteEmpty":       "剪貼簿裡沒有音符可以貼。",
  "ui.roll.pasteJunk":        "剪貼簿裡有 {n} 個 MML 以外的字元，看起來不是樂譜。",
  "ui.roll.pasted":           "已貼上 {n} 個音，取代了原本的內容 · Ctrl+Z 可復原",
  "ui.count.notes":           "{n} 個音",
  "ui.count.rests":           "{n} 個休止符",
  "ui.count.and":             "與",
  "ui.bad.duration":          "的時值寫不出來，編輯後差 {sign}{drift} tick",
  "ui.bad.nonstd":            "用了遊戲不支援的非標準時值；複製或分享時保留原文，不調整時值",
  "ui.bad.red":               "紅色：{list}",
  "ui.needSelection":         "先在樂譜或捲軸上選幾個音符",
  "ui.noNotesInRange":        "這個範圍裡沒有音符。",
  "ui.calculating":           "計算中…",
  "ui.charsOfLimit":          " 字 ／ 上限 {max}",
  "ui.stepWrap":              "（{step}）",
  "ui.errorLine":             "{headline}{step}：{msg}<br><span style=\"color:var(--dim)\">{hint}</span>",

  // 木標題列上那四顆只在窄畫面出現的顯示開關。名字寫在這裡而不是 .resx：那份是抽取工具產
  // 的，手加會讓既有的編號漂掉。四個都寫「顯示X」而不是「X」。
  "ui.hdr.menu":              "選單",
  "ui.hdr.tools":             "顯示工具列",
  "ui.hdr.roll":              "顯示鋼琴捲軸",
  "ui.hdr.editor":            "顯示編輯器",
  "ui.hdr.status":            "顯示狀態列",

  // ─── 主 UI：移調（ui.js） ─────────────────────────────────────────────────
  // button 是「升 3 key」這種按鈕文字，{dir} 填 up／down，{oct} 填 octave（或空）。
  // **英文語序不同**（Up 3 keys）—— 整句重寫、位置符自由搬。
  "ui.trans.up":               "升",
  "ui.trans.down":             "降",
  "ui.trans.high":             "高",
  "ui.trans.low":              "低",
  "ui.trans.octave":           "<em>（{dir}八度）</em>",
  "ui.trans.button":           "{dir} {n} key{oct}",
  "ui.trans.failTrack":        "第 {n} 軌{why}，無法移調。",
  "ui.trans.failEncode":       "第 {n} 軌有無法重新編碼的時值，無法移調。",
  "ui.trans.tooLow":           "{n} 個音符低於音階下限",
  "ui.trans.tooHigh":          "{n} 個音符高於音階上限",
  "ui.trans.failReasons":      "{list}，無法移調。",

  // ─── 主 UI：速度（ui.js） ─────────────────────────────────────────────────
  // atStart／atPos 填卜進 written 的 {where}。英文要改成 at the start of {track}，所以
  // written 整句重寫。
  "ui.tempo.replace":           "這個位置原本是 <b>T{from}</b>，會改成 <b>T{to}</b>。",
  "ui.tempo.insert":            "會在這裡寫入 <b>T{to}</b>（目前這個位置是 {at}）。",
  "ui.tempo.willSplit":         "<b>{list}</b> 有音符跨過速度變化的位置，會切成兩段用連結線接回去（聽起來完全一樣，只是遊戲裡才不會走音）。",
  "ui.tempo.noPreviewPlaying":  "演奏中不能試聽。",
  "ui.tempo.noPreviewBank":     "音色庫還沒載完，還不能試聽。",
  "ui.tempo.trackMuted":        "{track} 目前是靜音的，試聽聽不到。",
  "ui.tempo.failParse":         "{track}{why}，速度圖寫不進去。",
  "ui.tempo.failEncode":        "{track} 有無法重新編碼的時值，寫不回去。",
  "ui.tempo.failEncodeN":       "{track} 有無法重新編碼的時值，切不開。",
  "ui.tempo.noChange":          "速度沒有變化。",
  "ui.tempo.removed":           "已移除這個位置的速度記號。",
  "ui.tempo.written":           "已把 T{bpm} 寫進{track}{where}。",
  "ui.tempo.atStart":           "開頭",
  "ui.tempo.atPos":             "的指定位置",

  // ─── 主 UI：力度（ui.js） ────────────────────────────────────────────────────
  // clipped 裡竹的 v{a}／v{b} 兩個位置符填的是同一個數字（0 或 15），不是筆誤。
  "ui.vel.up":          "增強",
  "ui.vel.down":        "減弱",
  "ui.vel.button":      "{dir} {sign}{n}",
  "ui.vel.range":       "這個範圍有 <b>{n}</b> 個音，力度 <b>v{min}</b> – <b>v{max}</b>",
  "ui.vel.noNotes":     "這個範圍沒有音符。",
  "ui.vel.clipped":     "有 {n} 個音超出v{a}會被夾到 v{b}，它們之間的強弱差別會消失。",
  "ui.vel.failParse":   "{track}{why}，無法調整力度。",
  "ui.vel.failEncode":  "{track} 有無法重新編碼的時值，寫不回去。",
  "ui.vel.noChange":    "力度沒有變化。",

  // ─── 主 UI：合併（ui.js） ─────────────────────────────────────────────────
  // merge.from 中日間是**全形空白**；cost 裡的換行是按鈕上的換行，要保留。
  // why.* 是接在句子裡的原因片段，不要自己補主詞。
  "ui.merge.failSrc":        "來源軌{why}",
  "ui.merge.why.empty":      "這個範圍裡沒有搬得動的音符",
  "ui.merge.why.encode":     "有無法重新編碼的時值",
  "ui.merge.from":           "{track}　{n} 個音符",
  "ui.merge.cost":           "丟掉 {dropped} 個音\n截短 {trimmed} 個音",
  "ui.merge.cantMerge":      "這個範圍沒辦法合併",
  "ui.merge.noLoss":         "一個音都沒有丟掉",
  "ui.merge.lossSummary":    "丟掉 {dropped} 個音、截短 {trimmed} 個音",
  "ui.merge.done":           "已合併到 <b>{track}</b>：{cost}。不滿意按 Ctrl+Z。",
  "ui.mergeNoteLine":        "{list}。",

  // ─── 主 UI：優化（ui.js） ─────────────────────────────────────────────────
  // saveLossless／saveMore 裡竹的換行是按鈕上的換行，要保留。
  // scopeAll／scopeOne 接在 charsOfLimit 前面當主詞。
  "ui.opt.skipTrack":           "第 {n} 軌{why}",
  "ui.opt.saveLossless":        "省 {n} 字\n不動任何音符",
  "ui.opt.saveMore":            "再省 {n} 字\n影響 {changed} 個音",
  "ui.opt.scopeAll":            "最長的一軌",
  "ui.opt.scopeOne":            "這一軌",
  "ui.opt.nothingLeft":         "這個範圍已經沒有字可以省了",
  "ui.opt.losslessWholeTrack":  "無損壓縮一律整軌重算，不受選取範圍影響",
  "ui.opt.failLossless":        "這個範圍裡沒有字可以省。",
  "ui.opt.keepZip":             "維持壓縮",
  "ui.opt.zipOff":              "關閉 {n} 軌的自動壓縮",
  "ui.opt.zipOffHint":          "只停止之後的自動壓縮，已經壓好的文字不會展開。",
  "ui.opt.zipOffDone":          "已關閉 {n} 軌的自動壓縮，文字沒有動。不滿意按 Ctrl+Z。",
  "ui.opt.zipArmed":            "已記住 {n} 軌要維持壓縮，之後在鋼琴捲軸上編輯不會讓字數跳回去。不滿意按 Ctrl+Z。",
  "ui.opt.zipVerifyFailed":     "{track} 的自動壓縮驗證沒過，這次用了未壓縮的版本，並退出壓縮模式。這是 bug，請回報這首譜。",
  "ui.opt.failOptimize":        "這個範圍裡沒有可以優化的地方。",
  "ui.opt.verifyFailed":        "驗證沒過，一個音都沒有動。這是 bug，請回報這首譜。",
  "ui.opt.doneLossless":        "已壓縮：省下 <b>{n}</b> 字，一個音都沒有動。不滿意按 Ctrl+Z。",
  "ui.opt.doneOptimize":        "已優化：省下 <b>{n}</b> 字，動到 {changed} 個音符。不滿意按 Ctrl+Z。",
  "ui.optNoteLine":             "{list}。",

  // ─── 純標點的包裝字串 ─────────────────────────────────────────────────────
  // 水沒有漢字、只有全形標點，所以掃描規則看不到它們 —— **但照樣要翻**：英文用半形括號、句
  // 點與空白。whoWrapper 填進 account.delete.* 的 {who}；sayWithWarnings／sayLine 是
  // filebox 匯入完成那一句的兩種形狀（有警告／沒警告）。
  "account.whoWrapper":       "（{email}）",
  "fileBox.midiName":         "{name} · {list}",
  "fileBox.sayWithWarnings":  "{head}。{warnings}{tail}。",
  "fileBox.sayLine":          "{head}{tail}。",
  "shareBox.warnPrefix":      "⚠ {list}",


  // ─── 儲存框（savebox.js）─────────────────────────────────────────────────
  "saveBox.emptyScore":     "這首是空的，沒有東西可以存",
  "saveBox.needName":       "先給這個檔案取個名字",
  "saveBox.dirty":          "● 有未儲存的變更",
  "saveBox.clean":          "✓ 已儲存",
  "saveBox.dbBroken":       "這個瀏覽器不給存檔（無痕視窗或瀏覽器設定擋住了）。",
  "saveBox.listEmpty":      "還沒有存過任何檔案。",
  "saveBox.used":           "{n} 個檔案 · 已用 {used} / {max} MB",
  "saveBox.pickedN":        "已選 {n} 個",
  "saveBox.pickAria":       "選取 {name}",
  "saveBox.op.open":        "開啟",
  "saveBox.op.openTitle":   "把這一份載入到現在的編輯器（可以 Ctrl+Z 復原）",
  "saveBox.op.delete":      "刪除",
  "saveBox.op.deleteTitle": "把這一份刪掉",
  "saveBox.overWhat":       "{name}　{tracks} 軌 · {notes} 個音符　{when}",
  "saveBox.saved":          "已儲存「{name}」（{tracks} 軌 · {notes} 個音符）。",
  "saveBox.replaced":       "已覆蓋「{name}」（{tracks} 軌 · {notes} 個音符）。",
  "saveBox.full":           "存不下：這個檔案要 {need} MB，只剩 {free} MB。先刪掉一些檔案，或用批次下載備份之後再刪。",
  "saveBox.quotaExceeded":  "瀏覽器的儲存空間滿了（磁碟空間不足）。清一些空間之後再試一次。",
  "saveBox.writeFailed":    "存檔失敗：{msg}",
  "saveBox.readFailed":     "「{name}」讀不回來，這一筆可能壞了。",
  "saveBox.opened":         "已開啟「{name}」（{tracks} 軌）。按 Ctrl+Z 可以回到剛才那份。",
  "saveBox.delOne":         "{name}",
  "saveBox.delMany":        "{n} 個檔案：{names}",
  "saveBox.deleted":        "已刪除 {n} 個檔案。",
  "saveBox.zipName":        "mml-workshop",
  "saveBox.zipEmpty":       "選取的檔案都讀不回來，沒有東西可以打包。",
  "saveBox.zipped":         "已下載 {n} 個檔案。",
  "saveBox.zipFailed":      "打包失敗：{msg}",
  "saveBox.go.local": "存到 local",
  "saveBox.go.web": "存到 web",
  "webSave.needLogin": "存到 web 需要登入",
  "webSave.offlineWhy": "離線中，存不到雲端 —— 本機那一頁照樣可以存",
  "webSave.offline": "連不上伺服器。",
  "webSave.listEmpty": "還沒有存到 web 過任何檔案。",
  "webSave.total": "共 {n} 份",
  "webSave.tooBig": "這一份太大了（{chars} 字元，上限 {max}）。先精簡一些內容再存到 web。",
  "webSave.moveToWeb": "複製到 web",
  "webSave.moveToLocal": "複製到 local",
  "webSave.moveToWebTitle": "把選取的檔案複製到 web。來源這一份留著。",
  "webSave.moveToLocalTitle": "把選取的檔案複製到 local。來源這一份留著。",
  "webSave.whereLocal": "local",
  "webSave.whereWeb": "web",
  "webSave.moveHit": "{where}上已經有 {n} 份同名的檔案：{names}",
  "webSave.moveSkip": "只搬其餘 {n} 份",
  "webSave.moved": "已複製 {n} 份到{where}。來源這邊照樣留著。",
  "webSave.movedPartial": "已複製 {done} 份到{where}就停下來了：{why}",
  "webSave.deletedPartial": "只刪掉了 {done} / {total} 份，其餘的失敗了。",


  // ─── 匯入五線卜譜（OMR） ───
  "omr.uploading": "正在上傳 {n} 張圖…",
  "omr.queued": "排隊中，就快輪到了…",
  "omr.queuedBehind": "排隊中，前面還有 {n} 份…",
  "omr.running": "辨識中…這一步要幾十秒到幾分鐘，先別關掉這個框。",
  "omr.runningPage": "辨識中：第 {done} / {total} 頁…先別關掉這個框。",
  "omr.reconnecting": "連線斷了，重試中…伺服器那邊還在跑。",
  "omr.failed": "辨識失敗了。",
  "omr.gone": "找不到這份辨識工作，請重新上傳。",
  "omr.netError": "連不上伺服器。",
  "omr.noResult": "辨識完成，但沒有拿到任何內容。",
  "omr.badResponse": "伺服器回了非預期的內容（HTTP {code}）。",
  "omr.defaultName": "五線譜",

  // 整理圖片那一頁。上限的數字由呼叫端帶進來（filebox.js 竹的 OMR_MAX_*），不要寫死在字串
  // 裡 —— 伺服器改了數字這裡才跟得上。
  "omr.count": "{n} 張 / 最多 {max} 張",
  "omr.countDone": "{n} 張，已辨識",
  "omr.tooManyPages": "一次最多 {max} 張，多的沒有加進來",
  "omr.notSupported": "「{name}」不是 PNG、JPEG 或 PDF",
  "omr.mixedKinds": "一次只能上傳圖片或一份 PDF，不能混在一起",
  "omr.removePdf": "移除這份 PDF",
  "omr.pdfOne": "1 份 PDF",
  "omr.pdfPages": "共 {n} 頁",
  "omr.pdfPagesDone": "{n} 頁，已辨識",
  "omr.uploadingPdf": "正在上傳 PDF…",
  "omr.runningPdf": "辨識中：共 {total} 頁，大約還要 {sec} 秒…先別關掉這個框。",
  "omr.runningPdfLong": "辨識中：已經等了 {sec} 秒，比預估的久…先別關掉這個框。",
  "omr.fileTooLarge": "「{name}」超過 {max} MB",
  "omr.totalTooLarge": "全部加起來不能超過 {max} MB",
  "omr.moveLeft": "把第 {n} 張往前移",
  "omr.moveRight": "把第 {n} 張往後移",
  "omr.remove": "移除第 {n} 張",

  // 辨識失敗的原田因。**這幾條取代 worker 回的原始訊息** —— worker 是另一個 repo，訊息只有
  // 中文，而且認不出來的失敗會帶著整段引擎輸出回來（見 filebox.js 的 omrErrorText）。
  "omr.err.notScore": "這份樂譜裡找不到五線譜。可能不是樂譜，或是解析度太低 —— 掃描的話建議 300 DPI 以上，而手上有 PDF 的話直接上傳 PDF 最好。",
  "omr.err.timeout": "辨識超過時限了。這份樂譜可能太複雜，或伺服器正忙。",
  "omr.err.unreachable": "連不上辨識服務，請稍後再試。",
  "omr.err.busy": "辨識服務正在忙，請稍後再試。",
  "omr.err.tooLarge": "圖片太大了。",
  "omr.err.invalidInput": "這個檔案沒辦法辨識，請用 PDF、PNG 或 JPEG。",
  "omr.err.internal": "辨識時發生錯誤，請稍後再試。",
  "omr.err.onPage": "第 {page} / {total} 頁：{msg}",

  // ─── 混音 MP3 匯出的舞台（mixstage.js） ────────────────────────────────────
  // phase.* 與 err.* 都是動態組出來的 key（i18n.t(`stage.err.${code}`)），孤兒檢查認得
  // 那個前綴，所以這裡不必再寫一次字面量。play/pause 例外 —— 那兩個是字面量呼叫。
  // ▶ ❚❚ 後面兩個半形空白同 ui.play.*：按鈕寬度靠它穩住。
  "stage.listener":        "聽者",
  "stage.play":            "▶  試聽",
  "stage.pause":           "❚❚  暫停",
  "stage.dropped":         "{list}不會出現在這個檔案裡 —— 混音匯出只做前 {kept} 軌，也就是遊戲讀得到的那幾軌。",
  "stage.phase.render":    "合成中",
  "stage.phase.env":   "鋪環境音",
  "stage.phase.encode":    "編碼中",
  "stage.phase.done":      "完成",
  "stage.err.oom":         "記憶體不足。手機上很常見 —— 改用電腦，或把曲子縮短。",
  "stage.err.silent":      "這首曲子沒有任何會發聲的音符。",
  "stage.err.worker":      "合成失敗，詳情看主控台。",
  "stage.err.truncated":   "音訊搬運不完整，請再試一次。",
  "stage.err.envload":   "環境音的素材載入失敗。連上網路之後再試一次，或把環境音改成「無」。",
  "stage.err.unknown":     "匯出失敗，詳情看主控台。",
  "video.err.popup":       "彈出視窗被擋住了。請允許這個網站開新分頁，再按一次。",
  "video.err.store":       "這個瀏覽器存不了交棒的資料，做不了影片。無痕視窗常常是這個原因。",
  "fileBox.mixNeedBank":   "要先載入音色庫才算得出聲音",
  "fileBox.mixEmptyScore": "沒有音符可以匯出",

  // ─── 鋼琴瀑布影片（js/video.js）───────────────────────────────────────────
  //
  // Waterfall.cshtml 只負責 JS 跑起來之前看得到的字，其餘全在這裡（見那份 View 的
  // 「字串的所有權」）。
  "waterfall.mark":             "夜光MML",
  "waterfall.play":             "播放",
  "waterfall.pause":            "暫停",
  "waterfall.seek":             "播放位置",
  "waterfall.export":           "匯出 MP4",
  "waterfall.cancel":           "取消",
  "waterfall.shape":            "影片比例",
  "waterfall.speed":            "落下速度",
  "waterfall.speed.slower":     "最慢",
  "waterfall.speed.slow":       "慢",
  "waterfall.speed.normal":     "標準",
  "waterfall.speed.fast":       "快",
  "waterfall.name":             "檔名",
  "waterfall.look":             "外觀",
  "waterfall.look.title":       "影片外觀",
  "waterfall.look.colors":      "軌道顏色",
  "waterfall.look.style":       "音符樣式",
  "waterfall.look.fx":          "落鍵特效",
  "waterfall.look.done":        "完成",
  "waterfall.look.reset":       "恢復預設",
  "waterfall.look.back":        "返回",
  "waterfall.env":          "環境音",
  "waterfall.env.title":    "環境音",
  "waterfall.env.preset":      "環境音",
  "waterfall.env.amount":      "環境音量",
  "waterfall.env.working":     "正在把環境音混進去… {p}%",
  "waterfall.env.failed":      "環境音的素材載入失敗，已改回「無」。連上網路之後再試一次。",

  // ─── 環境音（envaudio.js）。清單就是 ENV_PRESETS 的順序 ───
  "env.preset.none":             "無",
  "env.preset.village_day":      "堤爾克那・白天",
  "env.preset.village_night":    "堤爾克那・夜晚",
  "env.preset.forest_day":       "森林・白天",
  "env.preset.forest_night":     "森林・夜晚",
  "env.preset.town_day":         "城鎮・白天",
  "env.preset.town_night":       "城鎮・夜晚",
  "env.preset.mine_day":         "礦坑・白天",
  "env.preset.mine_night":       "礦坑・夜晚",
  "env.preset.wilderness_day":   "荒野・白天",
  "env.preset.wilderness_night": "荒野・夜晚",
  "env.preset.ice_canyon_day":   "冰峽谷・白天",
  "env.preset.ice_canyon_night": "冰峽谷・夜晚",
  "env.preset.swamp":            "沼澤",
  "env.preset.palace":           "宮殿室內",
  "env.preset.altar":            "祭壇",
  "env.preset.dungeon":          "地城入口",
  "env.preset.drizzle":          "毛毛雨",
  "env.preset.rain":             "雨",
  "env.preset.storm":            "暴雨與雷",
  "waterfall.style.glass":      "玻璃",
  "waterfall.style.neon":       "霓虹",
  "waterfall.style.pixel":      "像素",
  "waterfall.style.saber":      "光劍",
  "waterfall.style.flowborder": "流光",
  "waterfall.style.glow":       "光暈",
  "waterfall.style.electric":   "電光",
  "waterfall.style.frost":      "冰晶",
  "waterfall.style.glitch":     "故障",
  "waterfall.style.bubble":     "泡泡",
  "waterfall.style.toon":       "卡通",
  "waterfall.style.retro":      "復古",
  "waterfall.fx.burst":         "噴發",
  "waterfall.fx.ripple":        "漣漪",
  "waterfall.fx.beam":          "光柱",
  "waterfall.fx.smoke":         "煙霧",
  "waterfall.fx.spark":         "火花",
  "waterfall.fx.nova":          "新星",
  "waterfall.fx.shatter":       "碎裂",
  "waterfall.fx.ember":         "灰燼",
  "waterfall.fx.splash":        "水花",
  "waterfall.fx.none":          "無",
  "waterfall.color.0":          "天空藍",
  "waterfall.color.1":          "蜜柑橙",
  "waterfall.color.2":          "翡翠綠",
  "waterfall.color.3":          "薔薇粉",
  "waterfall.color.4":          "琥珀金",
  "waterfall.color.5":          "紫水晶",
  "waterfall.color.6":          "薄荷青",
  "waterfall.color.7":          "珊瑚紅",
  "waterfall.color.8":          "寶石藍",
  "waterfall.color.9":          "萊姆綠",
  "waterfall.color.10":         "蘭花紫",
  "waterfall.color.11":         "湖水青",
  "waterfall.color.12":         "紫藤",
  "waterfall.color.13":         "檸檬黃",
  "waterfall.color.14":         "柿子橘",
  "waterfall.color.15":         "月光白",
  "waterfall.color.16":         "栗子棕",
  "waterfall.color.17":         "烈焰橙",
  "waterfall.color.18":         "深橄欖",
  "waterfall.color.19":         "松林綠",
  "waterfall.color.20":         "深孔雀青",
  "waterfall.color.21":         "霓虹青",
  "waterfall.color.22":         "電光藍",
  "waterfall.color.23":         "暮灰藍",
  "waterfall.color.24":         "午夜藍",
  "waterfall.color.25":         "深靛紫",
  "waterfall.color.26":         "電光紫",
  "waterfall.color.27":         "桃紅",
  "waterfall.color.28":         "酒莓紅",
  "waterfall.color.29":         "緋紅",
  "waterfall.estimate":         "約 {mb} MB",
  "waterfall.phase.video":      "畫面編碼中",
  "waterfall.phase.audio":      "音訊編碼中",
  "waterfall.phase.mux":        "組裝檔案",
  "waterfall.phase.done":       "完成",
  "waterfall.err.nocodecs":     "這個瀏覽器沒有 WebCodecs，做不出影片。請改用 Chrome、Edge 或 Safari 16.4 以上。",
  "waterfall.err.novideo":      "這台裝置編不出 H.264 影片。請改用 Chrome、Edge 或 Safari 16.4 以上。",
  "waterfall.err.noaudio":      "這台裝置編不出 AAC 音訊。目前影片一定要有聲音，所以先做不了。",
  "waterfall.err.video":        "畫面編碼失敗。",
  "waterfall.err.audio":        "音訊編碼失敗。",
  "waterfall.err.reclaimed":    "影片做到一半被瀏覽器中斷了。製作期間請讓這個分頁留在前景，也不要讓螢幕休眠。",
  "waterfall.err.nodesc":       "編碼器沒有給解碼設定，寫不出可以播的 MP4。",
  "waterfall.err.unknown":      "做影片失敗，詳情看主控台。",
};
