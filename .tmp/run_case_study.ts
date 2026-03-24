import { BiomedWorkflowRunner } from '../src/biomed/runner.ts';
import { summarizePeerAssessment } from '../src/biomed/assessment-utils.ts';
import { CsvTaskLoader } from '../src/biomed/task-loader.ts';
import type {
  AgentAssessment,
  AgentRoundContext,
  SampleRoundRecord,
} from '../src/biomed/types.ts';

const ROLE_ORDER = ['drug', 'protein', 'disease', 'graph'] as const;

function formatList(items: string[], indent = ''): string[] {
  if (items.length === 0) {
    return [`${indent}- (none)`];
  }
  return items.map((item) => `${indent}- ${item}`);
}

function roleDisagreements(
  previousRound: SampleRoundRecord | undefined,
  role: (typeof ROLE_ORDER)[number],
): string[] {
  const disagreements = previousRound?.disagreements ?? [];
  if (role === 'graph') {
    return disagreements.map((item) => item.question);
  }
  return disagreements
    .filter((item) => item.affectedRoles.includes(role))
    .map((item) => item.question);
}

function peerAssessmentSummaries(
  previousRound: SampleRoundRecord | undefined,
  role: (typeof ROLE_ORDER)[number],
): string[] {
  return (
    previousRound?.assessments
      .filter((assessment) => assessment.role !== role)
      .map(summarizePeerAssessment) ?? []
  );
}

function evidenceLine(item: EvidenceItem): string {
  return `${item.stance}/${item.strength} via ${item.toolName}: ${item.claim}`;
}

function summarizeToolArguments(toolArguments: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const role = typeof toolArguments.role === 'string' ? toolArguments.role : undefined;
  const drugId = typeof toolArguments.drug_id === 'string' ? toolArguments.drug_id : undefined;
  const proteinId = typeof toolArguments.protein_id === 'string' ? toolArguments.protein_id : undefined;
  const diseaseId = typeof toolArguments.disease_id === 'string' ? toolArguments.disease_id : undefined;
  const question =
    typeof toolArguments.question === 'string'
      ? toolArguments.question
      : typeof toolArguments.focused_question === 'string'
        ? toolArguments.focused_question
        : undefined;
  const reviewContext =
    toolArguments.review_context !== null &&
    typeof toolArguments.review_context === 'object'
      ? (toolArguments.review_context as Record<string, unknown>)
      : undefined;

  if (role !== undefined) {
    lines.push(`role=${role}`);
  }
  if (drugId !== undefined || proteinId !== undefined || diseaseId !== undefined) {
    lines.push(
      `entities=${[drugId, proteinId, diseaseId].filter((item): item is string => item !== undefined).join(' | ')}`,
    );
  }
  if (question !== undefined) {
    lines.push(`question=${question}`);
  }
  if (reviewContext !== undefined) {
    const focus = Array.isArray(reviewContext.focus)
      ? reviewContext.focus.filter((item): item is string => typeof item === 'string')
      : [];
    const priorRoundSummaries = Array.isArray(reviewContext.peerFindings)
      ? reviewContext.peerFindings.filter((item): item is string => typeof item === 'string')
      : [];
    const focusMode =
      typeof reviewContext.focusMode === 'string' ? reviewContext.focusMode : undefined;
    if (focusMode !== undefined) {
      lines.push(`focusMode=${focusMode}`);
    }
    if (focus.length > 0) {
      lines.push(`focus=${focus.join(' || ')}`);
    }
    if (priorRoundSummaries.length > 0) {
      lines.push(`peerFindings=${priorRoundSummaries.slice(0, 3).join(' || ')}`);
    }
  }
  return lines;
}

