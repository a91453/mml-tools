// Listen links for the audio prescreen's human_review regions.
//
// A NEEDS_HUMAN region names its bars and the alternatives to compare. This
// turns each one into a Studio Web listen link (mml-studio/listen-link@1) that
// opens the region with the first alternative as `mml` and another as
// `compare_mml`, so the owner can A/B exactly those bars.
//
// The links sit beside the report, never inside it: report_id (and the shadow
// prediction_id derived from it) identifies what the machine computed and must
// not change with the deployment's Studio Web origin. A link is a listening
// aid only. It records nothing, and what the owner hears is listening feedback,
// never a gate confirmation, evidence or an acceptance.
import { LISTEN_LINK_SCHEMA, ListenLinkError } from '../studio/web/listen-link.mjs';
import { LISTEN_RESPONSE, listenLinkUrl } from './mcp-listen.mjs';

export const PRESCREEN_LISTEN_SCHEMA = 'mml-studio/prescreen-listen@1';
export const PRESCREEN_LISTEN_LIMITS = Object.freeze({
  // A report may name many regions; the links travel in one MCP response.
  maxLinks: 8,
  totalChars: 128 * 1024,
});
const NOTICE = 'Listening aids for the prescreen\'s human_review regions: each opens those bars in Studio Web with one alternative as the version and another as the comparison. They are not part of the report (report_id is unchanged), record nothing, and what is heard is listening feedback, never a gate confirmation, evidence or an acceptance.';

/**
 * `mmlOf(label)` returns the alternative's MML text, or null when it has none
 * (a candidate alternative carries Canonical events, not MML).
 */
export async function prescreenListenLinks(report, { listen, mmlOf }) {
  const regions = Array.isArray(report?.human_review) ? report.human_review : [];
  const base = { schema: PRESCREEN_LISTEN_SCHEMA, notice: NOTICE };
  if (!regions.length) return { ...base, status: 'NO_HUMAN_REVIEW', links: [], withheld: 0 };
  if (!listen?.studioWebOrigin) return { ...base, status: listen?.studioWebOriginStatus ?? 'ORIGIN_NOT_CONFIGURED', links: [], withheld: 0 };

  const links = [];
  let withheld = 0, chars = 0;
  for (const region of regions) {
    const [first, ...others] = region.alternatives ?? [];
    for (const other of others) {
      const entry = { region_id: region.region_id, bars: region.bars, mml_label: first, compare_label: other };
      const mml = await mmlOf(first), compare = await mmlOf(other);
      if (!mml || !compare) { links.push({ ...entry, url: null, status: 'NO_MML_FOR_ALTERNATIVE' }); continue; }
      if (links.filter(link => link.url).length >= PRESCREEN_LISTEN_LIMITS.maxLinks) { withheld++; continue; }
      const document = {
        schema: LISTEN_LINK_SCHEMA,
        mml,
        compare_mml: compare,
        title: `預篩 小節 ${region.bars[0]}–${region.bars[1]}：${first} 對 ${other}`,
        ...(report.inputs?.meter ? { meter_text: report.inputs.meter } : {}),
        start: { beat: region.beats[0] },
        markers: [{ beat: region.beats[0], end_beat: region.beats[1], kind: 'pending', label: `預篩需要人聽：${(region.reasons ?? []).join(', ')}`.slice(0, 120) }],
      };
      let url;
      try { url = await listenLinkUrl(listen.studioWebOrigin, document); }
      catch (error) {
        if (!(error instanceof ListenLinkError)) throw error;
        links.push({ ...entry, url: null, status: error.code ?? 'LINK_REFUSED' });
        continue;
      }
      if (url.length > LISTEN_RESPONSE.linkChars || chars + url.length > PRESCREEN_LISTEN_LIMITS.totalChars) { withheld++; continue; }
      chars += url.length;
      links.push({ ...entry, url, status: 'OK' });
    }
  }
  return { ...base, status: 'OK', origin: listen.studioWebOrigin, links, withheld };
}
