# Audio evidence revision repair checkpoint

Status: WIP IMPLEMENTATION PLAN, not Canonical and not a song acceptance.

## Published identities loaded first

- Published main / implementation base: `2399db11347198ce6cdaf7463c35a53abf929d87`
- Canonical: `2026-09-13-v1`
- Manifest: `2026-09-13-v1-manifest1`
- Rules snapshot: `0a172900a01fdf39c2e9e84cf176961320b779ea`
- Manifest addition commit observed from the deployed loader: `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14`
- This branch is unpublished working code. Do not load its HEAD as a rules snapshot.

## Reproduced problem and intended repair

`attachAudioAlignment` rejects a second alignment for the same recording and candidate. A low-quality computed report is preserved correctly, but cannot be revised in place with an auditable, explicitly authorized replacement. Re-uploading identical audio or making a no-op musical candidate is not an acceptable workaround.

Repair requirements:

- Keep every original report and its original metrics/warnings.
- Bind replacement to the exact candidate, audio SHA and current report SHA; stale/ambiguous replacement is refused.
- Require an explicit replacement reason and actor declaration, kept separate from authenticated owner.
- Provide a read-only way to export current and superseded reports.
- Recompute readiness from the active report through the existing audio engine; never adjust confidence/coverage thresholds or set a gate by declaration.
- Retry identical input safely; failed or conflicting writes cannot erase the previous report.
- Retain legacy report compatibility and test both HTTP and MCP paths.

## Scope boundaries

No Canonical changes, no #58 publication, no model-provider dependency, no audio source upload to GitHub, no production deployment, no fabricated listening/Lead/Core3/in-game PASS.

The real song still has an unresolved computed alignment (confidence approximately 0.4563), and exploratory repeated-section/tail matching is not confirmed musical evidence. Repairing persistence does not solve those musical questions by itself.

## Execution note

This conversation's local container cannot resolve GitHub and has no authenticated git checkout. Remote branch/checkpoints are saved through the authorized GitHub connector. Any local tests must state their scope; full repository results must come from a real GitHub Actions checkout. No local full-CI claim is made by this checkpoint.