function truncate(value: string, maxLength = 280): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function describeAssessment(
  assessment: AgentAssessment,
  round: SampleRoundRecord,
  previousRound: SampleRoundRecord | undefined,
): string[] {
  const role = assessment.role as (typeof ROLE_ORDER)[number];
  const inputSnapshot: AgentRoundContext = {
    roundNumber: round.roundNumber,
    maxRounds: 0,
    focus: round.roundObjective.directive ? [round.roundObjective.directive] : [],
    disagreements: [],
    sharedEvidenceBoard: round.sharedEvidenceBoard,
    roundObjective: round.roundObjective,
    peerAssessmentSummaries: peerAssessmentSummaries(previousRound, role),
    peerEvidenceDigest: [],
    positiveEvidenceDigest: [],
    negativeEvidenceDigest: [],
    alternativeMechanismSignals: round.sharedEvidenceBoard.alternativeMechanismSignals,
    hypothesisFocus: round.focus,
    activeHypothesisIds: assessment.hypothesesTouched,
  };

  const lines: string[] = [
    `### ${assessment.role.toUpperCase()} agent`,
    `- vote: ${assessment.recommendedLabel}`,
    `- summary: ${assessment.summary}`,
    `- input.roundObjective: ${inputSnapshot.roundObjective.title} | ${inputSnapshot.roundObjective.directive}`,
    `- input.roleDisagreementsFromPreviousRound:`,
    ...formatList(roleDisagreements(previousRound, role), '  '),
    `- input.peerAssessmentSummaries:`,
    ...formatList(inputSnapshot.peerAssessmentSummaries, '  '),
    `- evidenceItems:`,
    ...formatList(assessment.evidenceItems.map(evidenceLine), '  '),
    `- toolTrace:`,
  ];

  if (assessment.evaluationTrace.length === 0) {
    lines.push('  - (none)');
    return lines;
  }

  for (const trace of assessment.evaluationTrace) {
    const argumentSummary = summarizeToolArguments(trace.toolArguments);
    lines.push(`  - ${trace.toolName}`);
    lines.push(`    - interpreted: ${trace.interpretedOutput.stance}/${trace.interpretedOutput.strength} | ${trace.interpretedOutput.claim}`);
    if (argumentSummary.length > 0) {
      lines.push(`    - args: ${argumentSummary.join(' ; ')}`);
    }
    lines.push(
      `    - raw: ${truncate(trace.rawToolOutput.textSummary.replace(/\s+/g, ' ').trim())}`,
    );
  }

  return lines;
}

async function main(): Promise<void> {
  const sampleIndex = Number(process.argv[2] ?? '6144');
  const runner = new BiomedWorkflowRunner();
  const loader = new CsvTaskLoader({
    dataDir: '/home/zhx/drug_agent/data_edge_test',
    relationshipType: 'drug_protein_disease',
  });
  const samples = await loader.loadSamples();
  const sample = samples.find((item) => item.sampleIndex === sampleIndex);
  if (sample === undefined) {
    throw new Error(`sample ${sampleIndex} not found`);
  }

  const result = await runner.runSample(sample);
  const output: string[] = [];

  output.push(`# Multi-debate Case Study`);
  output.push(`- sampleIndex: ${sample.sampleIndex}`);
  output.push(`- entities: ${JSON.stringify(sample.entityDict)}`);
  output.push(`- groundTruth: ${String(sample.groundTruth ?? 'unknown')}`);
  output.push(`- finalDecision: label=${result.decision.label}, status=${result.decision.status}, confidence=${result.decision.confidence}`);
  output.push(`- rationale: ${result.decision.rationale}`);
  output.push('');

  for (const round of result.trace.rounds) {
    const previousRound = result.trace.rounds.find(
      (item) => item.roundNumber === round.roundNumber - 1,
    );
    output.push(`## Round ${round.roundNumber}`);
    output.push(`- roundSummary: ${round.summary}`);
    output.push(`- objective: ${round.roundObjective.title}`);
    output.push(`- directive: ${round.roundObjective.directive}`);
    output.push(`- responseRequirement: ${round.roundObjective.responseRequirement}`);
    output.push(`- board.status: ${round.sharedEvidenceBoard.status}`);
    output.push(`- board.voteSummary:`);
    output.push(...formatList(round.sharedEvidenceBoard.voteSummary, '  '));
    output.push(`- board.positiveEvidence:`);
    output.push(...formatList(round.sharedEvidenceBoard.positiveEvidence, '  '));
    output.push(`- board.negativeEvidence:`);
    output.push(...formatList(round.sharedEvidenceBoard.negativeEvidence, '  '));
    output.push(`- board.contestedClaims:`);
    output.push(...formatList(round.sharedEvidenceBoard.contestedClaims, '  '));
    output.push(`- currentRound.disagreements:`);
    output.push(
      ...formatList(
        round.disagreements.map(
          (item) => `${item.title} [${item.escalationLevel}] ${item.question}`,
        ),
        '  ',
      ),
    );
    output.push('');
    for (const assessment of round.assessments) {
      output.push(...describeAssessment(assessment, round, previousRound));
      output.push('');
    }
  }

  const arbiter = result.trace.assessments.find((item) => item.role === 'arbiter');
  if (arbiter !== undefined) {
    output.push('## Arbiter');
    output.push(`- summary: ${arbiter.summary}`);
    output.push(`- vote: ${arbiter.recommendedLabel}`);
    output.push(`- evidence:`);
    output.push(...formatList(arbiter.evidenceItems.map(evidenceLine), '  '));
  }

  console.log(output.join('\n'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});