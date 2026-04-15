/**
 * explore-drug-drug-disease.ts
 *
 * Broad three-stage pipeline for Hidradenitis suppurativa drug-pair discovery.
 *
 * Drug discovery uses FOUR strategies to maximise coverage:
 *
 *   Strategy 1 — Known positives:
 *     Drugs directly linked to HS (drug_protein_disease or drug_disease, label=1).
 *
 *   Strategy 2 — Mechanism-sharing:
 *     Drugs that share mechanism proteins with Strategy 1 drugs.
 *
 *   Strategy 3 — Neighbor-disease:
 *     Drugs linked (label=1) to diseases that neighbor HS in the
 *     disease–disease network.
 *
 *   Strategy 4 — Graph co-occurrence:
 *     Drugs that co-occur with Strategy 1 drugs in any
 *     drug_drug_sideeffect or drug_drug_cell-line edge.
 *
 * Drug pairs are generated in priority tiers:
 *   Tier A  known HS × known HS          (highest confidence)
 *   Tier B  mechanism-sharing × known HS  (high)
 *   Tier C  neighbor-disease × known HS   (medium, excl. already in B)
 *   Tier D  co-occurrence × known HS      (lower, excl. already in B+C)
 *
 * Each tier can be capped with --tierBLimit, --tierCLimit, --tierDLimit.
 *
 * The three evaluation stages:
 *   Stage 1 — drug_drug_disease multi-debate   → effective / ineffective
 *   Stage 2 — drug_drug_sideeffect multi-debate → side-effect screening
 *   Stage 3 — Three-way classification:
 *     effective_no_sideeffect / effective_with_sideeffect / ineffective
 *
 * Usage:
 *   npx tsx src/biomed/explore-drug-drug-disease.ts \
 *     --diseaseId MONDO:0006559 \
 *     --maxRounds 5 \
 *     --tiers A,B,C,D \
 *     --tierBLimit 200 --tierCLimit 500 --tierDLimit 500 \
 *     --outputPath /tmp/hs_drug_drug_pipeline.json
 */

import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import { BiomedWorkflowRunner } from './runner.js';
import { DEFAULT_BIOMED_CONFIG } from './config.js';
import type { BiomedTaskSample, WorkflowResult } from './types.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type TierName = 'A' | 'B' | 'C' | 'D';

