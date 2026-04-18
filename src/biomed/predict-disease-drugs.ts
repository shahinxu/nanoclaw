#!/usr/bin/env tsx
/**
 * predict-disease-drugs.ts
 *
 * Given a disease MONDO ID, enumerate ALL drugs in the graph and predict
 * whether each drug is an indication for the disease using the existing
 * drug_disease pipeline.  Already-known edges are skipped.
 *
 * Results are written incrementally (one JSON line per edge) so that a
 * crash or Ctrl-C does not lose progress.  On restart the script reads
 * the output file and resumes from where it left off.
 *
 * Usage:
 *   npx tsx src/biomed/predict-disease-drugs.ts \
 *     --diseaseId "MONDO:0004975" \
 *     --outputPath ../logs_agentic/predict_ad/predictions.jsonl \
 *     [--concurrency 4] [--maxRounds 5] [--graphDataDir ...] [--dataDir ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { DEFAULT_BIOMED_CONFIG } from './config.js';
import { BiomedWorkflowRunner } from './runner.js';
import type { BiomedTaskSample, WorkflowResult, AgentAssessment } from './types.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface PredictOptions {
  diseaseId: string;
  outputPath: string;
  graphDataDir: string;
  dataDir: string;
  workspaceRoot: string;
  pythonExecutable: string;
  openRouterApiKeyPath: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  maxRounds: number;
  concurrency: number;
}

function parseArgs(argv: string[]): PredictOptions {
  const opts: PredictOptions = {
    diseaseId: '',
    outputPath: '',
    graphDataDir: DEFAULT_BIOMED_CONFIG.graphDataDir,
    dataDir: DEFAULT_BIOMED_CONFIG.dataDir,
    workspaceRoot: DEFAULT_BIOMED_CONFIG.workspaceRoot,
    pythonExecutable: DEFAULT_BIOMED_CONFIG.pythonExecutable,
    openRouterApiKeyPath: DEFAULT_BIOMED_CONFIG.openRouterApiKeyPath,
    openRouterBaseUrl: DEFAULT_BIOMED_CONFIG.openRouterBaseUrl,
    openRouterModel: DEFAULT_BIOMED_CONFIG.openRouterModel,
    maxRounds: DEFAULT_BIOMED_CONFIG.maxRounds,
    concurrency: 4,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--diseaseId' && next) { opts.diseaseId = next; i += 1; }
    else if (arg === '--outputPath' && next) { opts.outputPath = next; i += 1; }
    else if (arg === '--graphDataDir' && next) { opts.graphDataDir = next; i += 1; }
    else if (arg === '--dataDir' && next) { opts.dataDir = next; i += 1; }
    else if (arg === '--maxRounds' && next) { opts.maxRounds = Number.parseInt(next, 10); i += 1; }
    else if (arg === '--concurrency' && next) { opts.concurrency = Number.parseInt(next, 10); i += 1; }
    else if (arg === '--pythonExecutable' && next) { opts.pythonExecutable = next; i += 1; }
    else if (arg === '--openRouterApiKeyPath' && next) { opts.openRouterApiKeyPath = next; i += 1; }
    else if (arg === '--openRouterBaseUrl' && next) { opts.openRouterBaseUrl = next; i += 1; }
    else if (arg === '--openRouterModel' && next) { opts.openRouterModel = next; i += 1; }
    else if (arg === '--workspaceRoot' && next) { opts.workspaceRoot = next; i += 1; }
  }

  if (!opts.diseaseId) {
    console.error('Error: --diseaseId is required (e.g. MONDO:0004975)');
    process.exit(1);
  }
  if (!opts.outputPath) {
    console.error('Error: --outputPath is required');
    process.exit(1);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// CSV helpers – read all unique drug IDs and existing drug-disease edges
// ---------------------------------------------------------------------------

function readCsvRows(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] ?? '').trim(); });
    return row;
  });
}

function collectAllDrugs(dataDir: string): Set<string> {
  const drugs = new Set<string>();
  const entries = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^order_.*\.csv$/u.test(e.name));
  for (const entry of entries) {
    const rows = readCsvRows(path.join(dataDir, entry.name));
    for (const row of rows) {
      const entityCols = Object.keys(row).filter((k) => k.includes('entity')).sort();
      for (const col of entityCols) {
        const val = row[col]?.trim();
        if (val?.startsWith('DB')) {
          drugs.add(val);
        }
      }
    }
  }
  return drugs;
}

function collectExistingEdges(dataDir: string, diseaseId: string): Set<string> {
  const existing = new Set<string>();
  const entries = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^order_.*\.csv$/u.test(e.name));
  for (const entry of entries) {
    const rows = readCsvRows(path.join(dataDir, entry.name));
    for (const row of rows) {
      if (row.relationship !== 'drug_disease') continue;
      const entityCols = Object.keys(row).filter((k) => k.includes('entity')).sort();
      const values = entityCols.map((c) => row[c]?.trim());
      if (values.includes(diseaseId)) {
        for (const v of values) {
          if (v.startsWith('DB')) existing.add(v);
        }
      }
    }
  }
  return existing;
}

// ---------------------------------------------------------------------------
// Resume support: read already-completed drug IDs from output JSONL
// ---------------------------------------------------------------------------

function loadCompletedDrugs(outputPath: string): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(outputPath)) return done;
  const content = fs.readFileSync(outputPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.drugId) done.add(obj.drugId);
    } catch { /* skip malformed lines */ }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Format a single result to JSONL record
