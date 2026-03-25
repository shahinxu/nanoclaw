declare const process: {
  argv: string[];
  exitCode?: number;
};

import fs from 'fs';
import path from 'path';

import { BiomedWorkflowRunner } from '../src/biomed/runner.ts';
import type { BiomedLabel, BiomedTaskSample } from '../src/biomed/types.ts';

type BatchRow = {
  batchIndex: number;
  sampleIndex: number;
  groundTruth: BiomedLabel;
  predictedLabel: BiomedLabel;
  roundCount: number;
  status: string;
  confidence: number;
  relationshipType: string;
  entityDict: Record<string, string | string[]>;
  rationale: string;
};

type BatchSummary = {
  total: number;
  positiveCount: number;
  negativeCount: number;
  correct: number;
  accuracy: number;
  confusionMatrix: {
    tp: number;
    tn: number;
    fp: number;
    fn: number;
  };
};

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '_',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function toAccuracy(correct: number, total: number): number {
  return total === 0 ? 0 : Number((correct / total).toFixed(4));
}

function takeBalancedSamples(
  samples: BiomedTaskSample[],
  perLabel: number,
): BiomedTaskSample[] {
  const positives: BiomedTaskSample[] = [];
  const negatives: BiomedTaskSample[] = [];

  for (const sample of samples) {
    if (sample.groundTruth === 1 && positives.length < perLabel) {
      positives.push(sample);
    }
    if (sample.groundTruth === 0 && negatives.length < perLabel) {
      negatives.push(sample);
    }
    if (positives.length >= perLabel && negatives.length >= perLabel) {
      break;
    }
  }

  if (positives.length < perLabel || negatives.length < perLabel) {
    throw new Error(
      `insufficient balanced samples: positives=${positives.length}, negatives=${negatives.length}, requested=${perLabel}`,
    );
  }

  const selected: BiomedTaskSample[] = [];
  for (let index = 0; index < perLabel; index += 1) {
    selected.push(positives[index], negatives[index]);
  }
  return selected;
}

function buildSummary(rows: BatchRow[]): BatchSummary {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  for (const row of rows) {
    if (row.groundTruth === 1 && row.predictedLabel === 1) {
      tp += 1;
    } else if (row.groundTruth === 0 && row.predictedLabel === 0) {
      tn += 1;
    } else if (row.groundTruth === 0 && row.predictedLabel === 1) {
      fp += 1;
    } else {
      fn += 1;
    }
  }

  const correct = tp + tn;
  return {
    total: rows.length,
    positiveCount: rows.filter((row) => row.groundTruth === 1).length,
    negativeCount: rows.filter((row) => row.groundTruth === 0).length,
    correct,
    accuracy: toAccuracy(correct, rows.length),
    confusionMatrix: { tp, tn, fp, fn },
  };
}

async function main(): Promise<void> {
  const perLabel = Number(process.argv[2] ?? '50');
  const dataDir = process.argv[3] ?? '/home/zhx/drug_agent/data_edge_train';
  const relationshipType = 'drug_protein_disease';
  const runner = new BiomedWorkflowRunner({
    dataDir,
    relationshipType,
  });

  const allSamples = await runner.loadSamples();
  const selectedSamples = takeBalancedSamples(allSamples, perLabel);
  const rows: BatchRow[] = [];

  console.log(
    `Running ${selectedSamples.length} balanced train samples from ${dataDir} (${perLabel} positive + ${perLabel} negative).`,
  );

  for (const [batchIndex, sample] of selectedSamples.entries()) {
    const result = await runner.runSample(sample);
    const groundTruth = sample.groundTruth ?? 0;
    rows.push({
      batchIndex,
      sampleIndex: sample.sampleIndex,
      groundTruth,
      predictedLabel: result.decision.label,
      roundCount: result.trace.rounds.length,
      status: result.decision.status,
      confidence: result.decision.confidence,
      relationshipType: sample.relationshipType,
      entityDict: sample.entityDict,
      rationale: result.decision.rationale,
    });

    console.log(
      `[${batchIndex + 1}/${selectedSamples.length}] sampleIndex=${sample.sampleIndex} gt=${groundTruth} pred=${result.decision.label} rounds=${result.trace.rounds.length} status=${result.decision.status} confidence=${result.decision.confidence}`,
    );
  }

  const summary = buildSummary(rows);
  const output = {
    createdAt: new Date().toISOString(),
    dataDir,
    relationshipType,
    selection: {
      mode: 'first-balanced',
      perLabel,
      total: selectedSamples.length,
      sampleIndices: rows.map((row) => row.sampleIndex),
    },
    summary,
    rows,
  };

  const outputDir = path.join('/home/zhx/drug_agent/nanoclaw/logs_agentic');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `balanced_train_run_${timestamp()}.json`,
  );
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`Saved results to ${outputPath}`);
  console.log(`Accuracy=${summary.accuracy} correct=${summary.correct}/${summary.total}`);
  console.log(
    `Confusion matrix: TP=${summary.confusionMatrix.tp} TN=${summary.confusionMatrix.tn} FP=${summary.confusionMatrix.fp} FN=${summary.confusionMatrix.fn}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});