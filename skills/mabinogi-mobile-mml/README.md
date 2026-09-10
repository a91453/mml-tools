# mabinogi-mobile-mml rule sources

This directory stores GitHub-side normative rule extensions for the user's Mabinogi Mobile MML workflow.

Important: the `mml-tools` repository previously did **not** contain the installed ChatGPT `mabinogi-mobile-mml` SKILL or its complete `references/master-rules.md`; the repository README explicitly described the workbench as independent from that installed skill.

Therefore:
- files in `patches/` are merge-ready SKILL-level rules;
- files in `references/` are merge-ready Master Rules extensions;
- these files are the version-controlled source for future automated review/merge;
- they must not be treated as proof that an external/installed ChatGPT skill package has already been overwritten.

Current normative addition:
- `patches/2026-09-10-lead-role.md`
- `references/2026-09-10-lead-role-master-rules.md`

Core safeguard: `T1 = Lead Role`, not `Vocal-only`; neither `highest Piano note -> Vocal` nor `not proven Vocal -> Inner/Harmony` is valid without positive source-role evidence.
