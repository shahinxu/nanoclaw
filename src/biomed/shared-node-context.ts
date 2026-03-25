import { SharedNodeContextBundle, SharedNodeContextEntry } from './types.js';

export function getSharedNodeEntry(
  bundle: SharedNodeContextBundle,
  entityType: keyof SharedNodeContextBundle,
  entityId: string | undefined,
): SharedNodeContextEntry | undefined {
  if (!entityId) {
    return undefined;
  }

  return bundle[entityType].find((item) => item.entityId === entityId);
}

export function formatSharedNodeBundle(
  bundle: SharedNodeContextBundle,
): string {
  const sections: string[] = [];

  for (const entityType of ['drug', 'protein', 'disease'] as const) {
    const items = bundle[entityType];
    if (items.length === 0) {
      continue;
    }

    sections.push(
      `${entityType} nodes: ${items
        .map((item) => `${item.entityId}: ${item.summary}`)
        .join(' || ')}`,
    );
  }

  return sections.join(' | ');
}