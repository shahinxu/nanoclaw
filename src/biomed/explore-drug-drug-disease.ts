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
 */


import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import { BiomedWorkflowRunner } from './runner.js';
import { DEFAULT_BIOMED_CONFIG } from './config.js';
import type { BiomedTaskSample, SampleTraceRecord, WorkflowResult } from './types.js';

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
  /** Write one JSONL record per effective pair (with Stage 2 results) to this file */
  jsonlPath: string;
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
    jsonlPath: '/tmp/drug_drug_pairs.jsonl',
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
      case '--jsonlPath':
        opts.jsonlPath = next;
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

/**
 * Strip LLM voting-prefix boilerplate from agent evidence text.
 * Removes patterns like "I currently vote 1 because " so only the actual
 * reasoning/evidence content is stored in the JSONL record.
 */
function stripVotePrefix(text: string): string {
  return text
    .replace(/^I (?:currently )?vote \d+ because /i, '')
    .trim();
}

/** Load CUI → human-readable name mapping from node_side_effect_description.csv */
async function loadCuiToNameMap(workspaceRoot: string): Promise<Map<string, string>> {
  const csvPath = path.join(workspaceRoot, 'data_node', 'node_side_effect_description.csv');
  const map = new Map<string, string>();
  if (!fs.existsSync(csvPath)) return map;
  const rl = readline.createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const [cui, nodeName] = line.split(',');
    if (cui && nodeName) map.set(cui.trim(), nodeName.trim());
  }
  return map;
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

