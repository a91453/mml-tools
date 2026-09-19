// A bounded view of an existing report, not a stored snapshot or a workflow.
// Each read still goes through the Application Service's ownership checks.
import { ERROR_CODES, fail } from '../studio/backend/application/contracts.mjs';
import { sha256Hex } from '../studio/backend/source/sha256.mjs';

export const PAGED_REPORT_TOOLS = new Set([
  'studio_project_get', 'studio_baseline_events', 'studio_arrangement_suggest',
  'studio_final_reduction_plan', 'studio_mobile_adaptation_plan', 'studio_candidate_review',
  'studio_run_plan', 'studio_run_status', 'studio_proposal_targets',
  'studio_proposal_status', 'studio_job_status', 'studio_artifact_get',
]);

export const REPORT_PAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: '選填：唯讀取得報告的 JSON 文字片段，避免大型回應超限。path 是 JSON 欄位路徑（非檔案路徑），預設 [] 表示完整報告。offset 為 UTF-16 code units；後續頁必須帶第一頁的 report_sha256 作為 expected_sha256，報告變動即拒絕。依 next_offset 串接 json_fragment，完成後才 JSON.parse；單頁不是完整報告。不可與 confirmations 或 refresh=true 合用。',
  properties: {
    path: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 200 } },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    length: { type: 'integer', minimum: 1, maximum: 16000 },
    expected_sha256: { type: 'string', minLength: 64, maxLength: 64 },
  },
};

const refuse = (message, reason) => fail(ERROR_CODES.INVALID_REQUEST, message, { reason });

// Validate before dispatch, including for the local CLI which uses this same
// dispatcher. Paging must never become a way to repeat a confirmation/write.
export function validateReportPage(name, args) {
  if (!PAGED_REPORT_TOOLS.has(name) || args.confirmations !== undefined || args.refresh === true) {
    refuse('Report paging is available only for reads without confirmations or refresh.', 'REPORT_PAGE_REQUIRES_READ');
  }
  const page = args.report_page;
  if (!page || typeof page !== 'object' || Array.isArray(page)
    || Object.keys(page).some(key => !Object.hasOwn(REPORT_PAGE_SCHEMA.properties, key))) {
    refuse('Invalid report_page options.', 'INVALID_REPORT_PAGE');
  }
  const { path = [], offset = 0, length = 16000, expected_sha256 } = page;
  if (!Array.isArray(path) || path.length > 12 || path.some(key => typeof key !== 'string'
    || key.length < 1 || key.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(key))
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(length) || length < 1 || length > 16000
    || (expected_sha256 !== undefined && (typeof expected_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected_sha256)))) {
    refuse('Invalid report_page path, offset, length or SHA-256.', 'INVALID_REPORT_PAGE');
  }
  if (offset > 0 && expected_sha256 === undefined) {
    refuse('Subsequent pages require expected_sha256 from the first page.', 'REPORT_HASH_REQUIRED');
  }
  return { path, offset, length, expected_sha256 };
}

const digest = text => sha256Hex(new TextEncoder().encode(text));

export function readReportPage(report, { path, offset, length, expected_sha256 }) {
  const fullText = JSON.stringify(report);
  const reportSha = digest(fullText);
  if (expected_sha256 !== undefined && expected_sha256 !== reportSha) {
    refuse('The report changed. Discard earlier fragments and restart at offset 0.', 'REPORT_CHANGED');
  }
  let selected = report;
  for (const key of path) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)
      || (Array.isArray(selected) && !/^(0|[1-9][0-9]*)$/.test(key))) {
      refuse('The requested JSON path does not exist in this report.', 'REPORT_PATH_NOT_FOUND');
    }
    selected = selected[key];
  }
  const valueText = path.length ? JSON.stringify(selected) : fullText;
  if (typeof valueText !== 'string' || offset > valueText.length) {
    refuse('The requested page is outside the report value.', 'REPORT_OFFSET_OUT_OF_RANGE');
  }
  // Offsets deliberately count JS UTF-16 units. JSON transports escape a lone
  // surrogate when a pair crosses a page; concatenation restores it exactly.
  const end = Math.min(offset + length, valueText.length);
  return {
    canonical: report.canonical,
    report_page: {
      format: 'json-text-fragment', offset_unit: 'utf16_code_units', path,
      report_sha256: reportSha, value_sha256: path.length ? digest(valueText) : reportSha,
      offset, next_offset: end < valueText.length ? end : null, total_units: valueText.length,
      json_fragment: valueText.slice(offset, end),
    },
  };
}
