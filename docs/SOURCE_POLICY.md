# Source Policy

Version: 2026-09-13-draft1
Status: CANONICAL CANDIDATE

This document defines what each source is allowed to prove. Sources are complementary, not interchangeable.

## 1. Source classes

### A. Official / authoritative symbolic sources
Examples: official score, official MusicXML, trusted official MIDI.

Primary authority for:
- pitch identity;
- onset and duration;
- written voicing;
- staff/voice placement;
- meter and written tempo indications;
- repeats/navigation when explicitly represented;
- lyrics alignment, notation-level phrasing and accents when available.

Must NOT be overclaimed as proof of final-recording mix prominence or timbre by itself.

### B. Original official audio
Primary authority for:
- actual foreground/background role;
- audible arrangement identity;
- prominence;
- sustain/articulation;
- recording structure;
- practical register impression;
- tempo drift / performance timing evidence.

Must NOT be used alone to invent exact isolated pitch truth when dense mixing prevents reliable separation.

### C. Third-party score / MIDI / MML
Supporting arrangement evidence only unless independently confirmed.

Useful for:
- candidate voicing ideas;
- omitted inner voices;
- alternative role allocation;
- comparison against community conventions.

It does not automatically override official symbolic or original-audio evidence.

### D. Existing project MML / accepted prior versions
Historical evidence and regression baseline.

An accepted version is strong evidence of practical success, but it is not proof that every note/role is source-perfect. A newer candidate must still explain meaningful drift.

### E. In-game evidence
User-provided game behavior, screenshots, error text, or controlled A/B are authoritative for the tested client/version and exact condition.

In-game evidence may establish practical engine behavior, but must not silently overwrite source truth. Example: moving a note for audibility can be a Mobile adaptation while the original source role remains documented.

### F. Community works / guides
Evidence class: `COMMUNITY_VERIFIED`, not official specification.

Use to demonstrate real-world parser/arrangement practice and identify hypotheses worth testing. Multiple independent successful examples increase confidence, but community usage does not prove universal engine guarantees.

## 2. Required source separation

Keep symbolic truth and audio truth as separate evidence fields. Do not collapse them into a single confidence score that can hide disagreement.

When sources disagree, record:
- exact source IDs;
- event/section involved;
- type of disagreement;
- which claim each source can legitimately support;
- arbitration decision or `PENDING`.

## 3. Source-complete preservation

Before reduction to six tracks, preserve all musically important source roles. Early deletion is forbidden when it would make later arbitration impossible.

The Source-Faithful Baseline should retain traceable IDs for important Lead, harmony, bass, counter, texture and form events.

## 4. Lead-role arbitration

Lead demotion requires positive evidence. `Not proven Vocal` is not positive evidence.

For a Lead move, inspect:
1. source identity;
2. section role;
3. score-role evidence when available;
4. audio-role evidence when usable;
5. continuity after the move;
6. Core3 integrity;
7. explicit positive reason for the destination role.

Conflicting evidence remains `PENDING`; preserve the source-faithful Lead until resolved.

## 5. Cross-source harmony arbitration

A source reference proves provenance, not compatibility.

Every meaningful cross-source conflict must be explainable as one of:
- keep;
- omit;
- move role;
- change octave/register for Mobile adaptation;
- redistribute between Core3 and enrichment;
- remain `PENDING`.

The report must state why.

## 6. Audio analysis tools

Audio alignment/chroma/DTW/correlation/onset metrics are evidence locators, not identity labels. They may identify likely problem windows and tempo drift, but cannot alone prove Vocal identity, exact pitch, octave, or role.

Audio workers must not mutate symbolic source events.

## 7. Version alignment

Before any full-song comparison, confirm recording version, start offset, effective music range, meter/form and tempo behavior. Live, album, MV, remaster and cover versions must not be mixed silently.

## 8. Tool evidence

MuScriptor, Mobibard, mml.mabi.tw, MabiIcco, 3MLE, Midify and other editors/converters produce candidates, not authority.

A tool's parse/export/play success is not equivalent to source correctness or in-game acceptance.
