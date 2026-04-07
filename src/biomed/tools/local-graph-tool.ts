import fs from 'node:fs';
import path from 'node:path';

import { BiomedLabel, BiomedTaskSample, ResearchToolResult } from '../types.js';

export interface InformativeHyperedgeCandidate {
  relationship: string;
  entities: string[];
  label: BiomedLabel;
  sharedEntities: string[];
  sharedCount: number;
  sameRelationship: boolean;
  score: number;
}

export interface LocalGraphToolArgs {
  focus?: unknown;
  hypothesisFocus?: unknown;
  roundNumber?: unknown;
  maxCandidates?: unknown;
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

function numericEntityKeys(row: Record<string, string>): string[] {
  return Object.keys(row)
    .filter((key) => key.startsWith('entity_'))
    .sort(
      (left, right) =>
        Number.parseInt(left.slice('entity_'.length), 10) -
        Number.parseInt(right.slice('entity_'.length), 10),
    );
}

function extractEntitiesFromRow(row: Record<string, string>): string[] {
  return numericEntityKeys(row)
    .map((key) => (row[key] ?? '').trim())
    .filter((value) => value !== '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildHyperedgeKey(relationship: string, entities: string[]): string {
  return `${relationship}::${entities.join('|')}`;
}

function readEntity(sample: BiomedTaskSample, key: string): string | undefined {
  const value = sample.entityDict[key];
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    return value.find((item) => item.trim() !== '')?.trim();
  }
  return undefined;
}

function readEntityList(sample: BiomedTaskSample, key: string): string[] {
  const value = sample.entityDict[key];
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function queryHyperedgeFromSample(
  sample: BiomedTaskSample,
):
  | { relationship: string; entities: string[] }
  | { error: string; details: string } {
  const relationship = sample.relationshipType;

  if (relationship === 'drug_protein_disease') {
    const drug = readEntity(sample, 'drug');
    const protein = readEntity(sample, 'protein');
    const disease = readEntity(sample, 'disease');
    if (!drug || !protein || !disease) {
      return {
        error: 'Missing required entities for drug_protein_disease.',
        details: 'Required: drug, protein, disease.',
      };
    }
    return { relationship, entities: [drug, protein, disease] };
  }

  if (relationship === 'drug_drug_sideeffect') {
    const drugs = readEntityList(sample, 'drugs');
    const sideeffect = readEntity(sample, 'sideeffect');
    if (drugs.length === 0 || !sideeffect) {
      return {
        error: 'Missing required entities for drug_drug_sideeffect.',
        details: 'Required: drugs (array) and sideeffect.',
      };
    }
    return { relationship, entities: [...uniqueStrings(drugs), sideeffect] };
  }

  if (relationship === 'drug_drug_cell-line') {
    const drugs = readEntityList(sample, 'drugs');
    const cellline = readEntity(sample, 'cellline');
    if (drugs.length === 0 || !cellline) {
      return {
        error: 'Missing required entities for drug_drug_cell-line.',
        details: 'Required: drugs (array) and cellline.',
      };
    }
    return { relationship, entities: [...uniqueStrings(drugs), cellline] };
  }

  return {
    error: `Unsupported relationship type for local_graph_tool: ${relationship}.`,
    details: 'Add explicit entity mapping for this relationship before running graph retrieval.',
  };
}

function overlapEntities(queryEntities: string[], candidateEntities: string[]): string[] {
  const querySet = new Set(queryEntities);
  return uniqueStrings(candidateEntities.filter((entity) => querySet.has(entity)));
}

export class LocalGraphTool {
  constructor(
    private readonly graphDataDir: string,
    private readonly relationshipType: string,
  ) {}

  inspectSample(
    sample: BiomedTaskSample,
    args: LocalGraphToolArgs = {},
  ): ResearchToolResult {
    if (sample.relationshipType !== this.relationshipType) {
      return {
        toolName: 'local_graph_tool',
        status: 'error',
        textSummary:
          'local_graph_tool received a sample whose relationship type does not match the configured relationship type.',
        structured: null,
        error: `Configured relationship=${this.relationshipType}, sample relationship=${sample.relationshipType}.`,
      };
    }

    const query = queryHyperedgeFromSample(sample);
    if ('error' in query) {
      return {
        toolName: 'local_graph_tool',
        status: 'error',
        textSummary: query.error,
        structured: null,
        error: query.details,
      };
    }

    const queryKey = buildHyperedgeKey(query.relationship, query.entities);
    const maxCandidates =
      typeof args.maxCandidates === 'number' && Number.isFinite(args.maxCandidates)
        ? Math.max(3, Math.min(20, Math.trunc(args.maxCandidates)))
        : 8;

    const neighbors: InformativeHyperedgeCandidate[] = [];
    const relationshipHistogram = new Map<
      string,
      { total: number; positive: number; negative: number }
    >();
    let totalNeighbors = 0;
    let positiveNeighbors = 0;

    const entries = fs
      .readdirSync(this.graphDataDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^order_.*\.csv$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    for (const entry of entries) {
      const filePath = path.join(this.graphDataDir, entry);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
      if (lines.length <= 1) {
        continue;
      }

      const headers = parseCsvLine(lines[0]);
      for (const line of lines.slice(1)) {
        const values = parseCsvLine(line);
        const row: Record<string, string> = {};
        headers.forEach((header, index) => {
          row[header] = values[index] ?? '';
        });

        const relationship = (row.relationship ?? '').trim();
        const entities = extractEntitiesFromRow(row);
        if (!relationship || entities.length < 2) {
          continue;
        }

        const edgeKey = buildHyperedgeKey(relationship, entities);
        if (edgeKey === queryKey) {
          continue;
        }

        const sharedEntities = overlapEntities(query.entities, entities);
        if (sharedEntities.length === 0) {
          continue;
        }

        const labelColumn = 'hyperedge_label' in row ? 'hyperedge_label' : 'label';
        const label: BiomedLabel = Number.parseInt(row[labelColumn] ?? '0', 10) === 1 ? 1 : 0;
        const sameRelationship = relationship === query.relationship;
        const score =
          sharedEntities.length * 4 +
          (sameRelationship ? 2 : 0) +
          (label === 1 ? 1 : 0);

        totalNeighbors += 1;
        if (label === 1) {
          positiveNeighbors += 1;
        }

        const stats = relationshipHistogram.get(relationship) ?? {
          total: 0,
          positive: 0,
          negative: 0,
        };
        stats.total += 1;
        if (label === 1) {
          stats.positive += 1;
        } else {
          stats.negative += 1;
        }
        relationshipHistogram.set(relationship, stats);

        neighbors.push({
          relationship,
          entities,
          label,
          sharedEntities,
          sharedCount: sharedEntities.length,
          sameRelationship,
          score,
        });
      }
    }

    neighbors.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.sharedCount !== left.sharedCount) {
        return right.sharedCount - left.sharedCount;
      }
      if (right.label !== left.label) {
        return right.label - left.label;
      }
      return left.relationship.localeCompare(right.relationship);
    });

    const topNeighbors = neighbors.slice(0, maxCandidates);
    const negativeNeighbors = totalNeighbors - positiveNeighbors;
    const positiveRate =
      totalNeighbors > 0
        ? Number.parseFloat((positiveNeighbors / totalNeighbors).toFixed(4))
        : 0;

    const sameRelationshipNeighbors = neighbors.filter(
      (neighbor) => neighbor.sameRelationship,
    );
    const sameRelationshipPositive = sameRelationshipNeighbors.filter(
      (neighbor) => neighbor.label === 1,
    ).length;
    const sameRelationshipNegative =
      sameRelationshipNeighbors.length - sameRelationshipPositive;

    const relationshipBreakdown = Object.fromEntries(
      [...relationshipHistogram.entries()]
        .sort((left, right) => right[1].total - left[1].total)
        .map(([relationship, stats]) => [relationship, stats]),
    );

    return {
      toolName: 'local_graph_tool',
      status: 'ok',
      textSummary: [
        `Query hyperedge ${query.relationship}(${query.entities.join(', ')}) was evaluated using labeled neighboring hyperedges that share at least one entity with the query.`,
        `Neighbor count=${totalNeighbors}, positive=${positiveNeighbors}, negative=${negativeNeighbors}, positive_rate=${positiveRate}.`,
        `Same-relationship neighbors=${sameRelationshipNeighbors.length} (positive=${sameRelationshipPositive}, negative=${sameRelationshipNegative}).`,
        topNeighbors.length > 0
          ? `Top neighbors: ${topNeighbors
              .slice(0, 5)
              .map(
                (neighbor) =>
                  `${neighbor.relationship}[label=${neighbor.label},shared=${neighbor.sharedEntities.join('+')},score=${neighbor.score}]`,
              )
              .join(' ')}`
          : 'No neighboring hyperedge was found in the graph index for this query.',
      ].join(' '),
      structured: {
        query: {
          relationship: query.relationship,
          entities: query.entities,
          key: queryKey,
        },
        neighborhoodStats: {
          totalNeighbors,
          positiveNeighbors,
          negativeNeighbors,
          positiveRate,
          sameRelationshipNeighbors: sameRelationshipNeighbors.length,
          sameRelationshipPositive,
          sameRelationshipNegative,
        },
        relationshipBreakdown,
        topNeighbors,
      },
    };
  }
}
