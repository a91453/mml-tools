// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Flat-key i18n with zh-Hant fallback, plurals and Korean particles; the engine
// is shared with the Studio main page (../i18n-core.mjs).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import zhHant from "./i18n/zh-Hant.mjs";
import { createI18n } from "../i18n-core.mjs";

const core = createI18n({ base: zhHant, load: tag => import(`./i18n/${tag}.mjs`), label: "[Workshop]" });

export const use = core.use;
export const getLocale = core.getLocale;
export const t = core.t;
export const has = core.has;

export const list   = items => items.join(t("list.item"));
export const clause = items => items.join(t("list.clause"));

export const trackName = i =>
  has(`track.name.${i}`) ? t(`track.name.${i}`) : t("track.nth", { n: i + 1 });

export const keySigLabel = i => t(`keysig.${i}`);
