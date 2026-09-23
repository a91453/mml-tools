// Worker-thread entry for the audio prescreen: rendering, calibration and
// signal analysis, off the service's event loop. One job at a time per worker;
// the pool (render-pool.mjs) schedules them.
import { parentPort } from 'node:worker_threads';
import { calibrate, loadBank, renderAnalysis } from './renderer-core.mjs';
import { barSeconds, clippingByBar, featuresBySpan, maskingByBar, roughnessByBar, smearByBar } from './metrics.mjs';
import { recordingFeatures } from './original.mjs';

async function analyze({ bankSha256, bankBytes, performance, profiles, bars, reference, sampleRate, channels, window, returnPcm }) {
  const bank = await loadBank(bankSha256, bankBytes);
  const render = await renderAnalysis({ bank, performance, sampleRate, channels, window, returnPcm });
  const { analysis } = render;
  const roughness = roughnessByBar(performance, profiles, bars, reference);
  const smear = smearByBar(performance, profiles, bars);
  const masking = maskingByBar(performance, analysis, bars, render.startSec);
  const clipping = clippingByBar(performance, analysis, bars, render.startSec);
  const features = featuresBySpan(analysis, barSeconds(performance, bars), render.startSec);
  return {
    render: {
      renderer: render.renderer,
      engine: render.engine,
      sample_rate: render.sampleRate,
      channels: render.channels,
      start_seconds: render.startSec,
      frames: render.frames,
      pcm_sha256: render.pcmSha256,
      peak: render.peak,
      clipped_samples: render.clippedSamples,
    },
    pcm: render.pcm,
    bars: bars.map((bar, index) => ({
      bar: bar.bar,
      roughness: roughness[index],
      smear: smear[index],
      masking: masking[index],
      clipping: clipping[index],
      features: features[index],
    })),
  };
}

parentPort.on('message', async ({ id, type, payload }) => {
  try {
    let result;
    if (type === 'calibrate') {
      const bank = await loadBank(payload.bankSha256, payload.bankBytes);
      result = await calibrate({ bank, sampleRate: payload.sampleRate, voices: payload.voices });
    } else if (type === 'analyze') {
      result = await analyze(payload);
    } else if (type === 'original') {
      result = recordingFeatures(payload.mono, payload.sampleRate, payload.spans);
    } else {
      throw Error(`unknown job type ${type}`);
    }
    parentPort.postMessage({ id, ok: true, result }, result?.pcm ? [result.pcm.buffer] : []);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { message: String(error?.message ?? error).slice(0, 500) } });
  }
});
