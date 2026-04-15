import fs from 'node:fs';

import { DEFAULT_BIOMED_CONFIG } from './config.js';
import { BiomedWorkflowRunner } from './runner.js';
import { CsvTaskLoader } from './task-loader.js';

interface CliOptions {
  relationshipType: string;
  sampleIndex: number;
  dataDir: string;
  graphDataDir: string;
  workspaceRoot: string;
  pythonExecutable: string;
  openRouterApiKeyPath: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  maxRounds: number;
  outputPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    relationshipType: 'drug_drug_sideeffect',
    sampleIndex: 0,
    dataDir: DEFAULT_BIOMED_CONFIG.dataDir,
    graphDataDir: DEFAULT_BIOMED_CONFIG.graphDataDir,
    workspaceRoot: DEFAULT_BIOMED_CONFIG.workspaceRoot,
    pythonExecutable: DEFAULT_BIOMED_CONFIG.pythonExecutable,
    openRouterApiKeyPath: DEFAULT_BIOMED_CONFIG.openRouterApiKeyPath,
    openRouterBaseUrl: DEFAULT_BIOMED_CONFIG.openRouterBaseUrl,
    openRouterModel: DEFAULT_BIOMED_CONFIG.openRouterModel,
    maxRounds: 2,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--relationshipType' && next) {
      options.relationshipType = next;
      index += 1;
    } else if (arg === '--sampleIndex' && next) {
      options.sampleIndex = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--dataDir' && next) {
      options.dataDir = next;
      index += 1;
    } else if (arg === '--graphDataDir' && next) {
      options.graphDataDir = next;
      index += 1;
    } else if (arg === '--workspaceRoot' && next) {
      options.workspaceRoot = next;
      index += 1;
    } else if (arg === '--pythonExecutable' && next) {
      options.pythonExecutable = next;
      index += 1;
    } else if (arg === '--openRouterApiKeyPath' && next) {
      options.openRouterApiKeyPath = next;
      index += 1;
    } else if (arg === '--openRouterBaseUrl' && next) {
      options.openRouterBaseUrl = next;
      index += 1;
    } else if (arg === '--openRouterModel' && next) {
      options.openRouterModel = next;
      index += 1;
    } else if (arg === '--maxRounds' && next) {
      options.maxRounds = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--outputPath' && next) {
      options.outputPath = next;
      index += 1;
    }
  }

  if (!Number.isFinite(options.sampleIndex)) {
    throw new Error('--sampleIndex is required and must be an integer.');
  }

  return options;
}

function compactEvidenceClaims(assessment: {
  evidenceItems: Array<{
    toolName: string;
    stance: string;
    strength: string;
    claim: string;
  }>;
}) {
  return assessment.evidenceItems.map((item) => ({
    toolName: item.toolName,
    stance: item.stance,
    strength: item.strength,
    claim: item.claim,
  }));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const loader = new CsvTaskLoader({
    dataDir: options.dataDir,
    relationshipType: options.relationshipType,
  });
  const samples = await loader.loadSamples();
  const sample = samples.find(
    (item) => item.sampleIndex === options.sampleIndex,
  );

  if (!sample) {
    throw new Error(
      `Sample ${options.sampleIndex} not found for relationshipType=${options.relationshipType}.`,
    );
  }

  const runner = new BiomedWorkflowRunner({
    workspaceRoot: options.workspaceRoot,
    relationshipType: options.relationshipType,
    dataDir: options.dataDir,
    graphDataDir: options.graphDataDir,
    pythonExecutable: options.pythonExecutable,
    openRouterApiKeyPath: options.openRouterApiKeyPath,
    openRouterBaseUrl: options.openRouterBaseUrl,
    openRouterModel: options.openRouterModel,
    maxRounds: options.maxRounds,
    writeTrace: false,
  });

  const result = await runner.runSample(sample);
  const trace = result.trace;
  const caseStudy = {
    sample: {
      sampleIndex: trace.sampleIndex,
      relationshipType: trace.relationshipType,
      groundTruth: trace.groundTruth,
      entityDict: trace.entityDict,
      finalDecision: trace.decision,
    },
    finalHypotheses: trace.hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      statement: hypothesis.statement,
      kind: hypothesis.kind,
      status: hypothesis.status,
      topicKey: hypothesis.topicKey,
      targetedRoles: hypothesis.targetedRoles,
      requiredChecks: hypothesis.requiredChecks,
      revisionReason: hypothesis.revisionReason,
      confidence: hypothesis.confidence,
    })),
    rounds: trace.rounds.map((round) => ({
      roundNumber: round.roundNumber,
      roundObjective: round.roundObjective,
      focus: round.focus,
      disagreements: round.disagreements.map((item) => ({
        id: item.id,
        title: item.title,
        question: item.question,
        rationale: item.rationale,
        affectedRoles: item.affectedRoles,
        persistenceCount: item.persistenceCount,
        escalationLevel: item.escalationLevel,
        status: item.status,
      })),
      hypothesisSnapshot: round.hypothesisSnapshot.map((hypothesis) => ({
        id: hypothesis.id,
        statement: hypothesis.statement,
        kind: hypothesis.kind,
        status: hypothesis.status,
        topicKey: hypothesis.topicKey,
        targetedRoles: hypothesis.targetedRoles,
        revisionReason: hypothesis.revisionReason,
      })),
      agentOutputs: round.assessments.map((assessment) => ({
        role: assessment.role,
        recommendedLabel: assessment.recommendedLabel,
        summary: assessment.summary,
        hypothesesTouched: assessment.hypothesesTouched,
        plannerActions: assessment.plannerActions.map((action) => ({
          hypothesisId: action.hypothesisId,
          hypothesisStatement: action.hypothesisStatement,
          verificationGoal: action.verificationGoal,
          expectedEvidence: action.expectedEvidence,
          failureRule: action.failureRule,
        })),
        evidenceClaims: compactEvidenceClaims(assessment),
      })),
    })),
  };

  const json = JSON.stringify(caseStudy, null, 2);
  if (options.outputPath) {
    fs.writeFileSync(options.outputPath, json, 'utf8');
  }
  console.log(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
