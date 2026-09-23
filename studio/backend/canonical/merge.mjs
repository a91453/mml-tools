import { createCanonicalProject } from './index.mjs';
import { normalizeControlEvents, controlConflictDiagnostic } from './control-map.mjs';

export { normalizeControlEvents, controlConflictDiagnostic, meterMapText } from './control-map.mjs';

function assertProject(project, index) {
  if (!project || typeof project !== 'object') throw Error(`projects[${index}] must be an object`);
  if (!Array.isArray(project.sources) || !Array.isArray(project.events)) throw Error(`projects[${index}] is not a Canonical project-like object`);
}

function ensureUniqueIds(items, label) {
  const seen = new Map();
  for (const item of items) {
    if (!item?.id) throw Error(`${label} item is missing id`);
    const prior = seen.get(item.id);
    if (!prior) {
      seen.set(item.id, item);
      continue;
    }
    if (JSON.stringify(prior) !== JSON.stringify(item)) throw Error(`conflicting duplicate ${label} id: ${item.id}`);
  }
  return [...seen.values()];
}

function sourceIdentity(source) {
  return JSON.stringify({
    id: source.id,
    kind: source.kind,
    authority: source.authority,
    sha256: source.sha256 ?? null,
    label: source.label,
  });
}

export function mergeCanonicalProjects(projects, options = {}) {
  if (!Array.isArray(projects) || !projects.length) throw Error('mergeCanonicalProjects requires at least one project');
  projects.forEach(assertProject);

  const id = options.id ?? 'merged-project';
  const title = options.title ?? projects.find(project => project.title)?.title ?? id;

  const sources = [];
  const sourceById = new Map();
  for (const project of projects) {
    for (const source of project.sources) {
      const prior = sourceById.get(source.id);
      if (prior && sourceIdentity(prior) !== sourceIdentity(source)) throw Error(`conflicting duplicate source id: ${source.id}`);
      if (!prior) {
        sourceById.set(source.id, source);
        sources.push(source);
      }
    }
  }

  const events = ensureUniqueIds(projects.flatMap(project => project.events ?? []), 'event');
  // One tempo map and one meter map. Two sources stating the same tempo or
  // meter at the same beat are one control with two witnesses; different
  // values at one beat are a disagreement that is kept, named and left
  // blocking (the Final emitter refuses two tempi at one beat, the Final meter
  // map two meters) -- never settled by picking one.
  const controls = normalizeControlEvents({
    tempoEvents: ensureUniqueIds(projects.flatMap(project => project.tempoEvents ?? []), 'tempo event'),
    meterEvents: ensureUniqueIds(projects.flatMap(project => project.meterEvents ?? []), 'meter event'),
  });
  const { tempoEvents, meterEvents } = controls;
  const controlConflicts = controls.conflicts.map(controlConflictDiagnostic);
  const decisions = ensureUniqueIds(projects.flatMap(project => project.decisions ?? []), 'decision');

  const incompleteInputs = projects
    .filter(project => project.metadata?.sourceComplete === false)
    .map(project => project.id);

  const projectKinds = projects.map(project => ({
    id: project.id ?? null,
    ingestion: project.metadata?.ingestion ?? null,
    sourceComplete: project.metadata?.sourceComplete ?? null,
  }));

  return createCanonicalProject({
    id,
    title,
    sources,
    events,
    tempoEvents,
    meterEvents,
    decisions,
    metadata: {
      notes: 'Merging preserves separate sources/events; it does not reconcile or deduplicate musically equivalent note/rest events across sources. A tempo or meter stated identically by several sources at one beat is kept once with every witness cited (metadata.controlMap); different values at one beat are kept and reported as conflicts.',
      // Caller metadata is annotation, so it is spread first. What the merge
      // itself determined is written after it and is not overridable:
      // `sourceComplete` is read as a Gate 2 verdict by
      // backend/final/readiness.mjs, and letting a caller assert it would let a
      // merge of incomplete inputs present itself as source-complete.
      ...(options.metadata ?? {}),
      merge: 'canonical-project-merge-v1',
      componentProjects: projectKinds,
      sourceComplete: incompleteInputs.length === 0,
      incompleteInputs,
      controlMap: {
        collapsed: controls.collapsed.map(item => ({ ...item, absorbedIds: [...item.absorbedIds] })),
        conflicts: controlConflicts.map(item => structuredClone(item)),
      },
      unsupported: [
        ...(Array.isArray(options.metadata?.unsupported) ? options.metadata.unsupported : []),
        ...controlConflicts.map(item => structuredClone(item)),
      ],
    },
  });
}
