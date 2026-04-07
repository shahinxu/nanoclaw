/**
 * explore-disease.ts
 *
 * Novelty-aware drug discovery for a given disease.
 *
 * Strategy:
 *  1. Load known-positive drugs for the target disease from training edges (exclusion list).
 *  2. Find all drugs in the training graph that hit disease-relevant mechanism proteins
 *     but are NOT already known positives for this disease.
 *  3. For each novel candidate, construct a synthetic drug_protein_disease sample
 *     using the most disease-relevant target protein as the mechanism anchor.
 *  4. Run each sample through the existing BiomedWorkflowRunner multi-agent debate.
 *  5. Rank by decision label + positive vote probability and write results.
 *
 * Usage:
 *   npx tsx src/biomed/explore-disease.ts \
 *     --diseaseId MONDO:0006559 \
 *     --trainingDir /home/zhx/drug_agent/data_edge_train \
 *     --maxRounds 3 \
 *     --concurrency 2 \
 *     --outputPath /tmp/explore_hs.json
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

interface CliOptions {
  diseaseId: string;
  trainingDir: string;
  maxRounds: number;
  concurrency: number;
  topK: number;
  outputPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    diseaseId: 'MONDO:0006559',
    trainingDir: DEFAULT_BIOMED_CONFIG.graphDataDir,
    maxRounds: 3,
    concurrency: 2,
    topK: 0, // 0 = no limit
    outputPath: '/tmp/explore_results.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--diseaseId' && next) { opts.diseaseId = next; i += 1; }
    else if (arg === '--trainingDir' && next) { opts.trainingDir = next; i += 1; }
    else if (arg === '--maxRounds' && next) { opts.maxRounds = Number.parseInt(next, 10); i += 1; }
    else if (arg === '--concurrency' && next) { opts.concurrency = Number.parseInt(next, 10); i += 1; }
    else if (arg === '--topK' && next) { opts.topK = Number.parseInt(next, 10); i += 1; }
    else if (arg === '--outputPath' && next) { opts.outputPath = next; i += 1; }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Mechanism protein sets (derived from MONDO:0006559 known positive targets)
// ---------------------------------------------------------------------------

const HIGH_QUALITY_PROTEINS = new Set([
  // JAK / TYK2 axis
  'JAK1', 'JAK2', 'JAK3', 'TYK2',
  // PDE4 axis
  'PDE4A', 'PDE4B', 'PDE4C', 'PDE4D',
  // Innate immune / co-stimulation
  'SYK', 'IRAK4', 'TLR7', 'TLR9', 'C5AR1',
]);

// Priority order for picking the single most representative protein per drug.
const PROTEIN_PRIORITY = [
  'JAK1', 'TYK2', 'JAK2', 'JAK3',
  'PDE4B', 'PDE4A', 'PDE4C', 'PDE4D',
  'SYK', 'IRAK4', 'TLR7', 'TLR9', 'C5AR1',
];

function pickTopProtein(proteins: string[]): string {
  for (const p of PROTEIN_PRIORITY) {
    if (proteins.includes(p)) return p;
  }
  return proteins[0];
}

function getMechanismAxis(proteins: string[]): string {
  const jakHits = proteins.filter(p => ['JAK1','JAK2','JAK3','TYK2'].includes(p));
  const pde4Hits = proteins.filter(p => ['PDE4A','PDE4B','PDE4C','PDE4D'].includes(p));
  const immuneHits = proteins.filter(p => ['SYK','IRAK4','TLR7','TLR9','C5AR1'].includes(p));
  const axes: string[] = [];
  if (jakHits.length > 0) axes.push(`JAK/TYK2(${jakHits.join('+')})`);
  if (pde4Hits.length > 0) axes.push(`PDE4(${pde4Hits.join('+')})`);
  if (immuneHits.length > 0) axes.push(immuneHits.join('/'));
  return axes.join(' + ') || 'unknown';
}

// ---------------------------------------------------------------------------
// Candidate discovery from training CSV
// ---------------------------------------------------------------------------

interface CandidateDrug {
  drugId: string;
  topProtein: string;
  targetProteins: string[];
  mechanismAxis: string;
  /** Number of unique high-quality target proteins hit (mechanism breadth) */
  breadth: number;
  /** Total positive drug_protein_disease edges hitting HQ proteins */
  supportCount: number;
}