interface CliOptions {
  diseaseId: string;
  trainingDir: string;
  workspaceRoot: string;
  dataDir: string;
  pythonExecutable: string;
  openRouterApiKeyPath: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  maxRounds: number; // rounds for drug_drug_disease debate
  maxSERounds: number; // rounds for drug_drug_sideeffect debate
  concurrency: number; // concurrency for Stage 1
  seConcurrency: number; // concurrency for Stage 2
  topKSideEffects: number; // max side effects per pair (0 = all)
  tiers: TierName[]; // which tiers to run
  tierBLimit: number; // max pairs from Tier B (0 = all)
  tierCLimit: number; // max pairs from Tier C (0 = all)
  tierDLimit: number; // max pairs from Tier D (0 = all)
  outputPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    diseaseId: 'MONDO:0006559',
    trainingDir: DEFAULT_BIOMED_CONFIG.graphDataDir,
    workspaceRoot: DEFAULT_BIOMED_CONFIG.workspaceRoot,
    dataDir: DEFAULT_BIOMED_CONFIG.dataDir,
    pythonExecutable: DEFAULT_BIOMED_CONFIG.pythonExecutable,
    openRouterApiKeyPath: DEFAULT_BIOMED_CONFIG.openRouterApiKeyPath,
    openRouterBaseUrl: DEFAULT_BIOMED_CONFIG.openRouterBaseUrl,
    openRouterModel: DEFAULT_BIOMED_CONFIG.openRouterModel,
    maxRounds: 5,
    maxSERounds: 3,
    concurrency: 2,
    seConcurrency: 2,
    topKSideEffects: 20,
    tiers: ['A', 'B', 'C', 'D'],
    tierBLimit: 0,
    tierCLimit: 0,
    tierDLimit: 0,
    outputPath: '/tmp/hs_drug_drug_pipeline.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--diseaseId':
        opts.diseaseId = next;
        i += 1;
        break;
      case '--trainingDir':
        opts.trainingDir = next;
        i += 1;
        break;
      case '--workspaceRoot':
        opts.workspaceRoot = next;
        i += 1;
        break;
      case '--dataDir':
        opts.dataDir = next;
        i += 1;
        break;
      case '--pythonExecutable':
        opts.pythonExecutable = next;
        i += 1;
        break;
      case '--openRouterApiKeyPath':
        opts.openRouterApiKeyPath = next;
        i += 1;
        break;
      case '--openRouterBaseUrl':
        opts.openRouterBaseUrl = next;
        i += 1;
        break;
      case '--openRouterModel':
        opts.openRouterModel = next;
        i += 1;
        break;
      case '--maxRounds':
        opts.maxRounds = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--maxSERounds':
        opts.maxSERounds = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--concurrency':
        opts.concurrency = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--seConcurrency':
        opts.seConcurrency = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--topKSideEffects':
        opts.topKSideEffects = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--tiers':
        opts.tiers = next
          .split(',')
          .map((t) => t.trim().toUpperCase() as TierName);
        i += 1;
        break;
      case '--tierBLimit':
        opts.tierBLimit = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--tierCLimit':
        opts.tierCLimit = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--tierDLimit':
        opts.tierDLimit = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--outputPath':
        opts.outputPath = next;
        i += 1;
        break;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeVotes(result: WorkflowResult) {
  const experts = (result.trace.assessments ?? []).filter(
    (a) => a.role !== 'arbiter',
  );
  const pos = experts.filter((a) => a.recommendedLabel === 1).length;
  return {
    positiveVotes: pos,
    negativeVotes: experts.length - pos,
    expertCount: experts.length,
    positiveVoteProb: experts.length > 0 ? pos / experts.length : 0.5,
    votesByRole: experts.map((a) => ({
      role: a.role,
      label: a.recommendedLabel,
      summary: a.summary,
    })),
  };
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function readCsvLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Stage 0: Multi-strategy drug discovery
// ---------------------------------------------------------------------------

interface DiscoveryResult {
  /** Strategy 1: drugs with direct positive link to the target disease */
  knownHS: Set<string>;
  /** Strategy 2: drugs sharing mechanism proteins with Strategy 1 */
  mechanismDrugs: Set<string>;
  /** Strategy 3: drugs linked to diseases neighbouring the target */
  neighborDiseaseDrugs: Set<string>;
  /** Strategy 4: drugs co-occurring with Strategy 1 drugs in edges */
  cooccurDrugs: Set<string>;
  /** Proteins used by known HS drugs (used to score mechanism sharing) */
  hsProteins: Set<string>;
  /** Mechanism drug → number of shared proteins with HS drugs */
  mechanismBreadth: Map<string, number>;
  /** Neighbor-disease drug → number of neighbor diseases it covers */
  neighborBreadth: Map<string, number>;
}

async function discoverDrugs(
  trainingDir: string,
  diseaseId: string,
): Promise<DiscoveryResult> {
  const knownHS = new Set<string>();
  const hsProteins = new Set<string>();
  const neighborDiseases = new Set<string>();

  const files = fs
    .readdirSync(trainingDir)
    .filter((f: string) => /^order_.*\.csv$/u.test(f));

  // ── Pass 1: collect known HS drugs, HS proteins, HS neighbor diseases ─
  for (const file of files) {
    const lines = await readCsvLines(path.join(trainingDir, file));
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const [rel, ...rest] = parts;
      const label = rest[rest.length - 1];

      if (label === '1') {
        // Strategy 1
        if (
          (rel === 'drug_protein_disease' || rel === 'drug_disease') &&
          rest.includes(diseaseId)
        ) {
          for (const v of rest.slice(0, -1)) {
            if (v.startsWith('DB')) knownHS.add(v);
          }
        }
        // Collect HS proteins
        if (rel === 'drug_protein_disease' && rest.length >= 4) {
          const [drug, protein, disease] = rest;
          if (disease === diseaseId) {
            hsProteins.add(protein);
          }
        }
        // Neighbor diseases
        if (rel === 'disease_disease') {
          const [e1, e2] = rest;
          if (e1 === diseaseId) neighborDiseases.add(e2);
          else if (e2 === diseaseId) neighborDiseases.add(e1);
        }
      }
    }
  }

  // ── Pass 2: Strategy 2 — drugs sharing HS mechanism proteins ──────────
  // Also builds protein→drug map for breadth scoring
  const drugProteins = new Map<string, Set<string>>();
  for (const file of files) {
    const lines = await readCsvLines(path.join(trainingDir, file));
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 5) continue;
      const [rel, drug, protein, , label] = parts;
      if (rel !== 'drug_protein_disease' || label !== '1') continue;
      if (knownHS.has(drug)) continue;
      if (!hsProteins.has(protein)) continue;

      if (!drugProteins.has(drug)) drugProteins.set(drug, new Set());
      drugProteins.get(drug)!.add(protein);
    }
  }
  const mechanismDrugs = new Set(drugProteins.keys());
  const mechanismBreadth = new Map<string, number>();
  for (const [drug, proteinSet] of drugProteins) {
    mechanismBreadth.set(drug, proteinSet.size);
  }

  // ── Pass 3: Strategy 3 — drugs linked to neighbor diseases ────────────
  const neighborDiseaseDrugs = new Set<string>();
  const neighborBreadth = new Map<string, number>();
  for (const file of files) {
    const lines = await readCsvLines(path.join(trainingDir, file));
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const [rel, ...rest] = parts;
      const label = rest[rest.length - 1];
      if (label !== '1') continue;

      if (rel === 'drug_protein_disease' && rest.length >= 4) {
        const [drug, , disease] = rest;
        if (neighborDiseases.has(disease) && !knownHS.has(drug)) {
          neighborDiseaseDrugs.add(drug);
          neighborBreadth.set(drug, (neighborBreadth.get(drug) ?? 0) + 1);
        }
      }
      if (rel === 'drug_disease' && rest.length >= 3) {
        const [drug, disease] = rest;
        if (neighborDiseases.has(disease) && !knownHS.has(drug)) {
          neighborDiseaseDrugs.add(drug);
          neighborBreadth.set(drug, (neighborBreadth.get(drug) ?? 0) + 1);
        }
      }
    }
  }

  // ── Pass 4: Strategy 4 — co-occurring drugs ──────────────────────────
  const cooccurDrugs = new Set<string>();
  for (const file of files) {
    const lines = await readCsvLines(path.join(trainingDir, file));
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 5) continue;
      const [rel, d1, d2] = parts;
      if (rel !== 'drug_drug_sideeffect' && rel !== 'drug_drug_cell-line')
        continue;
      if (knownHS.has(d1) && d2.startsWith('DB') && !knownHS.has(d2)) {
        cooccurDrugs.add(d2);
      }
      if (knownHS.has(d2) && d1.startsWith('DB') && !knownHS.has(d1)) {
        cooccurDrugs.add(d1);
      }
    }
  }

  return {
    knownHS,
    mechanismDrugs,
    neighborDiseaseDrugs,
    cooccurDrugs,
    hsProteins,
    mechanismBreadth,
    neighborBreadth,
  };
}

