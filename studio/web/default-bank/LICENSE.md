# Default preview bank: licence and notices

The Studio Web's free default preview bank is a subset of
`FluidR3Mono_GM.sf3` version 2.312 (5 December 2016), as distributed with
MuseScore 2.3.2 (`share/sound/FluidR3Mono_GM.sf3`). It keeps only the presets
the Studio Web preview maps instruments to (GM programs 0, 10, 13, 24, 25, 40,
46, 71, 73 and drum-kit notes 35, 36, 49, 57 of the Standard kit); the kept
Ogg Vorbis sample data is copied unchanged.

Neither that file nor the subset is stored in this repository or shipped in
the Studio Web build. The first time a playback on a device needs the default
bank, the browser downloads the upstream file from its original source (the
URL in `provenance.json`), checks its SHA-256, derives the subset with
`studio/web/preview/default-bank-trim.mjs` and checks the subset's SHA-256.
Only the subset is kept, and only in that browser. Both digests are in
`provenance.json`; `scripts/build-default-soundbank.mjs` reproduces the subset
in Node from a local copy of the upstream file.

It is used only as a free, generic, approximate preview sound. It is not the
game's sound and not evidence of how anything sounds in game.

The upstream licence file (`share/sound/FluidR3Mono_License.md` at MuseScore
tag v2.3.2, SHA-256
`09926f9451f751408abd65162c99343f840234d2a708584808fd46427633063f`) follows
verbatim, converted from ISO-8859-1 with CRLF line endings to UTF-8 with LF.
Its acknowledgements and copyright notices apply to the subset.

Note: the sound bank's own INFO comment field (carried unchanged in the
subset) contains the sentence "DO NOT REDISTRIBUTE ANY OF THESE SAMPLES"
beside the mono version's copyright line. That is why this repository and
the Studio Web do not redistribute the bank or any part of it. The licence
file below, from the same authors' distribution, releases the mono version
under the MIT licence.

---

FluidR3Mono_GM.sf3
---

Current version: 2.312 5th December 2016

Original Stereo version by Frank Wen Copyright © 2000-2002

Mono version by Michael Cowgill Copyright © 2014-16

Temple Blocks instrument provided by Ethan Winer Copyright © 2002

Drumline Percussion provided by Michael Schorsch Copyright © 2016

This Mono version of FluidR3 GM is released under the MIT license as described in COPYING

The COPYING and README files from the original FluidR3GM file are now displayed here for reference.

The acknowledgements and copyright notices above should be included in any derivative work.


README
---

Fluid (R3) SoundFont

Copyright (c) 2000-2002, 2008 Frank Wen <getfrank@gmail.com>

I hereby release Fluid under the MIT license, as described in COPYING.


Thanks to Toby Smithe for helping to get Fluid included in Ubuntu.

This package, of course, is the original Release 3 of Fluid.  


Fluid was constructed in part from samples found in the public domain that I
edited/cleaned/remixed/programmed and largely from recordings of my own and
in conjunction with the people below who helped along the way:

Suren M. Seron
Scott Hanan
Steve Aupperle
Chris Gillman
Alex Taubr
Chris Prola
Andrew Klenk
Winfried Hubbe 
Dylan
Tim
Gort
Uros Katic 
Ethan Winer (http://www.ethanwiner.com) 


It's obviously been a few years since the project, but its nice to see that
people are still enjoying my work and getting good use out of it.  As always,
I'd like to hear some work done with Fluid so email me, or just email me to
say hello and tell me what is going on in the computer musician world.
Who knows, maybe I'll kick start this project again? ;)


COPYING
---

Mono version:  Copyright (c) 2014-16 Michael Cowgill 
Copyright (c) 2000-2002, 2008 Frank Wen <getfrank@gmail.com>

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
