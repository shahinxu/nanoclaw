import { BiomedWorkflowConfig } from '../config.js';
import { AgentAssessment, DecisionRecord, HypothesisRecord } from '../types.js';

export interface DecisionPolicyInput {
  hypotheses: HypothesisRecord[];
  assessments: AgentAssessment[];
  config: BiomedWorkflowConfig;
}

function findRoot(
  hypotheses: HypothesisRecord[],
  kind: 'positive' | 'negative',
): HypothesisRecord | undefined {
  return hypotheses.find(
    (hypothesis) =>
      hypothesis.kind === kind && hypothesis.parentId === undefined,
  );
}

function describeChildren(
  hypotheses: HypothesisRecord[],
  parentId: string | undefined,
): string[] {
  if (!parentId) {
    return [];
  }
  return hypotheses
    .filter((hypothesis) => hypothesis.parentId === parentId)
    .map(
      (hypothesis) =>
        `${hypothesis.topicKey ?? hypothesis.id}=${hypothesis.status}(confidence=${hypothesis.confidence.toFixed(2)})`,
    );
}

export function decideLabel(input: DecisionPolicyInput): DecisionRecord {
  const positiveRoot = findRoot(input.hypotheses, 'positive');
  const negativeRoot = findRoot(input.hypotheses, 'negative');
  const blockingGaps = input.hypotheses
    .filter(
      (hypothesis) =>
        hypothesis.frontier &&
        (hypothesis.status === 'open' || hypothesis.status === 'insufficient'),
    )
    .map(
      (hypothesis) =>
        hypothesis.statement || hypothesis.requiredChecks[0] || hypothesis.id,
    );
  const contradictions = positiveRoot?.evidenceAgainst ?? [];
  const childSummary = describeChildren(input.hypotheses, positiveRoot?.id);

  if (!positiveRoot || !negativeRoot) {
    return {
      status: 'insufficient',
      decisionMode: 'best-effort-insufficient',
      label: 0,
      confidence: 0,
      rationale:
        'The recursive hypothesis tree was not initialized correctly, so no root-derived decision could be produced.',
      blockingGaps,
      contradictions,
    };
  }

  if (
    positiveRoot.status === 'supported' &&
    negativeRoot.status !== 'supported'
  ) {
    return {
      status: 'supported',
      decisionMode: 'settled',
      label: 1,
      confidence: positiveRoot.confidence,
      rationale: `Root positive hypothesis is supported. Child status summary: ${childSummary.join(' | ')}.`,
      blockingGaps,
      contradictions,
    };
  }

  if (
    negativeRoot.status === 'supported' ||
    positiveRoot.status === 'refuted'
  ) {
    return {
      status: 'refuted',
      decisionMode: 'settled',
      label: 0,
      confidence: Math.max(negativeRoot.confidence, positiveRoot.confidence),
      rationale: `Root negative hypothesis is supported or the positive root is refuted. Child status summary: ${childSummary.join(' | ')}.`,
      blockingGaps,
      contradictions,
    };
  }

  return {
    status: 'insufficient',
    decisionMode: 'best-effort-insufficient',
    label: 0,
    confidence: positiveRoot.confidence,
    rationale: `The root hypothesis remains unresolved after recursive propagation. Child status summary: ${childSummary.join(' | ')}.`,
    blockingGaps,
    contradictions,
  };
}
