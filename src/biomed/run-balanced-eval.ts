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
  concurrency: number;
  outputPath?: string;
  streamOutputPath?: string;
}

interface EvalMetrics {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  auroc: number | null;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
}

interface RunningCounts {
  completed: number;
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
    concurrency: 4,
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
    } else if (arg === '--concurrency' && next) {
      options.concurrency = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--outputPath' && next) {
      options.outputPath = next;
      index += 1;
    } else if (arg === '--streamOutputPath' && next) {
      options.streamOutputPath = next;
      index += 1;
    }
  }

  return options;
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const normalizedConcurrency = Math.max(
    1,
    Math.min(concurrency, values.length),
  );
  const results = new Array<U>(values.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }
      results[currentIndex] = await worker(values[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: normalizedConcurrency }, () => runWorker()),
  );
  return results;
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

function computeAuroc(labels: number[], scores: number[]): number | null {
  if (labels.length !== scores.length || labels.length === 0) {
    return null;
  }

  let nPos = 0;
  let nNeg = 0;
  for (const label of labels) {
    if (label === 1) {
      nPos += 1;
    } else if (label === 0) {
      nNeg += 1;
    }
  }
  if (nPos === 0 || nNeg === 0) {
    return null;
  }

  const pairs = scores
    .map((score, index) => ({ score, label: labels[index] }))
    .sort((a, b) => a.score - b.score);

  // Average-rank ties (Mann-Whitney interpretation of AUROC).
  let rank = 1;
  let sumRanksPos = 0;
  let index = 0;
  while (index < pairs.length) {
    let end = index;
    while (end + 1 < pairs.length && pairs[end + 1].score === pairs[index].score) {
      end += 1;
    }
    const count = end - index + 1;
    const avgRank = rank + (count - 1) / 2;
    for (let j = index; j <= end; j += 1) {
      if (pairs[j].label === 1) {
        sumRanksPos += avgRank;
      }
    }
    rank += count;
    index = end + 1;
  }

  const u = sumRanksPos - (nPos * (nPos + 1)) / 2;
  return u / (nPos * nNeg);
}

function computeMetrics(results: WorkflowResult[]): EvalMetrics {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  const labels: number[] = [];
  const scores: number[] = [];

  for (const result of results) {
    const gold = result.trace.groundTruth ?? 0;
    const predicted = result.decision.label;
    const voteStats = summarizeExpertVotes(result);
    labels.push(gold);
    scores.push(voteStats.positive_vote_prob);
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

  const auroc = computeAuroc(labels, scores);

  return { total, accuracy, precision, recall, f1, auroc, tp, tn, fp, fn };
}

function updateRunningCounts(
  counts: RunningCounts,
  result: WorkflowResult,
): RunningCounts {
  const gold = result.trace.groundTruth ?? 0;
  const predicted = result.decision.label;

  counts.completed += 1;
  if (predicted === 1 && gold === 1) {
    counts.tp += 1;
  } else if (predicted === 0 && gold === 0) {
    counts.tn += 1;
  } else if (predicted === 1 && gold === 0) {
    counts.fp += 1;
  } else if (predicted === 0 && gold === 1) {
    counts.fn += 1;
  }

  return counts;
}

function renderProgressBar(
  completed: number,
  total: number,
  width = 24,
): string {
  const safeTotal = Math.max(total, 1);
  const ratio = Math.min(Math.max(completed / safeTotal, 0), 1);
  const filled = Math.round(ratio * width);
  return `${'='.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}`;
}

function runningAccuracy(counts: RunningCounts): number {
  if (counts.completed === 0) {
    return 0;
  }
  return (counts.tp + counts.tn) / counts.completed;
}

function reportProgress(counts: RunningCounts, total: number): void {
  const bar = renderProgressBar(counts.completed, total);
  const accuracy = runningAccuracy(counts);
  const line = `[${bar}] ${counts.completed}/${total} acc=${accuracy.toFixed(4)} tp=${counts.tp} tn=${counts.tn} fp=${counts.fp} fn=${counts.fn}`;

  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line}`);
    if (counts.completed === total) {
      process.stdout.write('\n');
    }
    return;
  }

  console.log(line);
}

function summarizeExpertVotes(result: WorkflowResult): {
  positiveVoteCount: number;
  negativeVoteCount: number;
  expertCount: number;
  positive_vote_prob: number;
} {
  const expertAssessments = (result.trace.assessments ?? []).filter(
    (assessment) => assessment.role !== 'arbiter',
  );
  const positiveVoteCount = expertAssessments.filter(
    (assessment) => assessment.recommendedLabel === 1,
  ).length;
  const negativeVoteCount = expertAssessments.filter(
    (assessment) => assessment.recommendedLabel === 0,
  ).length;
  const expertCount = expertAssessments.length;
  const positive_vote_prob =
    expertCount > 0 ? positiveVoteCount / expertCount : 0.5;

  return {
    positiveVoteCount,
    negativeVoteCount,
    expertCount,
    positive_vote_prob,
  };
}

function summarizeResult(result: WorkflowResult) {
  const voteStats = summarizeExpertVotes(result);
  return {
    sampleIndex: result.trace.sampleIndex,
    groundTruth: result.trace.groundTruth,
    predictedLabel: result.decision.label,
    decisionStatus: result.decision.status,
    decisionMode: result.decision.decisionMode,
    confidence: result.decision.confidence,
    positive_vote_prob: voteStats.positive_vote_prob,
    expertVoteCount: voteStats.expertCount,
    expertPositiveVotes: voteStats.positiveVoteCount,
    expertNegativeVotes: voteStats.negativeVoteCount,
    rationale: result.decision.rationale,
    entityDict: result.trace.entityDict,
  };
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

  const streamOutputPath = options.streamOutputPath
    ? path.resolve(options.streamOutputPath)
    : undefined;
  if (streamOutputPath) {
    fs.mkdirSync(path.dirname(streamOutputPath), { recursive: true });
    fs.writeFileSync(streamOutputPath, '');
  }

  const runningCounts: RunningCounts = {
    completed: 0,
    tp: 0,
    tn: 0,
    fp: 0,
    fn: 0,
  };
  reportProgress(runningCounts, sampled.length);

  const results = await mapWithConcurrency(
    sampled,
    options.concurrency,
    async (sample) => {
      const result = await runner.runSample(sample);
      updateRunningCounts(runningCounts, result);
      if (streamOutputPath) {
        fs.appendFileSync(
          streamOutputPath,
          `${JSON.stringify(summarizeResult(result))}\n`,
        );
      }
      reportProgress(runningCounts, sampled.length);
      return result;
    },
  );

  const metrics = computeMetrics(results);
  const payload = {
    relationshipType: options.relationshipType,
    sampleCount: options.sampleCount,
    seed: options.seed,
    maxRounds: options.maxRounds,
    concurrency: options.concurrency,
    metrics,
    streamOutputPath,
    samples: results.map(summarizeResult),
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
