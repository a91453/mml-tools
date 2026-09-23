// The Published Canonical releases this implementation opts into.
//
// MASTER_RULES §12: an implementation follows a published rule; it never
// relabels itself into a newer release by reading a newer Manifest. A release
// is added here only in the reviewed change that implements its prose, and the
// loader refuses to load any published release that is not listed.
//
//   2026-09-13-v1  the first published release.
//   2026-09-23-v2  machine delivery (ACCEPTANCE_CRITERIA "Machine delivery").
//                  Its other rules are unchanged from v1, so the same policy
//                  values implement both. `AUTOMATED_VALIDATED` becomes
//                  authoritative only when the published Manifest also declares
//                  the machine-delivery schema (final/delivery-evaluator.mjs).
export const SUPPORTED_CANONICAL_VERSIONS = Object.freeze(['2026-09-13-v1', '2026-09-23-v2']);
