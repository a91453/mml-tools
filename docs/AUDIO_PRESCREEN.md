# Audio prescreen (音色 A/B 預篩)

Status: IMPLEMENTATION NOTES. Not a Canonical rule source. The prescreen is
machine evidence only: it never sets Gate 7 (original-audio evidence), Gate 6
player readback or `in_game`, and it selects, accepts and applies nothing. The
free GM bank it renders with is not the game timbre.

Owner's principle: 「譬如要做決策明顯的時候 不明顯再給人工」 — when a choice
between alternatives is obvious the machine may decide; when it is not, the
owner listens. 「機器能判定的缺陷照擋；需要人判斷給我mml試聽」.

The prescreen is the "is it obvious?" half. Whether an obvious verdict may be
*applied* is a Canonical question; the draft amendment that would allow it is
[`canonical-candidates/MACHINE_PRESCREEN_SELECTION.md`](canonical-candidates/MACHINE_PRESCREEN_SELECTION.md)
(unpublished). Until the owner publishes it, nothing applies a verdict.

## What it does

1. Resolves 2–4 alternatives: raw six-role MML texts (parsed by Studio's own
   parser in ingest mode), or a project's candidates and Final artifacts.
2. Renders each with `spessasynth_core` in a worker thread: effects off, fixed
   256-sample blocks, notes at exact sample positions, each role on its own MIDI
   channel (a drum instrument makes its channel a GM drum channel), 22.05 or
   44.1 kHz, mono or stereo. The same MML, bank and settings give the same PCM
   (`pcm_sha256` in the report).
3. Measures every bar of the meter map (see below), compares the alternatives
   bar by bar, and merges equal verdicts into regions.
4. Returns a report: `schema: mml-studio/audio-prescreen-report@1`, per-bar and
   per-region verdicts, winners, margins, every metric's numbers, each
   alternative's MML SHA-256 (null for a candidate, which has no MML yet; its
   `performance_sha256` names what was played), the bank identity, the renderer
   and calibration identity, the thresholds id, and `human_review`. The
   `report_id` is `aps:` + the SHA-256 of the report body, so identical inputs,
   bank, renderer and thresholds give the identical id.

## Instruments

