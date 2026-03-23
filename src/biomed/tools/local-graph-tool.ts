import fs from 'node:fs';
import path from 'node:path';

import { BiomedLabel, BiomedTaskSample, ResearchToolResult } from '../types.js';

type SupportTier = 'strong' | 'moderate' | 'weak' | 'insufficient';

interface GraphTriplet {
  drug: string;
  protein: string;
  disease: string;
  label: BiomedLabel;
}

interface IndexedHyperedge {
  relationship: string;
  order: number;
  entities: string[];
  key: string;
}

interface GraphIndex {
  targetTriplets: GraphTriplet[];
  targetByDrug: Map<string, number[]>;
  targetByProtein: Map<string, number[]>;
  targetByDisease: Map<string, number[]>;
  drugDiseaseEdges: IndexedHyperedge[];
  drugDiseaseByDrug: Map<string, number[]>;
  drugDiseaseByDisease: Map<string, number[]>;
  proteinProteinEdges: IndexedHyperedge[];
  proteinProteinByProtein: Map<string, number[]>;
  sideEffectEdges: IndexedHyperedge[];
  sideEffectByDrug: Map<string, number[]>;
  cellLineEdges: IndexedHyperedge[];
  cellLineByDrug: Map<string, number[]>;
  cellLineDiseaseEdges: IndexedHyperedge[];
  cellLineDiseaseByDisease: Map<string, number[]>;
  entityFrequency: Map<string, number>;
  drugsByProtein: Map<string, Set<string>>;
  drugsByDisease: Map<string, Set<string>>;
  proteinsByDrug: Map<string, Set<string>>;
  proteinsByDisease: Map<string, Set<string>>;
  diseasesByDrug: Map<string, Set<string>>;
  diseasesByProtein: Map<string, Set<string>>;
}

export interface InformativeHyperedgeCandidate {
  relationship: string;
  order: number;
  entities: string[];
  matchedQueryEntities: string[];
  introducedEntities: string[];
  anchorOverlapCount: number;
  pairOverlapCount: number;
  bridgeToTargetCount: number;
  relationPriority: number;
  score: number;
  rationale: string;
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
  localSupportTier: SupportTier;
  retrievalTier: SupportTier;
  supportTier: SupportTier;
  biologicalNarratives: string[];
}

interface LocalGraphToolArgs {
  focus?: unknown;
  hypothesisFocus?: unknown;
  roundNumber?: unknown;
  maxCandidates?: unknown;
}

interface RetrievalSummary {
  retrievalTier: SupportTier;
  topCandidates: InformativeHyperedgeCandidate[];
  relationshipHistogram: Record<string, number>;
  narratives: string[];
  focusUsed: string[];
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

function extractEntities(row: Record<string, string>): string[] {
  return numericEntityKeys(row)
    .map((key) => (row[key] ?? '').trim())
    .filter((value) => value !== '');
}

function buildHyperedgeKey(relationship: string, entities: string[]): string {
  return `${relationship}::${entities.join('|')}`;
}

function addId(map: Map<string, number[]>, key: string, id: number): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(id);
    return;
  }
  map.set(key, [id]);
}

