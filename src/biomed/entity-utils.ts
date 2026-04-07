import { BiomedTaskSample } from './types.js';

export function getPrimaryEntity(
  sample: BiomedTaskSample,
  key: 'drug' | 'protein' | 'disease' | 'sideeffect' | 'cellline',
): string | undefined {
  const value = sample.entityDict[key];
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    return value.find((item) => item.trim() !== '')?.trim();
  }
  return undefined;
}

export function getEntityIds(
  sample: BiomedTaskSample,
  ...keys: string[]
): string[] {
  const values: string[] = [];

  for (const key of keys) {
    const entityValue = sample.entityDict[key];
    if (typeof entityValue === 'string') {
      values.push(entityValue);
    }
    if (Array.isArray(entityValue)) {
      values.push(...entityValue);
    }
  }

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