// ---------------------------------------------------------------------------
// Tiered pair generation
// ---------------------------------------------------------------------------

interface TieredPair {
  drug1: string;
  drug2: string;
  tier: TierName;
  /** Higher = more promising */
  score: number;
}

function generateTieredPairs(
  discovery: DiscoveryResult,
  opts: CliOptions,
): TieredPair[] {
  const pairs: TieredPair[] = [];
  const seenKeys = new Set<string>();

  function addPair(d1: string, d2: string, tier: TierName, score: number) {
    const key = d1 < d2 ? `${d1}::${d2}` : `${d2}::${d1}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    pairs.push({
      drug1: d1 < d2 ? d1 : d2,
      drug2: d1 < d2 ? d2 : d1,
      tier,
      score,
    });
  }

  const hsArr = [...discovery.knownHS].sort();

  // Tier A: known HS × known HS (always all)
  if (opts.tiers.includes('A')) {
    for (let i = 0; i < hsArr.length; i++) {
      for (let j = i + 1; j < hsArr.length; j++) {
        addPair(hsArr[i], hsArr[j], 'A', 1000);
      }
    }
  }

  // Tier B: mechanism-sharing × known HS, scored by breadth desc
  if (opts.tiers.includes('B')) {
    const sorted = [...discovery.mechanismDrugs].sort(
      (a, b) =>
        (discovery.mechanismBreadth.get(b) ?? 0) -
        (discovery.mechanismBreadth.get(a) ?? 0),
    );
    let count = 0;
    for (const candidate of sorted) {
      for (const hs of hsArr) {
        addPair(
          candidate,
          hs,
          'B',
          discovery.mechanismBreadth.get(candidate) ?? 0,
        );
        count += 1;
      }
      if (opts.tierBLimit > 0 && count >= opts.tierBLimit) break;
    }
  }

  // Tier C: neighbor-disease × known HS (excl. already in B), scored by neighbor breadth
  if (opts.tiers.includes('C')) {
    const excl = new Set([...discovery.knownHS, ...discovery.mechanismDrugs]);
    const candidatesC = [...discovery.neighborDiseaseDrugs]
      .filter((d) => !excl.has(d))
      .sort(
        (a, b) =>
          (discovery.neighborBreadth.get(b) ?? 0) -
          (discovery.neighborBreadth.get(a) ?? 0),
      );
    let count = 0;
    for (const candidate of candidatesC) {
      for (const hs of hsArr) {
        addPair(
          candidate,
          hs,
          'C',
          discovery.neighborBreadth.get(candidate) ?? 0,
        );
        count += 1;
      }
      if (opts.tierCLimit > 0 && count >= opts.tierCLimit) break;
    }
  }

  // Tier D: co-occurrence × known HS (excl. already in B+C)
  if (opts.tiers.includes('D')) {
    const excl = new Set([
      ...discovery.knownHS,
      ...discovery.mechanismDrugs,
      ...discovery.neighborDiseaseDrugs,
    ]);
    const candidatesD = [...discovery.cooccurDrugs]
      .filter((d) => !excl.has(d))
      .sort();
    let count = 0;
    for (const candidate of candidatesD) {
      for (const hs of hsArr) {
        addPair(candidate, hs, 'D', 1);
        count += 1;
      }
      if (opts.tierDLimit > 0 && count >= opts.tierDLimit) break;
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Side-effect profile collection
// ---------------------------------------------------------------------------

async function collectDrugSideEffectProfiles(
  trainingDir: string,
  drugSet: Set<string>,
): Promise<Map<string, Map<string, number>>> {
  const profiles = new Map<string, Map<string, number>>();

  const files = fs
    .readdirSync(trainingDir)
    .filter((f: string) => /^order_.*\.csv$/u.test(f));

  for (const file of files) {
    const lines = await readCsvLines(path.join(trainingDir, file));
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 5) continue;
      const [rel, d1, d2, se, label] = parts;
      if (rel !== 'drug_drug_sideeffect' || label !== '1') continue;

      for (const d of [d1, d2]) {
        if (!drugSet.has(d)) continue;
        if (!profiles.has(d)) profiles.set(d, new Map());
        const seMap = profiles.get(d)!;
        seMap.set(se, (seMap.get(se) ?? 0) + 1);
      }
    }
  }
  return profiles;
}

function pickSideEffectsForPair(
  d1: string,
  d2: string,
  profiles: Map<string, Map<string, number>>,
  topK: number,
): string[] {
  const merged = new Map<string, number>();
  for (const d of [d1, d2]) {
    const seMap = profiles.get(d);
    if (!seMap) continue;
    for (const [se, count] of seMap) {
      merged.set(se, (merged.get(se) ?? 0) + count);
    }
  }
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]);
  const picked = sorted.map(([se]) => se);
  return topK > 0 ? picked.slice(0, topK) : picked;
}

// ---------------------------------------------------------------------------
// Stage 1: drug_drug_disease debate
// ---------------------------------------------------------------------------

interface Stage1Result {
  drug1: string;
  drug2: string;
  tier: TierName;
  score: number;
  predictedLabel: 0 | 1;
  confidence: number;
  positiveVoteProb: number;
  rationale: string;
  votesByRole: Array<{ role: string; label: number; summary: string }>;
  error: string | null;
}

async function runStage1(
  tieredPairs: TieredPair[],
  diseaseId: string,
  opts: CliOptions,
  onResult?: (result: Stage1Result) => void,
): Promise<Stage1Result[]> {
  console.log(
    `\n=== Stage 1: drug_drug_disease debate (${tieredPairs.length} pairs) ===`,
  );
  const tierCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const p of tieredPairs) tierCounts[p.tier] += 1;
  console.log(
    `  Tier A=${tierCounts.A}  Tier B=${tierCounts.B}  Tier C=${tierCounts.C}  Tier D=${tierCounts.D}\n`,
  );

  const runner = new BiomedWorkflowRunner({
    ...DEFAULT_BIOMED_CONFIG,
    workspaceRoot: opts.workspaceRoot,
    dataDir: opts.dataDir,
    pythonExecutable: opts.pythonExecutable,
    openRouterApiKeyPath: opts.openRouterApiKeyPath,
    openRouterBaseUrl: opts.openRouterBaseUrl,
    openRouterModel: opts.openRouterModel,
    graphDataDir: opts.trainingDir,
    relationshipType: 'drug_drug_disease',
    maxRounds: opts.maxRounds,
  });

  let completed = 0;
  const total = tieredPairs.length;

  const results = await mapWithConcurrency(
    tieredPairs,
    opts.concurrency,
    async (pair, idx) => {
      const sample: BiomedTaskSample = {
        sampleIndex: idx,
        relationshipType: 'drug_drug_disease',
        entityDict: {
          drugs: [pair.drug1, pair.drug2],
          disease: diseaseId,
        },
      };

      try {
        const result = await runner.runSample(sample);
        completed += 1;
        const votes = summarizeVotes(result);
        process.stdout.write(
          `\r  [${completed}/${total}] Tier ${pair.tier}: ${pair.drug1}+${pair.drug2} => label=${result.decision.label} votes=${votes.positiveVotes}/${votes.expertCount}  `,
        );
        const r: Stage1Result = {
          drug1: pair.drug1,
          drug2: pair.drug2,
          tier: pair.tier,
          score: pair.score,
          predictedLabel: result.decision.label as 0 | 1,
          confidence: result.decision.confidence,
          positiveVoteProb: votes.positiveVoteProb,
          rationale: result.decision.rationale,
          votesByRole: votes.votesByRole,
          error: null,
        };
        onResult?.(r);
        return r;
      } catch (err) {
        completed += 1;
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          `\r  [${completed}/${total}] Tier ${pair.tier}: ${pair.drug1}+${pair.drug2} => ERROR: ${errMsg.slice(0, 200)}\n`,
        );
        const r: Stage1Result = {
          drug1: pair.drug1,
          drug2: pair.drug2,
          tier: pair.tier,
          score: pair.score,
          predictedLabel: 0 as const,
          confidence: 0,
          positiveVoteProb: 0,
          rationale: '',
          votesByRole: [],
          error: String(err),
        };
        onResult?.(r);
        return r;
      }
    },
  );

  console.log('\n');
  return results;
}

// ---------------------------------------------------------------------------
// Stage 2: drug_drug_sideeffect debate for effective pairs
// ---------------------------------------------------------------------------

interface Stage2PairResult {
  drug1: string;
  drug2: string;
  tier: TierName;
  sideEffectsTested: number;
  positiveSideEffects: string[];
  negativeSideEffects: string[];
  errorSideEffects: string[];
  details: Array<{
    sideEffectId: string;
    predictedLabel: 0 | 1;
    confidence: number;
    positiveVoteProb: number;
    error: string | null;
  }>;
}

async function runStage2(
  effectivePairs: Array<{ drug1: string; drug2: string; tier: TierName }>,
  profiles: Map<string, Map<string, number>>,
  opts: CliOptions,
  onPairDone?: (result: Stage2PairResult) => void,
): Promise<Stage2PairResult[]> {
  console.log(
    `\n=== Stage 2: drug_drug_sideeffect debate (${effectivePairs.length} effective pairs) ===\n`,
  );

  const runner = new BiomedWorkflowRunner({
    ...DEFAULT_BIOMED_CONFIG,
    workspaceRoot: opts.workspaceRoot,
    dataDir: opts.dataDir,
    pythonExecutable: opts.pythonExecutable,
    openRouterApiKeyPath: opts.openRouterApiKeyPath,
    openRouterBaseUrl: opts.openRouterBaseUrl,
    openRouterModel: opts.openRouterModel,
    graphDataDir: opts.trainingDir,
    relationshipType: 'drug_drug_sideeffect',
    maxRounds: opts.maxSERounds,
  });

  const pairResults: Stage2PairResult[] = [];

  for (const { drug1, drug2, tier } of effectivePairs) {
    const sideEffects = pickSideEffectsForPair(
      drug1,
      drug2,
      profiles,
      opts.topKSideEffects,
    );

    console.log(
      `  Pair ${drug1}+${drug2} [Tier ${tier}]: testing ${sideEffects.length} side effects`,
    );

    if (sideEffects.length === 0) {
      const pr: Stage2PairResult = {
        drug1,
        drug2,
        tier,
        sideEffectsTested: 0,
        positiveSideEffects: [],
        negativeSideEffects: [],
        errorSideEffects: [],
        details: [],
      };
      pairResults.push(pr);
      onPairDone?.(pr);
      continue;
    }

    let completed = 0;
    const details = await mapWithConcurrency(
      sideEffects,
      opts.seConcurrency,
      async (seId, idx) => {
        const sample: BiomedTaskSample = {
          sampleIndex: idx,
          relationshipType: 'drug_drug_sideeffect',
          entityDict: {
            drugs: [drug1, drug2],
            sideeffect: seId,
          },
        };

        try {
          const result = await runner.runSample(sample);
          completed += 1;
          const votes = summarizeVotes(result);
          process.stdout.write(
            `\r    [${completed}/${sideEffects.length}] SE=${seId} => label=${result.decision.label}  `,
          );
          return {
            sideEffectId: seId,
            predictedLabel: result.decision.label as 0 | 1,
            confidence: result.decision.confidence,
            positiveVoteProb: votes.positiveVoteProb,
            error: null,
          };
        } catch (err) {
          completed += 1;
          process.stdout.write(
            `\r    [${completed}/${sideEffects.length}] SE=${seId} => ERROR  `,
          );
          return {
            sideEffectId: seId,
            predictedLabel: 0 as const,
            confidence: 0,
            positiveVoteProb: 0,
            error: String(err),
          };
        }
      },
    );

    console.log('');

    const pr: Stage2PairResult = {
      drug1,
      drug2,
      tier,
      sideEffectsTested: sideEffects.length,
      positiveSideEffects: details
        .filter((d) => d.predictedLabel === 1 && !d.error)
        .map((d) => d.sideEffectId),
      negativeSideEffects: details
        .filter((d) => d.predictedLabel === 0 && !d.error)
        .map((d) => d.sideEffectId),
      errorSideEffects: details
        .filter((d) => d.error)
        .map((d) => d.sideEffectId),
      details,
    };
    pairResults.push(pr);
    onPairDone?.(pr);
  }

  return pairResults;
}

// ---------------------------------------------------------------------------
// Stage 3: Three-way classification
// ---------------------------------------------------------------------------

type ThreeWayLabel =
  | 'effective_no_sideeffect'
  | 'effective_with_sideeffect'
  | 'ineffective';

interface ClassifiedPair {
  drug1: string;
  drug2: string;
  tier: TierName;
  threeWayLabel: ThreeWayLabel;
  stage1Confidence: number;
  stage1PositiveVoteProb: number;
  stage1Rationale: string;
  sideEffectsTested: number;
  positiveSideEffects: string[];
}

function classifyPairs(
  stage1Results: Stage1Result[],
  stage2Map: Map<string, Stage2PairResult>,
): ClassifiedPair[] {
  const classified: ClassifiedPair[] = [];

  for (const s1 of stage1Results) {
    if (s1.error) continue;

    const pairKey = `${s1.drug1}::${s1.drug2}`;
    const s2 = stage2Map.get(pairKey);

    let threeWayLabel: ThreeWayLabel;
    let positiveSideEffects: string[] = [];
    let sideEffectsTested = 0;

    if (s1.predictedLabel === 0) {
      threeWayLabel = 'ineffective';
    } else if (s2 && s2.positiveSideEffects.length > 0) {
      threeWayLabel = 'effective_with_sideeffect';
      positiveSideEffects = s2.positiveSideEffects;
      sideEffectsTested = s2.sideEffectsTested;
    } else {
      threeWayLabel = 'effective_no_sideeffect';
      sideEffectsTested = s2?.sideEffectsTested ?? 0;
    }

    classified.push({
      drug1: s1.drug1,
      drug2: s1.drug2,
      tier: s1.tier,
      threeWayLabel,
      stage1Confidence: s1.confidence,
      stage1PositiveVoteProb: s1.positiveVoteProb,
      stage1Rationale: s1.rationale,
      sideEffectsTested,
      positiveSideEffects,
    });
  }

  const order: Record<ThreeWayLabel, number> = {
    effective_no_sideeffect: 0,
    effective_with_sideeffect: 1,
    ineffective: 2,
  };
  classified.sort(
    (a, b) =>
      order[a.threeWayLabel] - order[b.threeWayLabel] ||
      b.stage1Confidence - a.stage1Confidence,
  );

  return classified;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `\n╔═══════════════════════════════════════════════════════════╗`,
  );
  console.log(`║  Drug-Drug-Disease Pipeline for HS  (Multi-Strategy)     ║`);
  console.log(`╚═══════════════════════════════════════════════════════════╝`);
  console.log(`Disease          : ${opts.diseaseId}`);
  console.log(`Training dir     : ${opts.trainingDir}`);
  console.log(`Tiers            : ${opts.tiers.join(', ')}`);
  console.log(
    `Tier limits      : B=${opts.tierBLimit || 'all'}  C=${opts.tierCLimit || 'all'}  D=${opts.tierDLimit || 'all'}`,
  );
  console.log(`Stage 1 rounds   : ${opts.maxRounds}`);
  console.log(`Stage 2 SE rounds: ${opts.maxSERounds}`);
  console.log(`Top-K SEs/pair   : ${opts.topKSideEffects || 'all'}`);
  console.log(
    `Concurrency      : Stage1=${opts.concurrency}  Stage2=${opts.seConcurrency}`,
  );
  console.log(`Output           : ${opts.outputPath}\n`);

  // ── Stage 0a: Multi-strategy drug discovery ───────────────────────────
  console.log('════════ Stage 0: Drug Discovery ════════');
  console.log('Running 4-strategy drug discovery...\n');
  const discovery = await discoverDrugs(opts.trainingDir, opts.diseaseId);

  console.log(
    `Strategy 1 — Known HS drugs          : ${discovery.knownHS.size}`,
  );
  for (const d of [...discovery.knownHS].sort()) console.log(`    ${d}`);
  console.log(`  (mechanism proteins: ${discovery.hsProteins.size})`);

  console.log(
    `Strategy 2 — Mechanism-sharing drugs  : ${discovery.mechanismDrugs.size}`,
  );
  const topMech = [...discovery.mechanismBreadth.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [d, b] of topMech) console.log(`    ${d} (shared proteins: ${b})`);
  if (discovery.mechanismDrugs.size > 10)
    console.log(`    ... and ${discovery.mechanismDrugs.size - 10} more`);

  console.log(
    `Strategy 3 — Neighbor-disease drugs   : ${discovery.neighborDiseaseDrugs.size}`,
  );
  console.log(
    `Strategy 4 — Co-occurrence drugs      : ${discovery.cooccurDrugs.size}`,
  );

  const allUnique = new Set([
    ...discovery.knownHS,
    ...discovery.mechanismDrugs,
    ...discovery.neighborDiseaseDrugs,
    ...discovery.cooccurDrugs,
  ]);
  console.log(`\nTotal unique candidate drugs: ${allUnique.size}`);

  // ── Stage 0b: Tiered pair generation ──────────────────────────────────
  console.log('\nGenerating tiered drug pairs...');
  const tieredPairs = generateTieredPairs(discovery, opts);
  const tierCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const p of tieredPairs) tierCounts[p.tier] += 1;
  console.log(`  Tier A (HS × HS)                : ${tierCounts.A}`);
  console.log(`  Tier B (mechanism × HS)         : ${tierCounts.B}`);
  console.log(`  Tier C (neighbor-disease × HS)  : ${tierCounts.C}`);
  console.log(`  Tier D (co-occurrence × HS)     : ${tierCounts.D}`);
  console.log(`  TOTAL pairs to evaluate         : ${tieredPairs.length}`);

  // ── Stage 0c: Build SE profiles for all drugs involved ────────────────
  const allDrugsInPairs = new Set<string>();
  for (const p of tieredPairs) {
    allDrugsInPairs.add(p.drug1);
    allDrugsInPairs.add(p.drug2);
  }

  console.log(
    `\nBuilding side-effect profiles for ${allDrugsInPairs.size} drugs...`,
  );
  const seProfiles = await collectDrugSideEffectProfiles(
    opts.trainingDir,
    allDrugsInPairs,
  );
  let drugsWithSE = 0;
  for (const [, seMap] of seProfiles) {
    if (seMap.size > 0) drugsWithSE += 1;
  }
  console.log(`  ${drugsWithSE} drugs have known side-effect profiles.`);

  // ── Incremental output ────────────────────────────────────────────────
  const liveOutput: Record<string, any> = {
    diseaseId: opts.diseaseId,
    timestamp: new Date().toISOString(),
    config: {
      maxRounds: opts.maxRounds,
      maxSERounds: opts.maxSERounds,
      topKSideEffects: opts.topKSideEffects,
      tiers: opts.tiers,
      tierBLimit: opts.tierBLimit,
      tierCLimit: opts.tierCLimit,
      tierDLimit: opts.tierDLimit,
    },
    discovery: {
      knownHSCount: discovery.knownHS.size,
      knownHS: [...discovery.knownHS].sort(),
      mechanismDrugCount: discovery.mechanismDrugs.size,
      neighborDiseaseDrugCount: discovery.neighborDiseaseDrugs.size,
      cooccurDrugCount: discovery.cooccurDrugs.size,
      totalUniqueDrugs: allUnique.size,
      hsProteins: [...discovery.hsProteins].sort(),
    },
    pairGeneration: {
      tierA: tierCounts.A,
      tierB: tierCounts.B,
      tierC: tierCounts.C,
      tierD: tierCounts.D,
      total: tieredPairs.length,
    },
    stage1: {
      effective: [] as Stage1Result[],
      ineffective: [] as Stage1Result[],
      errors: [] as Stage1Result[],
    },
    stage2: [] as Stage2PairResult[],
    summary: null as Record<ThreeWayLabel, number> | null,
    classified: null as ClassifiedPair[] | null,
  };

  function flushOutput() {
    fs.writeFileSync(
      opts.outputPath,
      JSON.stringify(liveOutput, null, 2),
      'utf8',
    );
  }
  flushOutput(); // write initial structure

  // ── Stage 1: drug_drug_disease debate ─────────────────────────────────
  const stage1Results = await runStage1(
    tieredPairs,
    opts.diseaseId,
    opts,
    (r) => {
      if (r.error) {
        liveOutput.stage1.errors.push(r);
      } else if (r.predictedLabel === 1) {
        liveOutput.stage1.effective.push(r);
      } else {
        liveOutput.stage1.ineffective.push(r);
      }
      flushOutput();
    },
  );

  const effectivePairs = stage1Results.filter(
    (r) => r.predictedLabel === 1 && !r.error,
  );
  const ineffectivePairs = stage1Results.filter(
    (r) => r.predictedLabel === 0 && !r.error,
  );
  const errorPairs = stage1Results.filter((r) => r.error);

  console.log(`Stage 1 summary:`);
  console.log(`  Effective pairs  : ${effectivePairs.length}`);
  console.log(`  Ineffective pairs: ${ineffectivePairs.length}`);
  console.log(`  Errors           : ${errorPairs.length}`);

  // Breakdown by tier
  for (const t of ['A', 'B', 'C', 'D'] as TierName[]) {
    const eff = effectivePairs.filter((r) => r.tier === t).length;
    const ineff = ineffectivePairs.filter((r) => r.tier === t).length;
    const err = errorPairs.filter((r) => r.tier === t).length;
    if (eff + ineff + err > 0) {
      console.log(
        `    Tier ${t}: ${eff} effective, ${ineff} ineffective, ${err} errors`,
      );
    }
  }

  // ── Stage 2: drug_drug_sideeffect for effective pairs ─────────────────
  let stage2Results: Stage2PairResult[] = [];
  if (effectivePairs.length > 0) {
    stage2Results = await runStage2(
      effectivePairs.map((p) => ({
        drug1: p.drug1,
        drug2: p.drug2,
        tier: p.tier,
      })),
      seProfiles,
      opts,
      (pr) => {
        liveOutput.stage2.push(pr);
        flushOutput();
      },
    );
  } else {
    console.log('\nNo effective pairs found — skipping Stage 2.');
  }

  const stage2Map = new Map<string, Stage2PairResult>();
  for (const s2 of stage2Results) {
    stage2Map.set(`${s2.drug1}::${s2.drug2}`, s2);
  }

  // ── Stage 3: three-way classification ─────────────────────────────────
  console.log('\n════════ Stage 3: Three-way Classification ════════\n');
  const classified = classifyPairs(stage1Results, stage2Map);

  const counts: Record<ThreeWayLabel, number> = {
    effective_no_sideeffect: 0,
    effective_with_sideeffect: 0,
    ineffective: 0,
  };
  for (const c of classified) counts[c.threeWayLabel] += 1;

  console.log(`╔════════════════════════════════════════════════╗`);
  console.log(`║  Final Classification Summary                  ║`);
  console.log(`╠════════════════════════════════════════════════╣`);
  console.log(
    `║  effective_no_sideeffect  : ${String(counts.effective_no_sideeffect).padStart(5)}          ║`,
  );
  console.log(
    `║  effective_with_sideeffect: ${String(counts.effective_with_sideeffect).padStart(5)}          ║`,
  );
  console.log(
    `║  ineffective              : ${String(counts.ineffective).padStart(5)}          ║`,
  );
  console.log(`╚════════════════════════════════════════════════╝\n`);

  // Per-tier breakdown
  for (const t of ['A', 'B', 'C', 'D'] as TierName[]) {
    const tierItems = classified.filter((c) => c.tier === t);
    if (tierItems.length === 0) continue;
    const safe = tierItems.filter(
      (c) => c.threeWayLabel === 'effective_no_sideeffect',
    ).length;
    const withSE = tierItems.filter(
      (c) => c.threeWayLabel === 'effective_with_sideeffect',
    ).length;
    const ineff = tierItems.filter(
      (c) => c.threeWayLabel === 'ineffective',
    ).length;
    console.log(
      `  Tier ${t}: ${safe} safe, ${withSE} with-SE, ${ineff} ineffective`,
    );
  }
  console.log('');

  // Print top results
  console.log('Top results (effective_no_sideeffect first):');
  for (const c of classified.slice(0, 50)) {
    const tag =
      c.threeWayLabel === 'effective_no_sideeffect'
        ? '✓ SAFE'
        : c.threeWayLabel === 'effective_with_sideeffect'
          ? '⚠ SE'
          : '✗ INEFF';
    const seInfo =
      c.positiveSideEffects.length > 0
        ? `  SEs: ${c.positiveSideEffects.slice(0, 5).join(', ')}${c.positiveSideEffects.length > 5 ? ` +${c.positiveSideEffects.length - 5}` : ''}`
        : '';
    console.log(
      `  [${tag}] [Tier ${c.tier}] ${c.drug1} + ${c.drug2}  conf=${c.stage1Confidence.toFixed(2)}${seInfo}`,
    );
  }

  // ── Write final output ─────────────────────────────────────────────────
  liveOutput.summary = counts;
  liveOutput.classified = classified;
  liveOutput.stage1 = {
    effective: effectivePairs,
    ineffective: ineffectivePairs,
    errors: errorPairs,
  };
  liveOutput.stage2 = stage2Results;
  liveOutput.timestamp = new Date().toISOString();
  flushOutput();
  console.log(`\nResults written to ${opts.outputPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