`studio/backend/audio/instruments.mjs` is the shared table (equivalent to the
Studio Web preview picker's): Lute 24, Mandolin 25, Chalumeau 71, Xylophone 13,
Flute 73, Violin 40, Piano 0, Harp 46, Music Box 10 (0-based GM programs);
BassDrum GM drum note 35 (36 kept), Cymbals 49 (57 kept). Every note of a drum
role sounds as its drum note. V0–V15 map to velocity `max(1, round(v·127/15))`,
the preview's curve. Default: Lute on every role.

## Sound bank

`FluidR3Mono_GM.sf3` (MIT) from the pinned MuseScore v2.3.2 URL, SHA-256
`cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2`, 14,563,174
bytes. It is never stored in the repository or the image. The service downloads
it on first need, verifies size and SHA-256, and caches it as
`<data dir>/audio-banks/<sha256>.sf3` (data dir: the Application Service's
directory, else `MML_STUDIO_DATA_DIR`, else `/data`; a directory inside the
repository is never used). Every load re-verifies the cache. Failures are
refused, not approximated: `AUDIO_BANK_UNAVAILABLE` (reason
`DOWNLOAD_DISABLED`, `DOWNLOAD_FAILED`, `NO_DOWNLOADER`) or
`AUDIO_BANK_HASH_MISMATCH` (reason `SHA256_MISMATCH` or `SIZE_MISMATCH`).
`MML_STUDIO_AUDIO_BANK_FETCH=0` turns downloading off (pre-seed the cache
file instead). This is the service's only outbound request; it sends no project
data. Tests inject a synthetic in-memory bank and never touch the network.

## Metrics

All metrics are per bar, deterministic, and lower is better.

**Calibration.** Roughness and smear use a note-level model whose numbers are
measured, not assumed: for each voice the alternatives use, single notes are
rendered with the same bank and engine at MIDI 24, 36, …, 96 (the drum note for
a drum) and velocity 127, held 1 s. From each: level (peak 20 ms RMS), held
decay time constant (log-RMS slope; none for a sustaining voice), release time
constant (log-RMS slope after note-off) and the first eight harmonic partial
amplitudes (FFT peaks at k·f0). Sixteen more renders give the V0–V15 gain
curve. Values between anchors are interpolated. The profile digest is
`renderer.calibration.sha256`.

| Metric | Definition | Unit |
| --- | --- | --- |
| `roughness` | Sensory dissonance of every pair of sounding pitched notes (any roles, including a released note's tail against a later note), by Sethares' fit of the Plomp–Levelt curve over the modelled partials, `Σ min(a_i, a_j)·d(Δf)`, sampled every 50 ms, averaged over the bar. Only pairs whose lower note is ≤ MIDI 71 (B4) count; higher pairs are reported as `high`. **Source-inherited pairs are excluded**: a pair both of whose attacks (pitch, onset within 1/32 beat) exist in the source reference, overlapping there, is reported as `inherited_low_mid` and subtracted. Each bar lists its strongest pairs (`notes`, `interval`, `value`, `share`, `source_inherited`), e.g. `Chord1:A3@4 / Chord2:A#2@4 M7`. | amplitude (a sustained pair of equal full-scale pure tones at the roughest spacing = 1) |
| `masking` | From the rendered per-role signals: in each ~93 ms frame, a role that holds a note is audible in a third-octave band when its band energy is at most 6 dB below all other roles' energy in that band; its frame audibility is the share of its own energy in such bands. Per bar: `Σ weight·max(0, 0.5 − audibility)/0.5` over roles holding a note (Melody weight 2, others 1). Per-role audibility is reported. | weighted shortfall; 0 = every playing role audible |
| `smear` | For every pitched attack, the modelled energy of already-released notes' tails (any role) in the 100 ms after it, relative to the attack's own energy there; weight 0 for the same pitch (a re-strike does not blur), 1 within an octave, 0.5 beyond, 0.25 for a drum tail. Bar value = mean over its attacks; the worst attack and its strongest tail are reported. | energy ratio |
| `clipping` | Milliseconds of the rendered stereo mix at \|x\| ≥ 0.999 (at the synthesizer's fixed gain, never normalized); `peak_dbfs` reported beside it. | ms |
| `original_similarity` | Only when the project holds the original recording **and** an active audio-alignment report for one of the alternatives' candidates. The alignment's beat↔seconds control points map each bar to the recording (never extrapolated). Value = `1 − (0.5·chroma cosine + 0.5·(onset-envelope correlation + 1)/2)` between the rendered mix and the recording. Node has no decoder for compressed audio here, so only uncompressed WAV (PCM 8/16/24/32-bit, float 32/64) is read; anything else, and a report with alignment warnings, is `ORIGINAL_AUDIO_METRIC_UNAVAILABLE`. No dependency was added. | dissimilarity 0–1 |

**Source fidelity** (not a sound metric; a guard). Per bar, the event-level
changes an alternative makes against the source reference: `omitted`, `added`,
`pitch_changed` (same onset/role), `onset_changed` (same pitch, within a beat),
`duration_changed` (> 1/16 beat), `role_moved`, `volume_changed`, one point
each. Differences finer than the Final grid are not counted. The reference is
the project's Source-Faithful Baseline, or `reference.candidate_id` (an
accepted candidate), or, without a project, `reference.mml`.

## Decision rule

Per bar, over the alternatives' values of each metric (thresholds below):

- *decisive*: runner-up − best ≥ `max(margin_abs, margin_rel × runner-up)`;
- *neutral*: worst − best ≤ `max(tolerance_abs, tolerance_rel × worst)`;
- *within tolerance*: value − best ≤ `max(tolerance_abs, tolerance_rel × value)`.

**OBVIOUS** only when at least one metric is decisive, every decisive metric
names the same winner, the winner is within tolerance on every other metric,
every applicable metric was measured, and the winner's source-fidelity
distance is the smallest (ties allowed). Otherwise **NEEDS_HUMAN** with its
reasons:

| Reason | Meaning |
| --- | --- |
| `METRICS_CONFLICT` | decisive metrics name different winners, or the winner is worse than the best beyond tolerance on another metric |
| `MARGIN_TOO_SMALL` | the metrics that separate the alternatives do not separate the best two by their margins |
| `NO_MACHINE_PREFERENCE` | every metric is neutral, but the alternatives differ |
| `METRIC_UNAVAILABLE` | an applicable metric could not be measured (e.g. `original_similarity` for an MP3, or a bar outside the alignment) |
| `SOURCE_FIDELITY_TRADEOFF` | the sound winner departs further from the source than another alternative: sound alone never outranks the source |
| `SOURCE_FIDELITY_UNAVAILABLE` | no reference, and the alternatives differ symbolically in the bar |

**NO_DIFFERENCE**: the alternatives have the same notes and instruments in the
bar. When they have the same notes but different instruments, source fidelity
is equal by construction and the sound metrics decide.

`category` of an OBVIOUS bar is its decisive metrics joined by `+` (e.g.
`roughness+smear`); shadow mode reports agreement per category.

Default thresholds (`thresholds` input overrides any field; the full set is
hashed into `thresholds.id`, `apt:<sha256>`, which is part of the report body,
so a threshold change changes the report id):

| Metric | margin_abs | margin_rel | tolerance_abs | tolerance_rel |
| --- | --- | --- | --- | --- |
| roughness | 0.004 | 0.35 | 0.0015 | 0.15 |
| masking | 0.4 | 0.35 | 0.15 | 0.15 |
| smear | 0.15 | 0.35 | 0.05 | 0.15 |
| clipping | 1 ms | 0.5 | 0.25 ms | 0.1 |
| original_similarity | 0.06 | 0.25 | 0.03 | 0.1 |

The defaults are a starting point, not a finding: shadow mode (below) exists to
measure how often the owner agrees with them.

Examples (synthetic MML, generated in the tests):

- Two alternatives, one with a low major seventh (Chord2 a semitone up against
  Chord1's root) in alternate bars, reference = the other: those bars are
  OBVIOUS for the clean one (`category: roughness`), the rest NO_DIFFERENCE.
- The same, but the "winner" also thins Chord3–Chord5: the thin version sounds
  smoother but omits source events, so the bars are NEEDS_HUMAN
  (`SOURCE_FIDELITY_TRADEOFF`), and `human_review` offers the two
  non-dominated versions.
- A metric whose best two are close while a third is clearly worse:
  NEEDS_HUMAN (`MARGIN_TOO_SMALL`), A/B of the two close ones.
- A project whose recording is an MP3 with an active alignment:
  `original_audio.status = ORIGINAL_AUDIO_METRIC_UNAVAILABLE`, and every bar
  that differs is NEEDS_HUMAN (`METRIC_UNAVAILABLE`).

`human_review` lists each NEEDS_HUMAN region with its bars, beats, reasons and
the alternatives to A/B. Its `listen_link` field is `null`: the hook for a
listen-link payload. The Studio Web listen-link format
(`studio/web/listen-link.mjs`, `mml-studio/listen-link@1`: `mml`,
`compare_mml`, `meter_text`, `start.bar`, `markers`) can carry exactly these
fields; producing it from the prescreen is not wired in this build.

## Shadow mode

A project's calibration record (`mml-studio/audio-prescreen-shadow@1`, in the
service store, never the repository) holds predictions the caller recorded
(`studio_prescreen_shadow_record` `entry: prediction`, recomputed by the
service) and the owner's actual choice per predicted region (`entry:
owner_choice`, `accepted_by` required; a later choice for the same region
supersedes an earlier one, and both are kept). Reading it
(`studio_audio_prescreen` with only `project_id`, or `GET …/audio-prescreen/shadow`)
returns agreement per metric (regions where the metric named a winner) and per
OBVIOUS category, with counts and rates. The draft rule recommends publishing
auto-apply only for categories with at least 30 owner choices and at least 95%
agreement; the read reports which categories meet that bar. Meeting it enables
nothing.

## Surfaces

| MCP | HTTP | Operation | Writes |
| --- | --- | --- | --- |
| `studio_audio_prescreen` (MML alternatives, no project) | `POST /api/v1/audio-prescreen` | `audioPrescreen` | nothing |
| `studio_audio_prescreen` (with `project_id`) | `POST /api/v1/projects/:id/audio-prescreen` | `audioPrescreen` | nothing |
| `studio_audio_prescreen` (only `project_id`) | `GET /api/v1/projects/:id/audio-prescreen/shadow` | `prescreenShadowStatus` | nothing |
| `studio_prescreen_shadow_record` | `POST /api/v1/projects/:id/audio-prescreen/shadow` | `recordPrescreenShadow` | the shadow record only |

Input: `alternatives` (2–4; each exactly one of `mml`, `candidate_id`,
`artifact_id`; optional `label`, `instruments`), `meter_text` (required with MML
alternatives; never assumed), `pickup`, `instruments` (six ids), `bar_range`
(`{from, to}`), `reference` (`{mml}` or `{candidate_id}`), `thresholds`,
`render` (`{sample_rate: 22050|44100, channels: 1|2}`). MCP limits each MML to
16,384 characters (a full Final is at most 6 × 2,400); HTTP accepts the parser's
40,000. Long lists in an MCP response are summarized by the usual response
compaction and read in full with `report_page`; a prescreen report is cached in
memory, so a page read does not re-render.

## Cost

Measured on a synthetic 220 s six-role song (110 bars, T120, 4/4), three
alternatives, 22.05 kHz mono, on the 4-core development container used for this change (Node 22):

| Bank | Workers | Wall | CPU (all threads) |
| --- | --- | --- | --- |
| synthetic test bank | 3 | 4.9 s | 12.2 s |
| synthetic test bank | 1 | 11.6 s | 12.2 s |
| FluidR3Mono (cached) | 3 | 6.9 s | 16.4 s |
| FluidR3Mono (cached) | 1 | 15.2 s | 16.0 s |

The render pool uses up to `min(4, cores − 1)` worker threads; each worker
starts on first use and stops after 30 s idle. `bar_range` narrows the work.