async function discoverCandidates(
  trainingDir: string,
  diseaseId: string,
): Promise<CandidateDrug[]> {
  const knownPositives = new Set<string>();
  const drugTargets = new Map<string, Set<string>>();
  const drugSupportCount = new Map<string, number>();

  // We go through order_3.csv which holds drug_protein_disease edges.
  const edgesFile = path.join(trainingDir, 'order_3.csv');
  const rl = readline.createInterface({ input: createReadStream(edgesFile), crlfDelay: Infinity });

  for await (const line of rl) {
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const [rel, drug, protein, disease, label] = parts;
    if (rel !== 'drug_protein_disease' || label !== '1') continue;

    // Collect known positives for this disease (exclusion list).
    if (disease === diseaseId) {
      knownPositives.add(drug);
    }
  }

  // Second pass: collect drugs that hit HQ proteins, exclude known positives.
  const rl2 = readline.createInterface({ input: createReadStream(edgesFile), crlfDelay: Infinity });

  for await (const line of rl2) {
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const [rel, drug, protein, , label] = parts;
    if (rel !== 'drug_protein_disease' || label !== '1') continue;
    if (knownPositives.has(drug)) continue;
    if (!HIGH_QUALITY_PROTEINS.has(protein)) continue;

    if (!drugTargets.has(drug)) drugTargets.set(drug, new Set());
    drugTargets.get(drug)!.add(protein);
    drugSupportCount.set(drug, (drugSupportCount.get(drug) ?? 0) + 1);
  }

  const candidates: CandidateDrug[] = [];
  for (const [drugId, targetSet] of drugTargets) {
    const targetProteins = [...targetSet];
    candidates.push({
      drugId,
      topProtein: pickTopProtein(targetProteins),
      targetProteins,
      mechanismAxis: getMechanismAxis(targetProteins),
      breadth: targetProteins.length,
      supportCount: drugSupportCount.get(drugId) ?? 0,
    });
  }

  // Sort by mechanism breadth desc, then support count desc.
  candidates.sort((a, b) =>
    b.breadth !== a.breadth ? b.breadth - a.breadth : b.supportCount - a.supportCount,
  );

  return candidates;
}

// ---------------------------------------------------------------------------
// Sample construction
// ---------------------------------------------------------------------------

function buildSyntheticSample(
  candidate: CandidateDrug,
  diseaseId: string,
  sampleIndex: number,
): BiomedTaskSample {
  return {
    sampleIndex,
    relationshipType: 'drug_protein_disease',
    entityDict: {
      drug: candidate.drugId,
      drugs: [candidate.drugId],
      protein: candidate.topProtein,
      disease: diseaseId,
    },
    // No groundTruth — these are novel candidates.
  };
}

// ---------------------------------------------------------------------------
// Parallel runner
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Vote summariser (mirrors run-balanced-eval.ts)
// ---------------------------------------------------------------------------

