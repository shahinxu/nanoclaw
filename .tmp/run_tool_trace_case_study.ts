declare const process: {
  argv: string[];
  exitCode?: number;
};

import { BiomedWorkflowRunner } from '../src/biomed/runner.ts';
import { CsvTaskLoader } from '../src/biomed/task-loader.ts';
import type {
  AgentAssessment,
  AgentEvaluationTrace,
  SampleRoundRecord,
} from '../src/biomed/types.ts';

function truncate(value: string, max = 1000): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function formatList(items: string[], indent = ''): string[] {
  if (items.length === 0) {
    return [`${indent}- (none)`];
  }
  return items.map((item) => `${indent}- ${item}`);
}

function stripReasonerPrefix(text: string): string {
  const normalized = text.trim();
  return normalized.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '');
}

function findPreferredFinalTrace(
  traces: AgentEvaluationTrace[],
): AgentEvaluationTrace | undefined {
  const reversed = [...traces].reverse();
  return (
    reversed.find((trace) => /reasoner/i.test(trace.toolName)) ??
    reversed.find((trace) => /^\[[^\]]+\]/.test(trace.rawToolOutput.textSummary ?? '')) ??
    reversed[0]
  );
}

function getFinalReason(assessment: AgentAssessment): string {
  const finalTrace = findPreferredFinalTrace(assessment.evaluationTrace);
  if (!finalTrace) {
    return assessment.summary;
  }

  const rawSummary = finalTrace.rawToolOutput.textSummary?.trim();
  if (!rawSummary) {
    return assessment.summary;
  }

  return stripReasonerPrefix(rawSummary);
}

function describeTrace(trace: AgentEvaluationTrace): string[] {
  return [
    `- ${trace.toolName}: ${truncate(trace.rawToolOutput.textSummary, 500) || '(empty)'}`,
  ];
}

function getSupportingTraces(assessment: AgentAssessment): AgentEvaluationTrace[] {
  const preferred = findPreferredFinalTrace(assessment.evaluationTrace);
  return assessment.evaluationTrace.filter((trace) => trace !== preferred);
}

function describeAssessment(
  assessment: AgentAssessment,
  round: SampleRoundRecord,
): string[] {
  const lines: string[] = [
    `### ${assessment.role.toUpperCase()} agent`,
    `- vote: ${assessment.recommendedLabel}`,
    `- summary: ${assessment.summary}`,
    `- hypothesesTouched: ${assessment.hypothesesTouched.join(', ') || '(none)'}`,
    `- roundFocus: ${round.focus.join(' | ') || '(none)'}`,
    `- finalReason: ${getFinalReason(assessment)}`,
    `- supportingToolOutputs:`,
  ];

  const supportingTraces = getSupportingTraces(assessment);

  if (supportingTraces.length === 0) {
    lines.push('  - (none)');
  } else {
    for (const trace of supportingTraces) {
      lines.push(...describeTrace(trace).map((line) => `  ${line}`));
    }
  }

  return lines;
}

async function main(): Promise<void> {
  const sampleIndex = Number(process.argv[2] ?? '1854');
  const runner = new BiomedWorkflowRunner();
  const loader = new CsvTaskLoader({
    dataDir: '/home/zhx/drug_agent/data_edge_test',
    relationshipType: 'drug_protein_disease',
  });
  const samples = await loader.loadSamples();
  const sample = samples.find((item) => item.sampleIndex === sampleIndex);
  if (!sample) {
    throw new Error(`sample ${sampleIndex} not found`);
  }

  const result = await runner.runSample(sample);
  const output: string[] = [];
  output.push('# Tool-Trace Case Study');
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
    output.push(`- sharedDebateQuestion: ${round.roundObjective.sharedDebateQuestion ?? '(none)'}`);
    output.push(`- roundFocus: ${round.focus.join(' | ') || '(none)'}`);
    output.push('');
    for (const assessment of round.assessments) {
      output.push(...describeAssessment(assessment, round));
      output.push('');
    }
  }

  console.log(output.join('\n'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});