function addToSetMap(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function normalizeContextList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function relationPriority(
  relationship: string,
  targetRelationshipType: string,
): number {
  if (relationship === targetRelationshipType) {
    return 3.6;
  }
  if (relationship === 'drug_disease') {
    return 2.5;
  }
  if (relationship === 'protein_protein') {
    return 2.1;
  }
  if (relationship === 'cell-line_disease') {
    return 1.8;
  }
  if (relationship === 'drug_drug_cell-line') {
    return 1.5;
  }
  if (relationship === 'drug_drug_sideeffect') {
    return 1.3;
  }
  if (relationship === 'disease_disease') {
    return 0.4;
  }
  return 1;
}

function orderSpecificityScore(order: number): number {
  if (order <= 3) {
    return 1.2;
  }
  if (order <= 6) {
    return 0.9;
  }
  if (order <= 10) {
    return 0.5;
  }
  return 0.1;
}

function supportTierRank(tier: SupportTier): number {
  if (tier === 'strong') {
    return 3;
  }
  if (tier === 'moderate') {
    return 2;
  }
  if (tier === 'weak') {
    return 1;
  }
  return 0;
}

function maxSupportTier(left: SupportTier, right: SupportTier): SupportTier {
  return supportTierRank(left) >= supportTierRank(right) ? left : right;
}

function pairOverlapCount(
  candidate: IndexedHyperedge,
  query: { drug: string; protein: string; disease: string },
): number {
  const entitySet = new Set(candidate.entities);
  const pairs = [
    [query.drug, query.protein],
    [query.drug, query.disease],
    [query.protein, query.disease],
  ];
  return pairs.filter(
    ([left, right]) => entitySet.has(left) && entitySet.has(right),
  ).length;
}

function frequencyBonus(
  entity: string,
  entityFrequency: Map<string, number>,
): number {
  const frequency = entityFrequency.get(entity) ?? 0;
  return 1 / Math.log(frequency + 2);
}

function relationFocusBonus(relationship: string, focusUsed: string[]): number {
  const text = focusUsed.join(' ').toLowerCase();
  if (!text) {
    return 0;
  }

  let bonus = 0;
  if (
    /mechanism|target|pathway|protein|binding|module/u.test(text) &&
    (relationship === 'protein_protein' ||
      relationship === 'drug_protein_disease')
  ) {
    bonus += 1;
  }
  if (
    /disease|indication|alignment|treat|phenotype/u.test(text) &&
    (relationship === 'drug_disease' ||
      relationship === 'cell-line_disease' ||
      relationship === 'drug_protein_disease')
  ) {
    bonus += 1;
  }
  if (
    /cell|model|line|assay/u.test(text) &&
    (relationship === 'drug_drug_cell-line' ||
      relationship === 'cell-line_disease')
  ) {
    bonus += 0.7;
  }
  if (
    /tox|safety|side effect|adverse/u.test(text) &&
    relationship === 'drug_drug_sideeffect'
  ) {
    bonus += 1.2;
  }
  return bonus;
}

function buildRelationshipHistogram(
  candidates: InformativeHyperedgeCandidate[],
): Record<string, number> {
  const histogram = new Map<string, number>();
  for (const candidate of candidates) {
    histogram.set(
      candidate.relationship,
      (histogram.get(candidate.relationship) ?? 0) + 1,
    );
  }
  return Object.fromEntries(
    [...histogram.entries()].sort((left, right) => right[1] - left[1]),
  );
}

function selectDiverseCandidates(
  candidates: InformativeHyperedgeCandidate[],
  maxCandidates: number,
  targetRelationshipType: string,
): InformativeHyperedgeCandidate[] {
  const grouped = new Map<string, InformativeHyperedgeCandidate[]>();
  for (const candidate of candidates) {
    const existing = grouped.get(candidate.relationship);
    if (existing) {
      existing.push(candidate);
      continue;
    }
    grouped.set(candidate.relationship, [candidate]);
  }

  const selected: InformativeHyperedgeCandidate[] = [];
  const selectedKeys = new Set<string>();
  const addCandidate = (candidate: InformativeHyperedgeCandidate): void => {
    const key = `${candidate.relationship}::${candidate.entities.join('|')}`;
    if (selectedKeys.has(key) || selected.length >= maxCandidates) {
      return;
    }
    selected.push(candidate);
    selectedKeys.add(key);
  };

  for (const candidate of (grouped.get(targetRelationshipType) ?? []).slice(
    0,
    2,
  )) {
    addCandidate(candidate);
  }

  const auxiliaryBest = [...grouped.entries()]
    .filter(([relationship]) => relationship !== targetRelationshipType)
    .map(([relationship, items]) => ({ relationship, candidate: items[0] }))
    .sort((left, right) => right.candidate.score - left.candidate.score);
  for (const item of auxiliaryBest) {
    addCandidate(item.candidate);
  }

  for (const candidate of candidates) {
    addCandidate(candidate);
  }

  return selected.slice(0, maxCandidates);
}

function summarizeCandidateRationale(
  candidate: IndexedHyperedge,
  query: { drug: string; protein: string; disease: string },
  matchedQueryEntities: string[],
  bridgeEntities: string[],
  targetRelationshipType: string,
): string {
  const matched = new Set(matchedQueryEntities);
  const bridgeText =
    bridgeEntities.length > 0
      ? ` Bridge entities ${bridgeEntities.slice(0, 3).join(', ')} also reconnect to positive ${targetRelationshipType} triplets near the query.`
      : '';

  if (candidate.relationship === targetRelationshipType) {
    if (matched.has(query.protein) && matched.has(query.disease)) {
      return `Alternative positive triplets reuse protein ${query.protein} and disease ${query.disease} with different drugs, which is direct evidence for a reusable target-disease module.${bridgeText}`;
    }
    if (matched.has(query.drug) && matched.has(query.disease)) {
      return `Drug ${query.drug} already appears with disease ${query.disease} through alternative proteins, which supports disease-aligned mechanism breadth for the drug.${bridgeText}`;
    }
    if (matched.has(query.drug) && matched.has(query.protein)) {
      return `Drug ${query.drug} already appears with protein ${query.protein} across alternative diseases, which supports a reusable drug-target mechanism.${bridgeText}`;
    }
    return `A neighboring ${targetRelationshipType} hyperedge shares one anchor with the query and stays close to the same mechanism neighborhood.${bridgeText}`;
  }

  if (candidate.relationship === 'drug_disease') {
    if (matched.has(query.drug) && matched.has(query.disease)) {
      return `A direct positive drug-disease edge already connects ${query.drug} to ${query.disease}, adding indication-level context outside the triplet relation.${bridgeText}`;
    }
    if (matched.has(query.drug)) {
      return `Drug ${query.drug} appears in positive drug-disease edges, so the graph recovers disease-aligned therapeutic context around the drug.${bridgeText}`;
    }
    return `Disease ${query.disease} is recovered through positive drug-disease edges, providing treatment-oriented disease context.${bridgeText}`;
  }

  if (candidate.relationship === 'protein_protein') {
    return `Protein ${query.protein} participates in positive protein-protein edges, which contributes mechanism-side network context around the queried target.${bridgeText}`;
  }

  if (candidate.relationship === 'cell-line_disease') {
    return `Disease ${query.disease} is linked to positive cell-line disease edges, adding experimental model context rather than only abstract disease labels.${bridgeText}`;
  }

  if (candidate.relationship === 'drug_drug_cell-line') {
    return `Drug ${query.drug} appears in positive drug-drug-cell-line hyperedges, which adds assay and experimental combination context around the drug.${bridgeText}`;
  }

  if (candidate.relationship === 'drug_drug_sideeffect') {
    return `Drug ${query.drug} appears in positive drug-drug-sideeffect hyperedges, which adds phenotype and safety context around the drug.${bridgeText}`;
  }

  return `A positive ${candidate.relationship} hyperedge shares query anchors and adds auxiliary biological context.${bridgeText}`;
}

function deriveRetrievalSummary(
  candidates: InformativeHyperedgeCandidate[],
  query: { drug: string; protein: string; disease: string },
  targetRelationshipType: string,
  focusUsed: string[],
): RetrievalSummary {
  const topCandidates = candidates.slice(0, 8);
  const relationshipHistogram = buildRelationshipHistogram(topCandidates);
  const relationDiversity = Object.keys(relationshipHistogram).length;
  const strongSameType = topCandidates.some(
    (candidate) =>
      candidate.relationship === targetRelationshipType &&
      candidate.pairOverlapCount >= 2 &&
      candidate.score >= 9,
  );
  const bridgeRichCandidates = topCandidates.filter(
    (candidate) => candidate.bridgeToTargetCount >= 1,
  ).length;

  const retrievalTier: SupportTier = strongSameType
    ? 'strong'
    : bridgeRichCandidates >= 2 ||
        (relationDiversity >= 2 && topCandidates[0]?.score >= 7)
      ? 'moderate'
      : topCandidates.length > 0
        ? 'weak'
        : 'insufficient';

  const narratives: string[] = [];
  if (topCandidates.length > 0) {
    narratives.push(
      `Cross-relationship retrieval recovered ${topCandidates.length} informative positive hyperedges sharing query anchors, instead of restricting the search to the predicted relation type alone.`,
    );
  }

  const sameTypeProteinDisease = topCandidates.find(
    (candidate) =>
      candidate.relationship === targetRelationshipType &&
      candidate.matchedQueryEntities.includes(query.protein) &&
      candidate.matchedQueryEntities.includes(query.disease),
  );
  if (sameTypeProteinDisease) {
    narratives.push(
      `The strongest retrieved support comes from alternative positive triplets that reuse the ${query.protein}-${query.disease} axis with different drugs.`,
    );
  }

  if (
    topCandidates.some((candidate) => candidate.relationship === 'drug_disease')
  ) {
    narratives.push(
      'Auxiliary drug-disease edges add indication-level context, which is useful when direct triplet neighbors are sparse but disease alignment is still visible elsewhere in the graph.',
    );
  }

  if (
    topCandidates.some(
      (candidate) => candidate.relationship === 'protein_protein',
    )
  ) {
    narratives.push(
      'Protein-protein edges add mechanism-side network context around the queried target instead of relying only on triplet co-occurrence counts.',
    );
  }

  if (
    topCandidates.some(
      (candidate) => candidate.relationship === 'cell-line_disease',
    )
  ) {
    narratives.push(
      'Cell-line-disease edges contribute experimental model context for the queried disease, which is more biologically useful than generic disease-disease proximity.',
    );
  }

  if (
    topCandidates.some(
      (candidate) => candidate.relationship === 'drug_drug_sideeffect',
    )
  ) {
    narratives.push(
      'Drug-drug-sideeffect edges add phenotype-level context around the drug and can surface pharmacology that a same-type triplet search would miss entirely.',
    );
  }

  return {
    retrievalTier,
    topCandidates,
    relationshipHistogram,
    narratives,
    focusUsed,
  };
}

function deriveBiologicalNarratives(
  evidence: Omit<
    LocalGraphEvidence,
    | 'supportTier'
    | 'biologicalNarratives'
    | 'localSupportTier'
    | 'retrievalTier'
  >,
  query: { drug: string; protein: string; disease: string },
): { supportTier: SupportTier; biologicalNarratives: string[] } {
  const narratives: string[] = [];

  if (evidence.sharedProteinDiseaseCount >= 3) {
    narratives.push(
      `Multiple positive drugs already connect protein ${query.protein} to disease ${query.disease}, suggesting this protein-disease axis behaves like a reusable therapeutic module rather than an isolated coincidence.`,
    );
  }
  if (evidence.sharedDrugDiseaseCount >= 2) {
    narratives.push(
      `Drug ${query.drug} appears with disease ${query.disease} through alternative proteins, which suggests disease-relevant activity breadth for the drug in the local training graph.`,
    );
  }
  if (evidence.sharedDrugProteinCount >= 2) {
    narratives.push(
      `Drug ${query.drug} recurs with protein ${query.protein} across multiple diseases, so the drug-protein mechanism is not isolated to a single indication neighborhood.`,
    );
  }
  if (evidence.threeWayClosure) {
    narratives.push(
      'All three pairwise projections are observed in neighboring positive hyperedges, placing the triplet near a closed mechanistic neighborhood.',
    );
  }
  if (narratives.length === 0 && evidence.sharedProteinCount >= 10) {
    narratives.push(
      `Protein ${query.protein} is active elsewhere in the positive graph, but the queried drug-disease neighborhood does not recover a local closure around it.`,
    );
  }
  if (narratives.length === 0) {
    narratives.push(
      'Same-type local graph closure is weak after removing the queried hyperedge itself, so the graph needs auxiliary hyperedge retrieval to stay informative.',
    );
  }

  const supportTier: SupportTier =
    evidence.sharedProteinDiseaseCount >= 5 ||
    evidence.sharedDrugProteinCount >= 4 ||
    evidence.sharedDrugDiseaseCount >= 4 ||
    evidence.threeWayClosure
      ? 'strong'
      : evidence.pairCoverageCount >= 2 || evidence.supportScore >= 6
        ? 'moderate'
        : evidence.pairCoverageCount >= 1 || evidence.supportScore >= 2
          ? 'weak'
          : 'insufficient';

  return { supportTier, biologicalNarratives: narratives };
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
  private cachedIndex: GraphIndex | null = null;

  constructor(
    private readonly graphDataDir: string,
    private readonly relationshipType: string,
  ) {}

  private loadGraphIndex(): GraphIndex {
    if (this.cachedIndex) {
      return this.cachedIndex;
    }

    const index: GraphIndex = {
      targetTriplets: [],
      targetByDrug: new Map(),
      targetByProtein: new Map(),
      targetByDisease: new Map(),
      drugDiseaseEdges: [],
      drugDiseaseByDrug: new Map(),
      drugDiseaseByDisease: new Map(),
      proteinProteinEdges: [],
      proteinProteinByProtein: new Map(),
      sideEffectEdges: [],
      sideEffectByDrug: new Map(),
      cellLineEdges: [],
      cellLineByDrug: new Map(),
      cellLineDiseaseEdges: [],
      cellLineDiseaseByDisease: new Map(),
      entityFrequency: new Map(),
      drugsByProtein: new Map(),
      drugsByDisease: new Map(),
      proteinsByDrug: new Map(),
      proteinsByDisease: new Map(),
      diseasesByDrug: new Map(),
      diseasesByProtein: new Map(),
    };

    const entries = fs
      .readdirSync(this.graphDataDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^order_.*\.csv$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );

    for (const entry of entries) {
      const rows = readCsvRows(path.join(this.graphDataDir, entry));
      for (const row of rows) {
        const labelColumn =
          'hyperedge_label' in row ? 'hyperedge_label' : 'label';
        const label =
          Number.parseInt(row[labelColumn] ?? '0', 10) === 1 ? 1 : 0;
        if (label !== 1) {
          continue;
        }

        const relationship = (row.relationship ?? '').trim();
        const entities = extractEntities(row);
        if (!relationship || entities.length < 2) {
          continue;
        }

        for (const entity of new Set(entities)) {
          index.entityFrequency.set(
            entity,
            (index.entityFrequency.get(entity) ?? 0) + 1,
          );
        }

        if (relationship === this.relationshipType && entities.length >= 3) {
          const triplet: GraphTriplet = {
            drug: entities[0],
            protein: entities[1],
            disease: entities[2],
            label,
          };
          const tripletId = index.targetTriplets.push(triplet) - 1;
          addId(index.targetByDrug, triplet.drug, tripletId);
          addId(index.targetByProtein, triplet.protein, tripletId);
          addId(index.targetByDisease, triplet.disease, tripletId);
          addToSetMap(index.drugsByProtein, triplet.protein, triplet.drug);
          addToSetMap(index.drugsByDisease, triplet.disease, triplet.drug);
          addToSetMap(index.proteinsByDrug, triplet.drug, triplet.protein);
          addToSetMap(
            index.proteinsByDisease,
            triplet.disease,
            triplet.protein,
          );
          addToSetMap(index.diseasesByDrug, triplet.drug, triplet.disease);
          addToSetMap(
            index.diseasesByProtein,
            triplet.protein,
            triplet.disease,
          );
          continue;
        }

        if (relationship === 'drug_disease') {
          const edge: IndexedHyperedge = {
            relationship,
            order: entities.length,
            entities,
            key: buildHyperedgeKey(relationship, entities),
          };
          const edgeId = index.drugDiseaseEdges.push(edge) - 1;
          addId(index.drugDiseaseByDrug, entities[0], edgeId);
          addId(
            index.drugDiseaseByDisease,
            entities[entities.length - 1],
            edgeId,
          );
          continue;
        }

        if (relationship === 'protein_protein') {
          const edge: IndexedHyperedge = {
            relationship,
            order: entities.length,
            entities,
            key: buildHyperedgeKey(relationship, entities),
          };
          const edgeId = index.proteinProteinEdges.push(edge) - 1;
          for (const entity of entities) {
            addId(index.proteinProteinByProtein, entity, edgeId);
          }
          continue;
        }

        if (relationship === 'drug_drug_sideeffect') {
          const edge: IndexedHyperedge = {
            relationship,
            order: entities.length,
            entities,
            key: buildHyperedgeKey(relationship, entities),
          };
          const edgeId = index.sideEffectEdges.push(edge) - 1;
          for (const drug of entities.slice(0, -1)) {
            addId(index.sideEffectByDrug, drug, edgeId);
          }
          continue;
        }

        if (relationship === 'drug_drug_cell-line') {
          const edge: IndexedHyperedge = {
            relationship,
            order: entities.length,
            entities,
            key: buildHyperedgeKey(relationship, entities),
          };
          const edgeId = index.cellLineEdges.push(edge) - 1;
          for (const drug of entities.slice(0, -1)) {
            addId(index.cellLineByDrug, drug, edgeId);
          }
          continue;
        }

        if (relationship === 'cell-line_disease') {
          const edge: IndexedHyperedge = {
            relationship,
            order: entities.length,
            entities,
            key: buildHyperedgeKey(relationship, entities),
          };
          const edgeId = index.cellLineDiseaseEdges.push(edge) - 1;
          addId(
            index.cellLineDiseaseByDisease,
            entities[entities.length - 1],
            edgeId,
          );
        }
      }
    }

    this.cachedIndex = index;
    return index;
  }

  private retrieveInformativeHyperedges(
    query: { drug: string; protein: string; disease: string },
    args: LocalGraphToolArgs,
    index: GraphIndex,
  ): RetrievalSummary {
    const focusUsed = uniqueStrings([
      ...normalizeContextList(args.focus),
      ...normalizeContextList(args.hypothesisFocus),
    ]);
    const candidateSeeds = new Map<string, IndexedHyperedge>();
    const exactQueryKey = buildHyperedgeKey(this.relationshipType, [
      query.drug,
      query.protein,
      query.disease,
    ]);

    const addEdge = (edge: IndexedHyperedge): void => {
      if (edge.key === exactQueryKey) {
        return;
      }
      candidateSeeds.set(edge.key, edge);
    };

    const targetCandidateIds = new Set<number>([
      ...(index.targetByDrug.get(query.drug) ?? []),
      ...(index.targetByProtein.get(query.protein) ?? []),
      ...(index.targetByDisease.get(query.disease) ?? []),
    ]);
    for (const tripletId of targetCandidateIds) {
      const triplet = index.targetTriplets[tripletId];
      addEdge({
        relationship: this.relationshipType,
        order: 3,
        entities: [triplet.drug, triplet.protein, triplet.disease],
        key: buildHyperedgeKey(this.relationshipType, [
          triplet.drug,
          triplet.protein,
          triplet.disease,
        ]),
      });
    }

    for (const edgeId of new Set([
      ...(index.drugDiseaseByDrug.get(query.drug) ?? []),
      ...(index.drugDiseaseByDisease.get(query.disease) ?? []),
    ])) {
      addEdge(index.drugDiseaseEdges[edgeId]);
    }
    for (const edgeId of new Set(
      index.proteinProteinByProtein.get(query.protein) ?? [],
    )) {
      addEdge(index.proteinProteinEdges[edgeId]);
    }
    for (const edgeId of new Set(
      index.sideEffectByDrug.get(query.drug) ?? [],
    )) {
      addEdge(index.sideEffectEdges[edgeId]);
    }
    for (const edgeId of new Set(index.cellLineByDrug.get(query.drug) ?? [])) {
      addEdge(index.cellLineEdges[edgeId]);
    }
    for (const edgeId of new Set(
      index.cellLineDiseaseByDisease.get(query.disease) ?? [],
    )) {
      addEdge(index.cellLineDiseaseEdges[edgeId]);
    }

    const scoredCandidates = [...candidateSeeds.values()]
      .map((candidate): InformativeHyperedgeCandidate => {
        const matchedQueryEntities = uniqueStrings(
          candidate.entities.filter(
            (entity) =>
              entity === query.drug ||
              entity === query.protein ||
              entity === query.disease,
          ),
        );
        const introducedEntities = uniqueStrings(
          candidate.entities.filter(
            (entity) => !matchedQueryEntities.includes(entity),
          ),
        );
        const bridgeEntities = uniqueStrings(
          introducedEntities.filter(
            (entity) =>
              index.drugsByProtein.get(query.protein)?.has(entity) ||
              index.drugsByDisease.get(query.disease)?.has(entity) ||
              index.proteinsByDrug.get(query.drug)?.has(entity) ||
              index.proteinsByDisease.get(query.disease)?.has(entity) ||
              index.diseasesByDrug.get(query.drug)?.has(entity) ||
              index.diseasesByProtein.get(query.protein)?.has(entity),
          ),
        );
        const overlapWeight =
          (matchedQueryEntities.includes(query.drug) ? 2.5 : 0) +
          (matchedQueryEntities.includes(query.protein) ? 3.2 : 0) +
          (matchedQueryEntities.includes(query.disease) ? 3 : 0);
        const candidatePairOverlap = pairOverlapCount(candidate, query);
        const pairBonus =
          candidate.relationship === this.relationshipType
            ? candidatePairOverlap * 2.4
            : candidate.relationship === 'drug_disease' &&
                candidatePairOverlap >= 1
              ? 1.8 + candidatePairOverlap
              : candidate.relationship === 'protein_protein'
                ? 1.6
                : candidate.relationship === 'cell-line_disease'
                  ? 1.2
                  : candidate.relationship === 'drug_drug_cell-line'
                    ? 1
                    : candidate.relationship === 'drug_drug_sideeffect'
                      ? 0.8
                      : 0;
        const rarityBonus = matchedQueryEntities.reduce(
          (sum, entity) => sum + frequencyBonus(entity, index.entityFrequency),
          0,
        );
        const score = Number.parseFloat(
          (
            overlapWeight +
            relationPriority(candidate.relationship, this.relationshipType) +
            orderSpecificityScore(candidate.order) +
            pairBonus +
            Math.min(bridgeEntities.length, 3) * 1.35 +
            rarityBonus +
            relationFocusBonus(candidate.relationship, focusUsed)
          ).toFixed(3),
        );

        return {
          relationship: candidate.relationship,
          order: candidate.order,
          entities: candidate.entities,
          matchedQueryEntities,
          introducedEntities,
          anchorOverlapCount: matchedQueryEntities.length,
          pairOverlapCount: candidatePairOverlap,
          bridgeToTargetCount: bridgeEntities.length,
          relationPriority: relationPriority(
            candidate.relationship,
            this.relationshipType,
          ),
          score,
          rationale: summarizeCandidateRationale(
            candidate,
            query,
            matchedQueryEntities,
            bridgeEntities,
            this.relationshipType,
          ),
        };
      })
      .filter((candidate) => candidate.anchorOverlapCount > 0)
      .sort((left, right) => right.score - left.score);

    const maxCandidates =
      typeof args.maxCandidates === 'number' &&
      Number.isFinite(args.maxCandidates)
        ? Math.max(3, Math.min(12, Math.trunc(args.maxCandidates)))
        : 8;

    return deriveRetrievalSummary(
      selectDiverseCandidates(
        scoredCandidates,
        maxCandidates,
        this.relationshipType,
      ),
      query,
      this.relationshipType,
      focusUsed,
    );
  }

  inspectSample(
    sample: BiomedTaskSample,
    args: LocalGraphToolArgs = {},
  ): ResearchToolResult {
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

    const index = this.loadGraphIndex();
    const filtered = index.targetTriplets.filter(
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

    const baseEvidence = {
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
    const localInterpretation = deriveBiologicalNarratives(baseEvidence, {
      drug,
      protein,
      disease,
    });
    const retrievalSummary = this.retrieveInformativeHyperedges(
      { drug, protein, disease },
      args,
      index,
    );
    const overallTier = maxSupportTier(
      localInterpretation.supportTier,
      retrievalSummary.retrievalTier,
    );
    const evidence: LocalGraphEvidence = {
      ...baseEvidence,
      localSupportTier: localInterpretation.supportTier,
      retrievalTier: retrievalSummary.retrievalTier,
      supportTier: overallTier,
      biologicalNarratives: uniqueStrings([
        ...localInterpretation.biologicalNarratives,
        ...retrievalSummary.narratives,
      ]),
    };

    const summaryParts = [
      `Graph retrieval for (${drug}, ${protein}, ${disease}) excludes the queried hyperedge itself.`,
      `Same-type positive neighbors: drug-protein=${evidence.sharedDrugProteinCount}, drug-disease=${evidence.sharedDrugDiseaseCount}, protein-disease=${evidence.sharedProteinDiseaseCount}.`,
      `Pair coverage count: ${evidence.pairCoverageCount}. Support score: ${evidence.supportScore}.`,
      `Three-way closure=${evidence.threeWayClosure}. Backbone flags: protein-disease=${evidence.proteinDiseaseBackbone}, drug-protein=${evidence.drugProteinBackbone}, drug-disease=${evidence.drugDiseaseBackbone}.`,
      `Single-entity neighborhood sizes: drug=${evidence.sharedDrugCount}, protein=${evidence.sharedProteinCount}, disease=${evidence.sharedDiseaseCount}.`,
      `Tier summary: local=${evidence.localSupportTier}, retrieval=${evidence.retrievalTier}, overall=${evidence.supportTier}.`,
      `Biological interpretation: ${evidence.biologicalNarratives.join(' ')}`,
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
    if (retrievalSummary.topCandidates.length > 0) {
      summaryParts.push(
        `Top informative hyperedges: ${retrievalSummary.topCandidates
          .slice(0, 3)
          .map(
            (candidate) =>
              `${candidate.relationship}[score=${candidate.score}] ${candidate.rationale}`,
          )
          .join(' ')}`,
      );
    }

    return {
      toolName: 'local_graph_tool',
      status: 'ok',
      textSummary: summaryParts.join(' '),
      structured: {
        query: { drug, protein, disease },
        leakageControl:
          'Exact queried hyperedge is excluded from same-type local counts and from ranked hyperedge retrieval results.',
        positiveNeighborhood: evidence,
        informativeHyperedgeRetrieval: {
          strategy:
            'Combine same-type triplet closure with cross-relationship anchor retrieval, then rank candidate hyperedges by overlap, bridgeability back into positive triplets, and biological information value.',
          focusUsed: retrievalSummary.focusUsed,
          relationshipHistogram: retrievalSummary.relationshipHistogram,
          topCandidates: retrievalSummary.topCandidates,
          retrievalTier: retrievalSummary.retrievalTier,
          narratives: retrievalSummary.narratives,
        },
        biologicalInterpretation: {
          supportTier: evidence.supportTier,
          narratives: evidence.biologicalNarratives,
        },
      },
    };
  }
}
