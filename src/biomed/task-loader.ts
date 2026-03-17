import fs from 'fs';
import path from 'path';

import { BiomedLabel, BiomedTaskSample } from './types.js';

export interface RelationshipStructure {
  entityTypes: string[];
  isFixedOrder: boolean;
  lastEntityType?: string;
}

export interface TaskLoader {
  loadSamples(limit?: number): Promise<BiomedTaskSample[]>;
}

export interface CsvTaskLoaderOptions {
  dataDir: string;
  relationshipType: string;
}

export function getRelationshipStructure(
  relationshipType: string,
): RelationshipStructure {
  const structures: Record<string, RelationshipStructure> = {
    drug_disease: {
      entityTypes: ['drug', 'disease'],
      isFixedOrder: true,
    },
    disease_sideeffect: {
      entityTypes: ['disease', 'sideeffect'],
      isFixedOrder: true,
    },
    drug_protein_disease: {
      entityTypes: ['drug', 'protein', 'disease'],
      isFixedOrder: true,
    },
    drug_drug_sideeffect: {
      entityTypes: ['drug'],
      lastEntityType: 'sideeffect',
      isFixedOrder: false,
    },
    'drug_drug_cell-line': {
      entityTypes: ['drug'],
      lastEntityType: 'cellline',
      isFixedOrder: false,
    },
    'cell-line_disease': {
      entityTypes: ['cellline', 'disease'],
      isFixedOrder: true,
    },
    protein_protein: {
      entityTypes: ['protein', 'protein'],
      isFixedOrder: true,
    },
  };

  return structures[relationshipType] ?? {
    entityTypes: ['unknown'],
    isFixedOrder: true,
  };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function readCsvRows(filePath: string): Record<string, string>[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const rowValues = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = rowValues[index] ?? '';
    });
    return row;
  });
}

function toBiomedLabel(raw: string | undefined): BiomedLabel {
  return Number.parseInt(raw ?? '0', 10) === 1 ? 1 : 0;
}

function buildEntityDict(
  entityValues: string[],
  structure: RelationshipStructure,
): Record<string, string | string[]> {
  const entityDict: Record<string, string | string[]> = {};

  if (structure.isFixedOrder) {
    structure.entityTypes.forEach((entityType, index) => {
      if (index < entityValues.length) {
        entityDict[entityType] = entityValues[index];
      }
    });
    return entityDict;
  }

  const mainType = structure.entityTypes[0];
  const lastType = structure.lastEntityType;
  if (lastType && entityValues.length > 0) {
    entityDict[`${mainType}s`] = entityValues.slice(0, -1);
    entityDict[lastType] = entityValues[entityValues.length - 1];
    return entityDict;
  }

  entityDict[`${mainType}s`] = entityValues;
  return entityDict;
}

export class CsvTaskLoader implements TaskLoader {
  constructor(private readonly options: CsvTaskLoaderOptions) {}

  async loadSamples(limit?: number): Promise<BiomedTaskSample[]> {
    const structure = getRelationshipStructure(this.options.relationshipType);
    const entries = fs
      .readdirSync(this.options.dataDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^order_.*\.csv$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    const samples: BiomedTaskSample[] = [];
    let sampleIndex = 0;

    for (const entry of entries) {
      const filePath = path.join(this.options.dataDir, entry);
      const rows = readCsvRows(filePath);

      for (const row of rows) {
        if (
          row.relationship &&
          row.relationship !== this.options.relationshipType
        ) {
          continue;
        }

        const entityColumns = Object.keys(row)
          .filter((column) => column.toLowerCase().includes('entity'))
          .sort();

        const entityValues = entityColumns
          .map((column) => row[column])
          .filter((value) => value && value.trim() !== '');

        if (entityValues.length === 0) {
          continue;
        }

        const labelColumn = 'hyperedge_label' in row ? 'hyperedge_label' : 'label';
        samples.push({
          sampleIndex,
          relationshipType: this.options.relationshipType,
          entityDict: buildEntityDict(entityValues, structure),
          groundTruth: toBiomedLabel(row[labelColumn]),
        });
        sampleIndex += 1;

        if (limit !== undefined && samples.length >= limit) {
          return samples;
        }
      }
    }

    return samples;
  }
}