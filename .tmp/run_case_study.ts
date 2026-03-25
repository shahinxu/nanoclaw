declare const process: {
  argv: string[];
  exitCode?: number;
};

import { BiomedWorkflowRunner } from '../src/biomed/runner.ts';
import { CsvTaskLoader } from '../src/biomed/task-loader.ts';
import type {
  AgentAssessment,
  EvidenceItem,
  SampleRoundRecord,
} from '../src/biomed/types.ts';

function formatList(items: string[], indent = ''): string[] {
  if (items.length === 0) {
    return [`${indent}- (none)`];
  }
  return items.map((item) => `${indent}- ${item}`);
}

function evidenceLine(item: EvidenceItem): string {
  return `${item.stance}/${item.strength} via ${item.toolName}: ${item.claim}`;
}

function describeAssessment(
  assessment: AgentAssessment,
  _round: SampleRoundRecord,
): string[] {
  const lines: string[] = [
    `### ${assessment.role.toUpperCase()} agent`,
    `- vote: ${assessment.recommendedLabel}`,
    `- summary: ${assessment.summary}`,
    `- effectiveEvidence:`,
    ...formatList(assessment.evidenceItems.map(evidenceLine), '  '),
  ];

  return lines;
}

async function main(): Promise<void> {
  const sampleIndex = Number(process.argv[2] ?? '6144');
  const dataDir = process.argv[3] ?? '/home/zhx/drug_agent/data_edge_test';
  const runner = new BiomedWorkflowRunner();
  const loader = new CsvTaskLoader({
    dataDir,
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
      output.push(...describeAssessment(assessment, round));
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