/** Read every order_*.csv in trainingDir once and return pre-split rows. */
async function loadAllCsvLines(trainingDir: string): Promise<string[][]> {
  const files = fs
    .readdirSync(trainingDir)
    .filter((f: string) => /^order_.*\.csv$/u.test(f));
  const result: string[][] = [];
  for (const file of files) {
    const raw = await readCsvLines(path.join(trainingDir, file));
    for (const line of raw) {
      if (line.trim()) result.push(line.split(','));
    }
  }
  return result;
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

function discoverDrugs(lines: string[][], diseaseId: string): DiscoveryResult {
  const knownHS = new Set<string>();
  const hsProteins = new Set<string>();
  const neighborDiseases = new Set<string>();

  // ── Pass A: collect known HS drugs, HS proteins, HS neighbor diseases ─
  for (const parts of lines) {
    if (parts.length < 3) continue;
    const rel = parts[0];
    const rest = parts.slice(1);
    if (rest[rest.length - 1] !== '1') continue;

    if (
      (rel === 'drug_protein_disease' || rel === 'drug_disease') &&
      rest.includes(diseaseId)
    ) {
      for (const v of rest.slice(0, -1)) {
        if (v.startsWith('DB')) knownHS.add(v);
      }
    }
    if (rel === 'drug_protein_disease' && rest.length >= 4) {
      const [, protein, disease] = rest;
      if (disease === diseaseId) hsProteins.add(protein);
    }
    if (rel === 'disease_disease') {
      const [e1, e2] = rest;
      if (e1 === diseaseId) neighborDiseases.add(e2);
      else if (e2 === diseaseId) neighborDiseases.add(e1);
    }
  }

  // ── Pass B: strategies 2, 3, 4 — all depend on Pass A results ────────
  const drugProteins = new Map<string, Set<string>>();
  const neighborDiseaseDrugs = new Set<string>();
  const neighborBreadth = new Map<string, number>();
  const cooccurDrugs = new Set<string>();

  for (const parts of lines) {
    if (parts.length < 3) continue;
    const rel = parts[0];
    const label = parts[parts.length - 1];

    // Strategy 2: mechanism-sharing drugs
    if (rel === 'drug_protein_disease' && parts.length >= 5 && label === '1') {
      const drug = parts[1];
      const protein = parts[2];
      if (!knownHS.has(drug) && hsProteins.has(protein)) {
        if (!drugProteins.has(drug)) drugProteins.set(drug, new Set());
        drugProteins.get(drug)!.add(protein);
      }
    }

    if (label === '1') {
      // Strategy 3a: drug_protein_disease → neighbor disease
      if (rel === 'drug_protein_disease' && parts.length >= 5) {
        const drug = parts[1];
        const disease = parts[3];
        if (neighborDiseases.has(disease) && !knownHS.has(drug)) {
          neighborDiseaseDrugs.add(drug);
          neighborBreadth.set(drug, (neighborBreadth.get(drug) ?? 0) + 1);
        }
      }
      // Strategy 3b: drug_disease → neighbor disease
      if (rel === 'drug_disease' && parts.length >= 4) {
        const drug = parts[1];
        const disease = parts[2];
        if (neighborDiseases.has(disease) && !knownHS.has(drug)) {
          neighborDiseaseDrugs.add(drug);
          neighborBreadth.set(drug, (neighborBreadth.get(drug) ?? 0) + 1);
        }
      }
    }

    // Strategy 4: co-occurrence
    if (
      (rel === 'drug_drug_sideeffect' || rel === 'drug_drug_cell-line') &&
      parts.length >= 5
    ) {
      const d1 = parts[1];
      const d2 = parts[2];
      if (knownHS.has(d1) && d2.startsWith('DB') && !knownHS.has(d2)) cooccurDrugs.add(d2);
      if (knownHS.has(d2) && d1.startsWith('DB') && !knownHS.has(d1)) cooccurDrugs.add(d1);
    }
  }

  const mechanismDrugs = new Set(drugProteins.keys());
  const mechanismBreadth = new Map<string, number>();
  for (const [drug, proteinSet] of drugProteins) {
    mechanismBreadth.set(drug, proteinSet.size);
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

function collectDrugSideEffectProfiles(
  lines: string[][],
  drugSet: Set<string>,
): Map<string, Map<string, number>> {
  const profiles = new Map<string, Map<string, number>>();

  for (const parts of lines) {
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
  /** Full multi-round debate trace from the workflow */
  trace: SampleTraceRecord | null;
  error: string | null;
}

async function runStage1(
  tieredPairs: TieredPair[],
  diseaseId: string,
  opts: CliOptions,
  onResult?: (result: Stage1Result) => void | Promise<void>,
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
          trace: result.trace.rounds.length > 0
            ? { ...result.trace, rounds: result.trace.rounds.slice(-1) }
            : result.trace,
          error: null,
        };
        await onResult?.(r);
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
          trace: null,
          error: String(err),
        };
        await onResult?.(r);
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
}

async function runStage2(
  effectivePairs: Array<{ drug1: string; drug2: string; tier: TierName }>,
  profiles: Map<string, Map<string, number>>,
  opts: CliOptions,
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
      pairResults.push({
        drug1, drug2, tier,
        sideEffectsTested: 0,
        positiveSideEffects: [],
        negativeSideEffects: [],
        errorSideEffects: [],
      });
      continue;
    }

    let completed = 0;
    const seResults = await mapWithConcurrency(
      sideEffects,
      opts.seConcurrency,
      async (seId, idx) => {
        const sample: BiomedTaskSample = {
          sampleIndex: idx,
          relationshipType: 'drug_drug_sideeffect',
          entityDict: { drugs: [drug1, drug2], sideeffect: seId },
        };
        try {
          const result = await runner.runSample(sample);
          completed += 1;
          process.stdout.write(
            `\r    [${completed}/${sideEffects.length}] SE=${seId} => label=${result.decision.label}  `,
          );
          return { seId, label: result.decision.label as 0 | 1, error: null as string | null };
        } catch (err) {
          completed += 1;
          process.stdout.write(
            `\r    [${completed}/${sideEffects.length}] SE=${seId} => ERROR  `,
          );
          return { seId, label: 0 as const, error: String(err) };
        }
      },
    );

    console.log('');

    pairResults.push({
      drug1, drug2, tier,
      sideEffectsTested: sideEffects.length,
      positiveSideEffects: seResults.filter((d) => d.label === 1 && !d.error).map((d) => d.seId),
      negativeSideEffects: seResults.filter((d) => d.label === 0 && !d.error).map((d) => d.seId),
      errorSideEffects: seResults.filter((d) => d.error).map((d) => d.seId),
    });
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
  console.log(`JSONL output     : ${opts.jsonlPath}\n`);

  // ── Stage 0a: Multi-strategy drug discovery ───────────────────────────
  console.log('════════ Stage 0: Drug Discovery ════════');
  console.log('Loading training data...\n');
  const allLines = await loadAllCsvLines(opts.trainingDir);
  const discovery = discoverDrugs(allLines, opts.diseaseId);

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
  const seProfiles = collectDrugSideEffectProfiles(allLines, allDrugsInPairs);
  let drugsWithSE = 0;
  for (const [, seMap] of seProfiles) {
    if (seMap.size > 0) drugsWithSE += 1;
  }
  console.log(`  ${drugsWithSE} drugs have known side-effect profiles.`);

  // ── Load CUI → side-effect name mapping ──────────────────────────────
  const cui2name = await loadCuiToNameMap(opts.workspaceRoot);
  console.log(`  Loaded ${cui2name.size} CUI→name mappings.`);

  // ── Initialize JSONL output (one record per effective pair) ───────────
  fs.writeFileSync(opts.jsonlPath, '', 'utf8'); // clear/create

  // In-memory tracking for stage2Map (used by Stage 3)
  const stage2ResultsInline: Stage2PairResult[] = [];

  // ── Stage 1: drug_drug_disease debate ──────────────────────────────────
  const stage1Results: Stage1Result[] = await runStage1(
      tieredPairs,
      opts.diseaseId,
      opts,
      async (r) => {
        if (!r.error && r.predictedLabel === 1) {

          // ── Immediately run Stage 2 for this effective pair ────────────
          const s2Results = await runStage2(
            [{ drug1: r.drug1, drug2: r.drug2, tier: r.tier }],
            seProfiles,
            opts,
          );
          const s2 = s2Results[0] ?? {
            drug1: r.drug1, drug2: r.drug2, tier: r.tier,
            sideEffectsTested: 0, positiveSideEffects: [],
            negativeSideEffects: [], errorSideEffects: [], details: [],
          };
          stage2ResultsInline.push(s2);

          // ── Extract per-role evidence from Stage 1 trace ───────────────
          const asmMap = new Map<string, any>(
            ((r.trace as any)?.assessments ?? []).map((a: any) => [a.role, a]),
          );
          const drugAgent = asmMap.get('drug');
          const diseaseAgent = asmMap.get('disease');
          const graphAgent = asmMap.get('graph');

          // ── Map CUI codes to human-readable side-effect names ──────────
          const positiveSENames = (s2.positiveSideEffects ?? []).map(
            (cui: string) => cui2name.get(cui) ?? cui,
          );

          // ── Write JSONL record ─────────────────────────────────────────
          const record = {
            drug1: r.drug1,
            drug2: r.drug2,
            stage1_label: r.predictedLabel,
            confidence: r.confidence,
            drug_agent_label: drugAgent?.recommendedLabel ?? null,
            drug_agent_evidence: stripVotePrefix(drugAgent?.evidenceItems?.[0]?.claim ?? ''),
            disease_agent_label: diseaseAgent?.recommendedLabel ?? null,
            disease_agent_evidence: stripVotePrefix(diseaseAgent?.evidenceItems?.[0]?.claim ?? ''),
            graph_agent_label: graphAgent?.recommendedLabel ?? null,
            graph_agent_evidence: stripVotePrefix(graphAgent?.evidenceItems?.[0]?.claim ?? ''),
            sideEffects: positiveSENames,
          };
          fs.appendFileSync(opts.jsonlPath, JSON.stringify(record) + '\n', 'utf8');
        }
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

  // ── Stage 2 was already run inline during Stage 1 for each effective pair ──
  if (effectivePairs.length === 0) {
    console.log('\nNo effective pairs found — Stage 2 not needed.');
  } else {
    console.log(`\nStage 2 complete: ${stage2ResultsInline.length} pairs processed inline.`);
  }

  // Build stage2Map from inline results collected during Stage 1
  const stage2Map = new Map<string, Stage2PairResult>();
  for (const s2 of stage2ResultsInline) {
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

  console.log(`\nJSONL records    : ${opts.jsonlPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
