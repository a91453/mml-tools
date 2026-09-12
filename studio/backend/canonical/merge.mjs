import { createCanonicalProject } from './index.mjs';

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
  const tempoEvents = ensureUniqueIds(projects.flatMap(project => project.tempoEvents ?? []), 'tempo event');
  const meterEvents = ensureUniqueIds(projects.flatMap(project => project.meterEvents ?? []), 'meter event');
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
      merge: 'canonical-project-merge-v1',
      componentProjects: projectKinds,
      sourceComplete: incompleteInputs.length === 0,
      incompleteInputs,
      notes: 'Merging preserves separate sources/events; it does not reconcile or deduplicate musically equivalent events across sources.',
      ...(options.metadata ?? {}),
    },
  });
}
