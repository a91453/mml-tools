// Studio main page i18n (zh-Hant, en, ja, ko). The engine is shared with the
// Workshop (i18n-core.mjs); the tables live in ./i18n/. Gate and status codes
// (VALIDATED, PENDING, PASS, IN_GAME_ACCEPTED…) are never translated: the
// tables carry them verbatim, and badges print the codes themselves.
import zhHant from './i18n/zh-Hant.mjs';
import { createI18n } from './i18n-core.mjs';

const core = createI18n({ base: zhHant, load: tag => import(`./i18n/${tag}.mjs`), label: '[Studio]' });

export const use = core.use;
export const t = core.t;
export const has = core.has;
export const getLocale = core.getLocale;
