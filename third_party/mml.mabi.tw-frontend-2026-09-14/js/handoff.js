// ────────────────────────────────────────────────────────────────────────────
//  編輯器 → 影片頁的瀏覽器本機資料交棒
//
//  兩頁在不同分頁，sessionStorage 不適用；完整 MML 也不適合塞進 URL。
//  Cache Storage 能在同源分頁間共享，且不必把尚未公開的樂譜送到伺服器。
//
//  讀取後刻意不刪：重新整理、分頁被系統回收後恢復、或按上一頁時仍能重讀。
//  過期資料在下一次 put 時清理；Service Worker 更新也可將未列入保留清單的 cache 清掉。
// ────────────────────────────────────────────────────────────────────────────

const CACHE = "mml-handoff";
const TTL_MS = 24 * 60 * 60 * 1000;
const VERSION = 1;

const urlOf = id => `/__handoff/${id}`;
const isId = id => typeof id === "string"
  && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const expired = (rec, now) => !Number.isFinite(rec?.at) || now - rec.at > TTL_MS;

async function readRec(res) {
  if (!res) return null;
  const rec = await res.json().catch(() => null);
  if (!rec || typeof rec !== "object") return null;
  if (rec.v !== VERSION || typeof rec.payload !== "string" || !rec.payload) return null;
  return rec;
}

async function sweep(cache, now) {
  for (const req of await cache.keys()) {
    const rec = await readRec(await cache.match(req));
    if (!rec || expired(rec, now)) await cache.delete(req);
  }
}

/**
 * 寄放一份樂譜並回傳 fragment token。
 * Cache Storage 在無痕模式或非安全內容下可能失敗；例外交給呼叫端顯示。
 */
export async function put({ payload, name = "", builtinBank = true }) {
  const cache = await caches.open(CACHE);
  const now = Date.now();
  await sweep(cache, now);

  const id = crypto.randomUUID();
  const rec = { v: VERSION, payload, name, builtinBank, at: now };
  await cache.put(urlOf(id), new Response(JSON.stringify(rec), {
    headers: { "Content-Type": "application/json" },
  }));
  return id;
}

/** 把 fragment token 換回樂譜。無效、過期或無法讀取時一律回 null。 */
export async function take(id) {
  if (!isId(id)) return null;
  let rec = null;
  try {
    const cache = await caches.open(CACHE);
    rec = await readRec(await cache.match(urlOf(id)));
  } catch {
    return null;
  }
  if (!rec || expired(rec, Date.now())) return null;
  return {
    payload: rec.payload,
    name: rec.name ?? "",
    builtinBank: rec.builtinBank !== false,
  };
}
