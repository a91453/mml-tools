// Source intake.
//
// Status: IMPLEMENTATION NOTES. Takes the symbolic assets a project holds and
// produces the Source-Faithful Baseline the rest of the pipeline is defined
// against. It parses nothing itself: `ingestMIDI`, `ingestMusicXML`,
// `normalizeMMLSource` and `mergeCanonicalProjects` are the existing adapters,
// and this module only chooses which one an asset kind reaches and files the
// result under a durable identity.
//
// What intake deliberately does not do, because MASTER_RULES.md §3 requires a
// diff-capable Source-Faithful Baseline to exist before any of it is accepted:
// it removes no note, quantizes no source timing, performs no Mobile
// adaptation, assigns no role and emits no Final MML. A baseline that came out
// of an incomplete or unsupported source stays marked that way — the adapters'
// own `sourceComplete`, `warnings` and `unsupported` are carried through
// unchanged, and nothing in this layer can raise them.

import { ASSET_KIND_INTAKE, ERROR_CODES, LIMITS, fail } from './contracts.mjs';
import { sha256Of } from './store.mjs';

const now = () => new Date().toISOString();
const encoder = new TextEncoder();

// Which adapter actually reads the caller's meter map. Only the MML adapter
// does: a MIDI or MusicXML source carries its own meter, and a Canonical IR
// upload is rebuilt through the IR constructors. So the meter is an *intake
// input* for some selections and irrelevant to others, and which one it is has
// to be recorded rather than guessed at by a later reader.
const consumesMeterText = kind => ASSET_KIND_INTAKE[kind]?.adapter === 'mml';

// The Canonical source id a symbolic asset becomes. Derived from the bytes, so
// re-uploading the same file produces the same source, event and project
// identities, and the upload filename never reaches provenance.
const sourceIdFor = (adapter, sha256) => `${adapter}:sha256:${sha256}`;

