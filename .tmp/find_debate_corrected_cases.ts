import { BiomedWorkflowRunner } from '../src/biomed/runner.ts';
import { CsvTaskLoader } from '../src/biomed/task-loader.ts';
import type { AgentAssessment, BiomedLabel, BiomedTaskSample } from '../src/biomed/types.ts';

declare const process: {
  argv: string[];
  exitCode?: number;
};

interface CliOptions {
  sampleCount: number;
  seed: number;
  maxRounds: number;
  relationshipType: string;
  dataDir: string;
  graphDataDir: string;
  onlyLabel?: BiomedLabel;
  targetFound: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sampleCount: 20,
    seed: 42,
    maxRounds: 5,
    relationshipType: 'drug_protein_disease',
    dataDir: '/home/zhx/drug_agent/data_edge_test',
    graphDataDir: '/home/zhx/drug_agent/data_edge_train',
    targetFound: 3,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--sampleCount' && next) {
      options.sampleCount = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--seed' && next) {
      options.seed = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--maxRounds' && next) {
      options.maxRounds = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--relationshipType' && next) {
      options.relationshipType = next;
      index += 1;
    } else if (arg === '--dataDir' && next) {
      options.dataDir = next;
      index += 1;
    } else if (arg === '--graphDataDir' && next) {
      options.graphDataDir = next;
      index += 1;
    } else if (arg === '--onlyLabel' && next) {
      options.onlyLabel = Number.parseInt(next, 10) === 1 ? 1 : 0;
      index += 1;
    } else if (arg === '--targetFound' && next) {
      options.targetFound = Number.parseInt(next, 10);
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
      `Insufficient samples for balanced scan: need ${targetPerLabel} per label, got positives=${positives.length}, negatives=${negatives.length}.`,
    );
  }

  const sampledPositives = shuffleInPlace([...positives], seed).slice(0, targetPerLabel);
  const sampledNegatives = shuffleInPlace([...negatives], seed + 1).slice(0, targetPerLabel);
  return shuffleInPlace([...sampledPositives, ...sampledNegatives], seed + 2);
}

function majorityLabel(assessments: AgentAssessment[]): BiomedLabel | 'tie' {
  let supports = 0;
  let refutes = 0;
  for (const assessment of assessments) {
    if (assessment.role === 'arbiter') {
      continue;
    }
    if (assessment.recommendedLabel === 1) {
      supports += 1;
    } else {
      refutes += 1;
    }
  }

  if (supports === refutes) {
    return 'tie';
  }
  return supports > refutes ? 1 : 0;
}

function voteVector(assessments: AgentAssessment[]): string {
  return assessments
    .filter((assessment) => assessment.role !== 'arbiter')
    .map((assessment) => `${assessment.role}=${assessment.recommendedLabel}`)
    .join(', ');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loader = new CsvTaskLoader({
    dataDir: options.dataDir,
    relationshipType: options.relationshipType,
  });

  let samples = await loader.loadSamples();
  if (options.onlyLabel !== undefined) {
    samples = samples.filter((sample) => sample.groundTruth === options.onlyLabel);
  }

  const picked = options.onlyLabel === undefined
    ? balancedSample(samples, options.sampleCount, options.seed)
    : shuffleInPlace([...samples], options.seed).slice(0, options.sampleCount);

  const runner = new BiomedWorkflowRunner({
    relationshipType: options.relationshipType,
    dataDir: options.dataDir,
    graphDataDir: options.graphDataDir,
    writeTrace: false,
    maxRounds: options.maxRounds,
  });

  const correctedFromWrong: Array<Record<string, unknown>> = [];
  const correctedFromTie: Array<Record<string, unknown>> = [];
  const stableCorrect: Array<Record<string, unknown>> = [];
  let stoppedEarly = false;
  let scannedCount = 0;

  for (const sample of picked) {
    const result = await runner.runSample(sample);
    scannedCount += 1;
    const firstRound = result.trace.rounds[0];
    const firstRoundMajority = firstRound ? majorityLabel(firstRound.assessments) : 'tie';
    const finalLabel = result.decision.label;
    const gold = result.trace.groundTruth ?? 0;
    const rounds = result.trace.rounds.map((round) => ({
      round: round.roundNumber,
      majority: majorityLabel(round.assessments),
      votes: voteVector(round.assessments),
    }));

    const record = {
      sampleIndex: sample.sampleIndex,
      entities: sample.entityDict,
      groundTruth: gold,
      firstRoundMajority,
      finalLabel,
      finalStatus: result.decision.status,
      rationale: result.decision.rationale,
      rounds,
    };

    if (finalLabel === gold && firstRoundMajority !== 'tie' && firstRoundMajority !== gold) {
      correctedFromWrong.push(record);
    } else if (finalLabel === gold && firstRoundMajority === 'tie') {
      correctedFromTie.push(record);
    } else if (finalLabel === gold && firstRoundMajority === gold) {
      stableCorrect.push(record);
    }

    console.error(
      `scanned sample=${sample.sampleIndex} gold=${gold} round1=${String(firstRoundMajority)} final=${finalLabel}`,
    );

    if (correctedFromWrong.length + correctedFromTie.length >= options.targetFound) {
      stoppedEarly = true;
      break;
    }
  }

  const payload = {
    scanned: scannedCount,
    candidatePoolSize: picked.length,
    stoppedEarly,
    relationshipType: options.relationshipType,
    maxRounds: options.maxRounds,
    correctedFromWrong,
    correctedFromTie,
    stableCorrectCount: stableCorrect.length,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});