function summarizeVotes(result: WorkflowResult) {
  const experts = (result.trace.assessments ?? []).filter(
    a => a.role !== 'arbiter',
  );
  const pos = experts.filter(a => a.recommendedLabel === 1).length;
  const neg = experts.filter(a => a.recommendedLabel === 0).length;
  return {
    positiveVotes: pos,
    negativeVotes: neg,
    expertCount: experts.length,
    positiveVoteProb: experts.length > 0 ? pos / experts.length : 0.5,
    votesByRole: experts.map(a => ({ role: a.role, label: a.recommendedLabel, summary: a.summary })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`\n=== Explore Disease: ${opts.diseaseId} ===`);
  console.log(`Training dir: ${opts.trainingDir}`);
  console.log(`maxRounds=${opts.maxRounds}  concurrency=${opts.concurrency}  topK=${opts.topK || 'all'}\n`);

  // Step 1: Discover novel candidates
  console.log('Discovering novel candidates from training graph...');
  let candidates = await discoverCandidates(opts.trainingDir, opts.diseaseId);
  console.log(`Found ${candidates.length} novel candidates using high-quality mechanism axes.`);
  if (opts.topK > 0) {
    candidates = candidates.slice(0, opts.topK);
    console.log(`Limiting to top ${opts.topK} by mechanism breadth.`);
  }
  console.log(`Running agentic evaluation on ${candidates.length} candidates...\n`);

  // Step 2: Build runner
  const runner = new BiomedWorkflowRunner({
    ...DEFAULT_BIOMED_CONFIG,
    graphDataDir: opts.trainingDir,
    relationshipType: 'drug_protein_disease',
    maxRounds: opts.maxRounds,
  });

  // Step 3: Run each candidate through the multi-agent pipeline
  let completed = 0;
  const runResults: Array<{
    candidate: CandidateDrug;
    result: WorkflowResult | null;
    error: string | null;
  }> = await mapWithConcurrency(
    candidates,
    opts.concurrency,
    async (candidate, i) => {
      const sample = buildSyntheticSample(candidate, opts.diseaseId, i);
      try {
        const result = await runner.runSample(sample);
        completed += 1;
        const votes = summarizeVotes(result);
        process.stdout.write(
          `\r[${completed}/${candidates.length}] latest=${candidate.drugId} label=${result.decision.label} votes=${votes.positiveVotes}/${votes.expertCount}  `,
        );
        return { candidate, result, error: null };
      } catch (err) {
        completed += 1;
        process.stdout.write(
          `\r[${completed}/${candidates.length}] latest=${candidate.drugId} ERROR  `,
        );
        return { candidate, result: null, error: String(err) };
      }
    },
  );
  console.log('\n');

  // Step 4: Rank and format output
  const positives: unknown[] = [];
  const negatives: unknown[] = [];
  const errors: unknown[] = [];

  for (const { candidate, result, error } of runResults) {
    if (error || !result) {
      errors.push({ drugId: candidate.drugId, mechanismAxis: candidate.mechanismAxis, error });
      continue;
    }
    const votes = summarizeVotes(result);
    const entry = {
      drugId: candidate.drugId,
      mechanismAxis: candidate.mechanismAxis,
      targetProteins: candidate.targetProteins,
      anchorProtein: candidate.topProtein,
      breadth: candidate.breadth,
      supportCount: candidate.supportCount,
      predictedLabel: result.decision.label,
      decisionStatus: result.decision.status,
      confidence: result.decision.confidence,
      positiveVoteProb: votes.positiveVoteProb,
      positiveVotes: votes.positiveVotes,
      negativeVotes: votes.negativeVotes,
      expertCount: votes.expertCount,
      rationale: result.decision.rationale,
      votesByRole: votes.votesByRole,
    };
    if (result.decision.label === 1) {
      positives.push(entry);
    } else {
      negatives.push(entry);
    }
  }

  // Sort positives by confidence desc, then positive vote prob desc.
  (positives as Array<{ confidence: number; positiveVoteProb: number }>).sort(
    (a, b) => b.confidence !== a.confidence ? b.confidence - a.confidence : b.positiveVoteProb - a.positiveVoteProb,
  );

  const output = {
    diseaseId: opts.diseaseId,
    maxRounds: opts.maxRounds,
    candidateCount: candidates.length,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    errorCount: errors.length,
    positives,
    negatives,
    errors,
  };

  fs.writeFileSync(opts.outputPath, JSON.stringify(output, null, 2), 'utf8');

  // Summary to stdout
  console.log(`=== Results for ${opts.diseaseId} ===`);
  console.log(`Candidates evaluated: ${candidates.length}`);
  console.log(`Predicted positives : ${positives.length}`);
  console.log(`Predicted negatives : ${negatives.length}`);
  console.log(`Errors              : ${errors.length}`);
  console.log(`\nTop predicted positive candidates:`);

  for (const entry of (positives as Array<{
    drugId: string; mechanismAxis: string; predictedLabel: number;
    confidence: number; positiveVoteProb: number;
    positiveVotes: number; expertCount: number; rationale: string;
  }>).slice(0, 10)) {
    console.log(
      `  ${entry.drugId}  label=${entry.predictedLabel}  conf=${entry.confidence.toFixed(2)}` +
      `  votes=${entry.positiveVotes}/${entry.expertCount}  axis=${entry.mechanismAxis}`,
    );
    console.log(`    ${entry.rationale}`);
  }
  console.log(`\nFull results written to: ${opts.outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
