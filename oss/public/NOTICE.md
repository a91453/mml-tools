# Notice

This repository is a public software/tooling export. It intentionally excludes private operational material and song-specific source packages.

The MIT License covers code and project-authored documentation included in this repository. It does not grant rights to third-party trademarks, game assets, commercial recordings, published score scans, or other material owned by third parties.

Mabinogi and related names are the property of their respective owners. This project is an independent community/developer tool and is not affiliated with or endorsed by Nexon.

Synthetic fixtures in the test suite are created for regression testing. Commercial song audio, score PDFs, third-party MIDI files, and user song packages must not be added to this repository unless redistribution rights are clear and documented.

## Third-party components

The Studio Web build vendors SpessaSynth (`spessasynth_lib` and `spessasynth_core`, Apache License 2.0) from the pinned npm packages at build time for the optional timbre preview. The build ships their license as the header of `vendor/spessasynth/lib.js` (with SPDX pointers in the other vendored files). The vendored code is not covered by the MIT License of this repository.

No sound bank is distributed, in this repository or in the Studio Web build. The optional free default preview sound (labelled 「免費通用音色（近似），不是遊戲音色」) is a subset of FluidR3Mono_GM.sf3 2.312 (Frank Wen; mono version by Michael Cowgill; MIT License) that each browser derives for itself at runtime: the first time a playback needs it, the browser downloads the file from its upstream (MuseScore 2.3.2 on GitHub), checks its SHA-256, trims it and checks the subset's SHA-256, and keeps only the subset, only in that browser. The upstream licence and acknowledgements are in `studio/web/default-bank/LICENSE.md`; the pinned source and both digests are in `studio/web/default-bank/provenance.json`. It is a free, generic, approximate preview sound, not the game's sound. A DLS/SF2/SF3 file that a user selects locally takes precedence; that file stays in that browser and is never uploaded or included in a project export.