// ---------------------------------------------------------------------------

function formatAssessment(a: AgentAssessment) {
  return {
    agentId: a.agentId,
    role: a.role,
    round: a.roundNumber,
    label: a.recommendedLabel,
    summary: a.summary,
    evidence: a.evidenceItems.map((e) => ({
      source: e.source,
      claim: e.claim,
      stance: e.stance,
    })),
  };
}

function formatResult(drugId: string, diseaseId: string, result: WorkflowResult) {
  const assessments = result.trace.assessments ?? [];
  const rounds = (result.trace.rounds ?? []).map((r) => ({
    round: r.roundNumber,
    focus: r.focus,
    summary: r.summary,
    assessments: (r.assessments ?? []).map(formatAssessment),
  }));

  return {
    drugId,
    diseaseId,
    predictedLabel: result.decision.label,
    confidence: result.decision.confidence,
    status: result.decision.status,
    decisionMode: result.decision.decisionMode,
    rationale: result.decision.rationale,
    rounds,
    finalAssessments: assessments.map(formatAssessment),
  };
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function renderProgress(completed: number, total: number, skippedExisting: number, predicted1: number): void {
  const width = 24;
  const ratio = Math.min(completed / Math.max(total, 1), 1);
  const filled = Math.round(ratio * width);
  const bar = '='.repeat(filled) + '-'.repeat(Math.max(0, width - filled));
  const pct = (ratio * 100).toFixed(1);
  const line = `[${bar}] ${completed}/${total} (${pct}%) skipped_existing=${skippedExisting} predicted_indication=${predicted1}`;
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line}`);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper (same as in run-balanced-eval.ts)
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const cap = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= values.length) return;
      results[idx] = await worker(values[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: cap }, () => run()));
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const resolvedOutput = path.resolve(opts.outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });

  console.log(`Disease: ${opts.diseaseId}`);
  console.log(`Output:  ${resolvedOutput}`);
  console.log(`Graph data: ${opts.graphDataDir}`);

  // 1. Collect all drugs in the graph
  const allDrugs = collectAllDrugs(opts.graphDataDir);
  console.log(`Total unique drugs in graph: ${allDrugs.size}`);

  // 2. Remove drugs that already have a drug_disease edge with this disease
  const existingDrugs = collectExistingEdges(opts.graphDataDir, opts.diseaseId);
  console.log(`Existing drug-disease edges for ${opts.diseaseId}: ${existingDrugs.size} (will skip)`);

  const drugsToPredict = [...allDrugs].filter((d) => !existingDrugs.has(d)).sort();
  console.log(`Drugs to predict: ${drugsToPredict.length}`);

  // 3. Resume: skip already-completed drugs
  const completedDrugs = loadCompletedDrugs(resolvedOutput);
  const remaining = drugsToPredict.filter((d) => !completedDrugs.has(d));
  console.log(`Already completed (resume): ${completedDrugs.size}`);
  console.log(`Remaining to predict: ${remaining.length}`);

  if (remaining.length === 0) {
    console.log('Nothing to do — all drugs already predicted.');
    return;
  }

  // 4. Build runner
  const runner = new BiomedWorkflowRunner({
    workspaceRoot: opts.workspaceRoot,
    relationshipType: 'drug_disease',
    dataDir: opts.dataDir,
    graphDataDir: opts.graphDataDir,
    pythonExecutable: opts.pythonExecutable,
    openRouterApiKeyPath: opts.openRouterApiKeyPath,
    openRouterBaseUrl: opts.openRouterBaseUrl,
    openRouterModel: opts.openRouterModel,
    writeTrace: true,
    maxRounds: opts.maxRounds,
  });

  // 5. Run predictions
  let completed = completedDrugs.size;
  const total = drugsToPredict.length;
  const skippedExisting = existingDrugs.size;
  let predicted1 = 0;

  // Count existing predicted=1 from resume file
  if (fs.existsSync(resolvedOutput)) {
    const content = fs.readFileSync(resolvedOutput, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.predictedLabel === 1) predicted1 += 1;
      } catch { /* skip */ }
    }
  }

  renderProgress(completed, total, skippedExisting, predicted1);

  await mapWithConcurrency(remaining, opts.concurrency, async (drugId, _idx) => {
    const sample: BiomedTaskSample = {
      sampleIndex: completed + _idx,
      relationshipType: 'drug_disease',
      entityDict: { drug: drugId, disease: opts.diseaseId },
      // no groundTruth — this is a prediction
    };

    try {
      const result = await runner.runSample(sample);
      const record = formatResult(drugId, opts.diseaseId, result);
      fs.appendFileSync(resolvedOutput, JSON.stringify(record) + '\n');
      if (result.decision.label === 1) predicted1 += 1;
    } catch (err) {
      const errorRecord = {
        drugId,
        diseaseId: opts.diseaseId,
        error: err instanceof Error ? err.message : String(err),
      };
      fs.appendFileSync(resolvedOutput, JSON.stringify(errorRecord) + '\n');
    }

    completed += 1;
    renderProgress(completed, total, skippedExisting, predicted1);
  });

  if (process.stdout.isTTY) process.stdout.write('\n');
  console.log(`Done. ${completed}/${total} drugs predicted. ${predicted1} predicted as indication.`);
  console.log(`Results: ${resolvedOutput}`);
}

await main();
