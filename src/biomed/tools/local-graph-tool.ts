import fs from 'node:fs';
import path from 'node:path';

import { BiomedLabel, BiomedTaskSample, ResearchToolResult } from '../types.js';

interface GraphTriplet {
  drug: string;
  protein: string;
  disease: string;
  label: BiomedLabel;
}

export interface LocalGraphEvidence {
  sharedDrugProteinCount: number;
  sharedDrugDiseaseCount: number;
  sharedProteinDiseaseCount: number;
  pairCoverageCount: number;
  supportScore: number;
  threeWayClosure: boolean;
  proteinDiseaseBackbone: boolean;
  drugProteinBackbone: boolean;
  drugDiseaseBackbone: boolean;
  sharedDrugCount: number;
  sharedProteinCount: number;
  sharedDiseaseCount: number;
  sharedDrugProteinExamples: string[];
  sharedDrugDiseaseExamples: string[];
  sharedProteinDiseaseExamples: string[];
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
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function primaryEntity(
  sample: BiomedTaskSample,
  key: 'drug' | 'protein' | 'disease',
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

export class LocalGraphTool {
  private cachedTriplets: GraphTriplet[] | null = null;

  constructor(
    private readonly graphDataDir: string,
    private readonly relationshipType: string,
  ) {}

  private loadTriplets(): GraphTriplet[] {
    if (this.cachedTriplets) {
      return this.cachedTriplets;
    }

    const entries = fs
      .readdirSync(this.graphDataDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^order_.*\.csv$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );

    const triplets: GraphTriplet[] = [];
    for (const entry of entries) {
      const rows = readCsvRows(path.join(this.graphDataDir, entry));
      for (const row of rows) {
        if (row.relationship !== this.relationshipType) {
          continue;
        }

        const labelColumn =
          'hyperedge_label' in row ? 'hyperedge_label' : 'label';
        const label =
          Number.parseInt(row[labelColumn] ?? '0', 10) === 1 ? 1 : 0;
        if (label !== 1) {
          continue;
        }

        const drug = (row.entity_1 ?? '').trim();
        const protein = (row.entity_2 ?? '').trim();
        const disease = (row.entity_3 ?? '').trim();
        if (!drug || !protein || !disease) {
          continue;
        }

        triplets.push({ drug, protein, disease, label });
      }
    }

    this.cachedTriplets = triplets;
    return triplets;
  }

  inspectSample(sample: BiomedTaskSample): ResearchToolResult {
    const drug = primaryEntity(sample, 'drug');
    const protein = primaryEntity(sample, 'protein');
    const disease = primaryEntity(sample, 'disease');
    if (!drug || !protein || !disease) {
      return {
        toolName: 'local_graph_tool',
        status: 'error',
        textSummary:
          'Local graph tool could not inspect the sample because one or more required entities were missing.',
        structured: null,
        error: 'Missing drug, protein, or disease entity.',
      };
    }

    const filtered = this.loadTriplets().filter(
      (triplet) =>
        !(
          triplet.drug === drug &&
          triplet.protein === protein &&
          triplet.disease === disease
        ),
    );

    const sharedDrugProtein = filtered.filter(
      (triplet) => triplet.drug === drug && triplet.protein === protein,
    );
    const sharedDrugDisease = filtered.filter(
      (triplet) => triplet.drug === drug && triplet.disease === disease,
    );
    const sharedProteinDisease = filtered.filter(
      (triplet) => triplet.protein === protein && triplet.disease === disease,
    );
    const sharedDrug = filtered.filter((triplet) => triplet.drug === drug);
    const sharedProtein = filtered.filter(
      (triplet) => triplet.protein === protein,
    );
    const sharedDisease = filtered.filter(
      (triplet) => triplet.disease === disease,
    );

    const evidence: LocalGraphEvidence = {
      sharedDrugProteinCount: sharedDrugProtein.length,
      sharedDrugDiseaseCount: sharedDrugDisease.length,
      sharedProteinDiseaseCount: sharedProteinDisease.length,
      pairCoverageCount: [
        sharedDrugProtein,
        sharedDrugDisease,
        sharedProteinDisease,
      ].filter((items) => items.length > 0).length,
      supportScore:
        Math.min(sharedDrugProtein.length, 3) * 2 +
        Math.min(sharedDrugDisease.length, 3) * 2 +
        Math.min(sharedProteinDisease.length, 5) * 3,
      threeWayClosure:
        sharedDrugProtein.length > 0 &&
        sharedDrugDisease.length > 0 &&
        sharedProteinDisease.length > 0,
      proteinDiseaseBackbone: sharedProteinDisease.length >= 3,
      drugProteinBackbone: sharedDrugProtein.length >= 2,
      drugDiseaseBackbone: sharedDrugDisease.length >= 2,
      sharedDrugCount: sharedDrug.length,
      sharedProteinCount: sharedProtein.length,
      sharedDiseaseCount: sharedDisease.length,
      sharedDrugProteinExamples: sharedDrugProtein
        .slice(0, 5)
        .map((triplet) => triplet.disease),
      sharedDrugDiseaseExamples: sharedDrugDisease
        .slice(0, 5)
        .map((triplet) => triplet.protein),
      sharedProteinDiseaseExamples: sharedProteinDisease
        .slice(0, 5)
        .map((triplet) => triplet.drug),
    };

    const summaryParts = [
      `Local graph neighborhood for (${drug}, ${protein}, ${disease}) excludes the queried hyperedge itself.`,
      `Shared drug-protein positive neighbors: ${evidence.sharedDrugProteinCount}.`,
      `Shared drug-disease positive neighbors: ${evidence.sharedDrugDiseaseCount}.`,
      `Shared protein-disease positive neighbors: ${evidence.sharedProteinDiseaseCount}.`,
      `Pair coverage count: ${evidence.pairCoverageCount}. Support score: ${evidence.supportScore}.`,
      `Three-way closure=${evidence.threeWayClosure}. Backbone flags: protein-disease=${evidence.proteinDiseaseBackbone}, drug-protein=${evidence.drugProteinBackbone}, drug-disease=${evidence.drugDiseaseBackbone}.`,
      `Single-entity neighborhood sizes: drug=${evidence.sharedDrugCount}, protein=${evidence.sharedProteinCount}, disease=${evidence.sharedDiseaseCount}.`,
    ];

    if (evidence.sharedDrugProteinExamples.length > 0) {
      summaryParts.push(
        `Example diseases for the same drug-protein pair: ${evidence.sharedDrugProteinExamples.join(', ')}.`,
      );
    }
    if (evidence.sharedDrugDiseaseExamples.length > 0) {
      summaryParts.push(
        `Example proteins for the same drug-disease pair: ${evidence.sharedDrugDiseaseExamples.join(', ')}.`,
      );
    }
    if (evidence.sharedProteinDiseaseExamples.length > 0) {
      summaryParts.push(
        `Example drugs for the same protein-disease pair: ${evidence.sharedProteinDiseaseExamples.join(', ')}.`,
      );
    }

    return {
      toolName: 'local_graph_tool',
      status: 'ok',
      textSummary: summaryParts.join(' '),
      structured: {
        query: { drug, protein, disease },
        leakageControl:
          'Exact queried hyperedge is excluded from local graph counts.',
        positiveNeighborhood: evidence,
      },
    };
  }
}
