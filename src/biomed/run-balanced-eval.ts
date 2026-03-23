import fs from 'node:fs';
import path from 'node:path';

import { BiomedWorkflowRunner } from './runner.js';
import { CsvTaskLoader } from './task-loader.js';
import type { BiomedTaskSample, WorkflowResult } from './types.js';

interface CliOptions {
  relationshipType: string;
  sampleCount: number;
  seed: number;
  dataDir: string;
  graphDataDir: string;
  maxRounds: number;
  outputPath?: string;
}

interface EvalMetrics {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    relationshipType: 'drug_protein_disease',
    sampleCount: 100,
    seed: 42,
    dataDir: '/home/zhx/drug_agent/data_edge_test',
    graphDataDir: '/home/zhx/drug_agent/data_edge_train',
    maxRounds: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--relationshipType' && next) {
      options.relationshipType = next;
      index += 1;
    } else if (arg === '--sampleCount' && next) {
      options.sampleCount = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--seed' && next) {
      options.seed = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--dataDir' && next) {
      options.dataDir = next;
      index += 1;
    } else if (arg === '--graphDataDir' && next) {
      options.graphDataDir = next;
      index += 1;
    } else if (arg === '--maxRounds' && next) {
      options.maxRounds = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--outputPath' && next) {
      options.outputPath = next;
      index += 1;
    }
  }

  return options;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(values: T[], seed: number): T[] {
  const random = mulberry32(seed);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function balancedSample(
  samples: BiomedTaskSample[],
  sampleCount: number,
  seed: number,
): BiomedTaskSample[] {
  const positives = samples.filter((sample) => sample.groundTruth === 1);
  const negatives = samples.filter((sample) => sample.groundTruth === 0);
  const targetPerLabel = Math.floor(sampleCount / 2);

  if (positives.length < targetPerLabel || negatives.length < targetPerLabel) {
    throw new Error(
      `Insufficient samples for balanced evaluation: need ${targetPerLabel} per label, got positives=${positives.length}, negatives=${negatives.length}.`,
    );
  }

  const sampledPositives = shuffleInPlace([...positives], seed).slice(
    0,
    targetPerLabel,
  );
  const sampledNegatives = shuffleInPlace([...negatives], seed + 1).slice(
    0,
    targetPerLabel,
  );
  return shuffleInPlace([...sampledPositives, ...sampledNegatives], seed + 2);
}

function computeMetrics(results: WorkflowResult[]): EvalMetrics {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  for (const result of results) {
    const gold = result.trace.groundTruth ?? 0;
    const predicted = result.decision.label;
    if (predicted === 1 && gold === 1) {
      tp += 1;
    } else if (predicted === 0 && gold === 0) {
      tn += 1;
    } else if (predicted === 1 && gold === 0) {
      fp += 1;
    } else if (predicted === 0 && gold === 1) {
      fn += 1;
    }
  }

  const total = results.length;
  const accuracy = total > 0 ? (tp + tn) / total : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

  return { total, accuracy, precision, recall, f1, tp, tn, fp, fn };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loader = new CsvTaskLoader({
    dataDir: options.dataDir,
    relationshipType: options.relationshipType,
  });
  const allSamples = await loader.loadSamples();
  const sampled = balancedSample(allSamples, options.sampleCount, options.seed);

  const runner = new BiomedWorkflowRunner({
    relationshipType: options.relationshipType,
    dataDir: options.dataDir,
    graphDataDir: options.graphDataDir,
    writeTrace: false,
    maxRounds: options.maxRounds,
  });

  const results: WorkflowResult[] = [];
  for (let index = 0; index < sampled.length; index += 1) {
    const sample = sampled[index];
    const result = await runner.runSample(sample);
    results.push(result);
    if ((index + 1) % 10 === 0 || index + 1 === sampled.length) {
      console.log(`Completed ${index + 1}/${sampled.length} samples`);
    }
  }

  const metrics = computeMetrics(results);
  const payload = {
    relationshipType: options.relationshipType,
    sampleCount: options.sampleCount,
    seed: options.seed,
    maxRounds: options.maxRounds,
    metrics,
    samples: results.map((result) => ({
      sampleIndex: result.trace.sampleIndex,
      groundTruth: result.trace.groundTruth,
      predictedLabel: result.decision.label,
      decisionStatus: result.decision.status,
      decisionMode: result.decision.decisionMode,
      confidence: result.decision.confidence,
      rationale: result.decision.rationale,
      entityDict: result.trace.entityDict,
    })),
  };

  console.log(JSON.stringify(payload, null, 2));

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    console.log(`Wrote evaluation results to ${outputPath}`);
  }
}

await main();