export function createIntakeService({ canonical, projects, assets, store }) {
  const baselineKey = projectId => `baseline:${projectId}`;

  /** One asset through the adapter its kind names. */
  const ingestOne = (engines, owner, projectId, asset, { meterText = '' } = {}) => {
    const wiring = ASSET_KIND_INTAKE[asset.kind];
    if (!wiring?.intake) {
      fail(ERROR_CODES.UNSUPPORTED_SOURCE, `Asset kind ${asset.kind} is not a symbolic source and cannot be ingested`, { asset_id: asset.asset_id, kind: asset.kind });
    }
    const options = {
      sourceId: sourceIdFor(wiring.adapter, asset.sha256),
      // Deliberately derived from the kind and the digest rather than from the
      // upload filename. The Canonical source label reaches
      // `baselineIdentityOf`, so a filename here would make the baseline
      // identity a function of what the file happened to be called: the same
      // bytes re-uploaded under a different name would mint a different
      // baseline and silently invalidate every decision accepted against the
      // old one. The filename a human reads stays on the asset record, which
      // `baseline.formats` links to by asset_id.
      label: `${asset.kind} sha256:${asset.sha256.slice(0, 16)}`,
      sha256: asset.sha256,
    };

    try {
      if (wiring.adapter === 'midi') {
        const { bytes } = assets.read(owner, projectId, asset.asset_id);
        const fragment = engines.source.ingestMIDI(bytes, { ...options, kind: wiring.canonicalKind, authority: wiring.authority });
        return { project: engines.source.midiFragmentToProject(fragment), fragment, format: 'MIDI' };
      }
      if (wiring.adapter === 'musicxml') {
        const { content } = assets.text(owner, projectId, asset.asset_id);
        const fragment = engines.score.ingestMusicXML(content, { ...options, kind: wiring.canonicalKind, authority: wiring.authority });
        return { project: engines.score.musicXMLFragmentToProject(fragment), fragment, format: 'MusicXML' };
      }
      if (wiring.adapter === 'mml') {
        const { content } = assets.text(owner, projectId, asset.asset_id);
        // The meter map is source-confirmed information a caller supplies; the
        // MML adapter refuses to assume one, and neither does this layer.
        const fragment = engines.canonicalize.normalizeMMLSource(content, { ...options, kind: wiring.canonicalKind, authority: wiring.authority, meterText });
        return { project: engines.canonicalize.mmlFragmentToProject(fragment), fragment, format: 'MML' };
      }
      // A Canonical IR upload is rebuilt with the IR constructors rather than
      // trusted as JSON, so an imported project cannot assert a completeness,
      // a gate result or an event the schema would not accept.
      const { content } = assets.text(owner, projectId, asset.asset_id);
      return { project: rebuildCanonicalProject(engines, content), fragment: null, format: 'Canonical IR' };
    } catch (error) {
      if (error?.code && error?.name === 'StudioApplicationError') throw error;
      return fail(ERROR_CODES.UNSUPPORTED_SOURCE, `Source intake failed for asset ${asset.asset_id}: ${error?.message ?? 'unreadable source'}`, { asset_id: asset.asset_id, kind: asset.kind });
    }
  };

  // Metadata keys that `final/readiness.mjs` reads as evidence a gate passed.
  // An uploaded or restored Canonical IR is data, including any PASS flags it
  // carries: a file that asserts its own source completeness, its own audio
  // evidence, its own baseline snapshot or its own G11-D revision would hand a
  // gate a result nobody recomputed. They are dropped on the way in, exactly as
  // `applyAcceptedArrangement` drops them on the way forward.
  const IMPORTED_GATE_EVIDENCE_KEYS = Object.freeze(['sourceComplete', 'audioAlignmentEvidence', 'sourceFaithfulBaseline', 'g11d']);

  const rebuildCanonicalProject = (engines, text, { trusted = false } = {}) => {
    const value = JSON.parse(text);
    const { createSource, createCanonicalNoteEvent, createCanonicalRestEvent, createCanonicalTempoEvent, createCanonicalMeterEvent, createCanonicalProject, createArbitrationDecision } = engines.canonical;
    if (value?.schema !== engines.arrangement.CANONICAL_PROJECT_SCHEMA) throw Error(`unsupported Canonical IR schema: ${value?.schema}`);
    const events = (value.events ?? []).map(event => {
      if (event.kind === 'note') return createCanonicalNoteEvent(event);
      if (event.kind === 'rest') return createCanonicalRestEvent(event);
      throw Error(`unsupported Canonical event kind: ${event.kind}`);
    });
    const metadata = { ...(value.metadata ?? {}) };
    if (!trusted) for (const key of IMPORTED_GATE_EVIDENCE_KEYS) delete metadata[key];
    return createCanonicalProject({
      ...value,
      metadata,
      sources: (value.sources ?? []).map(createSource),
      events,
      tempoEvents: (value.tempoEvents ?? []).map(createCanonicalTempoEvent),
      meterEvents: (value.meterEvents ?? []).map(createCanonicalMeterEvent),
      decisions: (value.decisions ?? []).map(createArbitrationDecision),
    });
  };

  return Object.freeze({
    /**
     * Build the Source-Faithful Baseline from the project's symbolic assets.
     *
     * `assetIds` selects which assets participate; omitting it uses every
     * symbolic asset the project holds, in upload order. Several symbolic
     * sources are combined by the existing `mergeCanonicalProjects`, which
     * keeps the sources and events separate and recomputes `sourceComplete`
     * itself — a merge of incomplete inputs cannot present itself as complete.
     */
    async run(owner, projectId, { assetIds = null, meterText = '' } = {}) {
      // Checked by shape here, before the Canonical engines are loaded, because
      // a selection that is not a list of asset ids is a malformed request and
      // has to be reported as one. Left unchecked it reaches `.map` further
      // down and raises a TypeError, which a transport can only render as an
      // internal failure — telling a caller the server broke when it was the
      // request that was wrong. The MCP surface already refuses it through its
      // declared schema; this is the same refusal for every other caller, and
      // it belongs here rather than in a transport so that direct callers and
      // any future transport inherit it.
      if (assetIds !== null && !Array.isArray(assetIds)) {
        fail(ERROR_CODES.INVALID_REQUEST, 'asset_ids must be an array of asset ids, or omitted to ingest every symbolic asset in the project.', { received: typeof assetIds });
      }
      // A project cannot hold more assets than this, so a longer selection can
      // never resolve and is refused before it can drive a lookup per entry.
      if (assetIds !== null && assetIds.length > LIMITS.maxAssetsPerProject) {
        fail(ERROR_CODES.INVALID_REQUEST, `asset_ids is limited to ${LIMITS.maxAssetsPerProject} entries.`, { received: assetIds.length, max: LIMITS.maxAssetsPerProject });
      }
      const engines = await canonical.engines();
      const record = projects.load(owner, projectId);

      const selected = assetIds === null
        ? record.assets.filter(asset => ASSET_KIND_INTAKE[asset.kind]?.intake)
        : assetIds.map(assetId => assets.find(record, assetId));
      if (!selected.length) {
        fail(ERROR_CODES.SOURCE_INCOMPLETE, 'This project holds no symbolic source asset to ingest.', { project_id: record.project_id });
      }

      const ingested = selected.map(asset => ({ asset, ...ingestOne(engines, owner, record.project_id, asset, { meterText }) }));
      const project = ingested.length === 1
        ? ingested[0].project
        : engines.merge.mergeCanonicalProjects(ingested.map(entry => entry.project), { id: `${record.project_id}:baseline`, title: record.title });

      const identity = engines.arrangement.baselineIdentityOf(project);
      const baseline = {
        baseline_id: `bas:${identity.contentDigest}`,
        project_id: record.project_id,
        created_at: now(),
        asset_ids: selected.map(asset => asset.asset_id),
        canonical_project_id: project.id,
        event_count: identity.eventCount,
        note_event_count: identity.noteEventCount,
        source_identity_digest: identity.sourceIdentityDigest,
        event_id_digest: identity.eventIdDigest,
        // The adapters' own verdict, carried unchanged. Nothing here can raise
        // it, and a later review cannot substitute for it.
        source_complete: project.metadata?.sourceComplete === true,
        incomplete_inputs: [...(project.metadata?.incompleteInputs ?? [])],
        formats: ingested.map(entry => ({ asset_id: entry.asset.asset_id, kind: entry.asset.kind, format: entry.format })),
        // Implementer provenance: which inputs this baseline was actually built
        // from, beyond the asset ids. It is recorded because the meter map is an
        // intake input for an MML source — `normalizeMMLSource` parses against
        // it — so a baseline built under one meter is not the baseline a caller
        // asking for another meter means, and nothing else on this record could
        // tell the two apart. `meter_text_sha256` is null when no selected
        // adapter read the meter at all, which is the honest way to say
        // "irrelevant here" rather than "empty". This is provenance about an
        // implementation input; it defines no Canonical rule and grades nothing.
        intake_inputs: {
          meter_text_sha256: selected.some(asset => consumesMeterText(asset.kind))
            ? sha256Of(encoder.encode(meterText))
            : null,
          meter_text_consumed_by: selected.filter(asset => consumesMeterText(asset.kind)).map(asset => asset.asset_id),
          notice: 'Implementer provenance for the inputs this baseline was built from. meter_text_sha256 is null when no selected source adapter reads a meter map.',
        },
        warnings: summarize(project.metadata?.warnings ?? []),
        unsupported: summarize(project.metadata?.unsupported ?? []),
      };

      store.putJson(baselineKey(record.project_id), project);
      // A new baseline invalidates every candidate derived from the old one:
      // those candidates describe sources that are no longer the project's.
      projects.save({ ...record, baseline, candidates: [], audio_evidence: [] });

      return { baseline: Object.freeze(baseline), project };
    },

    /** The stored baseline project, rebuilt through the IR constructors. */
    async project(owner, projectId) {
      const engines = await canonical.engines();
      const record = projects.load(owner, projectId);
      if (!record.baseline) {
        fail(ERROR_CODES.SOURCE_INCOMPLETE, 'This project has no Source-Faithful Baseline yet; run intake first.', { project_id: record.project_id });
      }
      const stored = store.getJson(baselineKey(record.project_id));
      if (!stored) fail(ERROR_CODES.SOURCE_INCOMPLETE, 'The stored Source-Faithful Baseline is no longer available; run intake again.', { project_id: record.project_id });
      // Read back as trusted: this is the project this service wrote itself,
      // and its identity is re-checked against the recorded digest below.
      const project = rebuildCanonicalProject(engines, JSON.stringify(stored), { trusted: true });
      // Content-addressed, so a baseline whose stored bytes changed under us no
      // longer answers to the id the record names.
      const identity = engines.arrangement.baselineIdentityOf(project);
      if (`bas:${identity.contentDigest}` !== record.baseline.baseline_id) {
        fail(ERROR_CODES.SOURCE_INCOMPLETE, 'The stored baseline does not match its recorded identity; run intake again.', { project_id: record.project_id, baseline_id: record.baseline.baseline_id });
      }
      return { record, baseline: record.baseline, project };
    },
  });
}

// Diagnostics are reported as counts by code rather than as a full list: the
// list is evidence for a human in the Studio, and a model does not need every
// instance to decide what to do next.
function summarize(items) {
  const counts = {};
  for (const item of items) {
    const code = typeof item === 'string' ? item : (item?.code ?? 'UNKNOWN');
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}
