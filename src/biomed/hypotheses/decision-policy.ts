import { BiomedWorkflowConfig } from '../config.js';
import {
  AgentAssessment,
  DecisionRecord,
  EvidenceItem,
  HypothesisRecord,
} from '../types.js';

export interface DecisionPolicyInput {
  hypotheses: HypothesisRecord[];
  assessments: AgentAssessment[];
  config: BiomedWorkflowConfig;
}

interface SupportSummary {
  drugSupports: number;
  proteinSupports: number;
  diseaseSupports: number;
  graphSupports: number;
  graphStrongSupports: number;
  graphModerateSupports: number;
  contradictions: EvidenceItem[];
  allEvidence: EvidenceItem[];
}

function collectEvidence(assessments: AgentAssessment[]): EvidenceItem[] {
  return assessments.flatMap((assessment) => assessment.evidenceItems);
}

function summarizeSupport(evidenceItems: EvidenceItem[]): SupportSummary {
  return {
    drugSupports: evidenceItems.filter(
      (item) => item.stance === 'supports' && item.source === 'drug_agent',
    ).length,
    proteinSupports: evidenceItems.filter(
      (item) => item.stance === 'supports' && item.source === 'protein_agent',
    ).length,
    diseaseSupports: evidenceItems.filter(
      (item) => item.stance === 'supports' && item.source === 'disease_agent',
    ).length,
    graphSupports: evidenceItems.filter(
      (item) => item.stance === 'supports' && item.source === 'graph_agent',
    ).length,
    graphStrongSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'graph_agent' &&
        item.strength === 'strong',
    ).length,
    graphModerateSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'graph_agent' &&
        item.strength === 'moderate',
    ).length,
    contradictions: evidenceItems.filter(
      (item) => item.stance === 'contradicts',
    ),
    allEvidence: evidenceItems,
  };
}

function buildRationale(
  summary: SupportSummary,
  blockingGaps: string[],
): string {
  const clauses: string[] = [];

  clauses.push(
    `Expert support counts: drug=${summary.drugSupports}, protein=${summary.proteinSupports}, disease=${summary.diseaseSupports}, graph=${summary.graphSupports} (strong=${summary.graphStrongSupports}, moderate=${summary.graphModerateSupports}).`,
  );

  if (summary.contradictions.length > 0) {
    clauses.push(
      `Contradictions detected: ${summary.contradictions.map((item) => item.claim).join(' | ')}`,
    );
  }

  if (blockingGaps.length > 0) {
    clauses.push(`Blocking gaps: ${blockingGaps.join(' | ')}`);
  }

  return clauses.join(' ');
}

function majorityFallbackLabel(summary: SupportSummary): 0 | 1 {
  const supportVotes = [
    summary.drugSupports > 0 ? 1 : 0,
    summary.proteinSupports > 0 ? 1 : 0,
    summary.diseaseSupports > 0 ? 1 : 0,
    summary.graphSupports > 0 ? 1 : 0,
  ].reduce((count, value) => count + value, 0);

  return supportVotes >= 2 ? 1 : 0;
}

export function decideLabel(input: DecisionPolicyInput): DecisionRecord {
  const evidenceItems = collectEvidence(input.assessments);
  const summary = summarizeSupport(evidenceItems);
  const blockingGaps: string[] = [];
  const totalSupports =
    summary.drugSupports +
    summary.proteinSupports +
    summary.diseaseSupports +
    summary.graphSupports;
  const contradictionClaims = summary.contradictions.map((item) => item.claim);

  if (summary.drugSupports === 0) {
    blockingGaps.push('No drug-side supporting evidence was found.');
  }

  if (summary.proteinSupports === 0) {
    blockingGaps.push('No protein-side disease relevance support was found.');
  }

  if (summary.diseaseSupports === 0) {
    blockingGaps.push('No disease-side context support was found.');
  }

  if (summary.contradictions.length > 0) {
    return {
      status: 'refuted',
      decisionMode: 'settled',
      label: 0,
      confidence: 0.75,
      rationale: buildRationale(summary, blockingGaps),
      blockingGaps,
      contradictions: contradictionClaims,
    };
  }

  if (
    summary.drugSupports > 0 &&
    summary.proteinSupports > 0 &&
    summary.diseaseSupports > 0
  ) {
    return {
      status: 'supported',
      decisionMode: 'settled',
      label: 1,
      confidence: 0.75,
      rationale: buildRationale(summary, blockingGaps),
      blockingGaps,
      contradictions: [],
    };
  }

  if (
    summary.graphSupports > 0 &&
    [
      summary.drugSupports,
      summary.proteinSupports,
      summary.diseaseSupports,
    ].filter((count) => count > 0).length >= 2
  ) {
    return {
      status: 'supported',
      decisionMode: 'settled',
      label: 1,
      confidence: 0.7,
      rationale: `${buildRationale(summary, blockingGaps)} Graph neighborhood evidence supplies an additional structural bridge, so the positive decision is treated as settled.`,
      blockingGaps,
      contradictions: [],
    };
  }

  if (
    summary.graphStrongSupports > 0 &&
    [
      summary.drugSupports,
      summary.proteinSupports,
      summary.diseaseSupports,
    ].filter((count) => count > 0).length >= 1
  ) {
    return {
      status: 'supported',
      decisionMode: 'settled',
      label: 1,
      confidence: 0.72,
      rationale: `${buildRationale(summary, blockingGaps)} Strong graph evidence supplies a high-confidence structural bridge, and at least one domain expert also supports the triplet, so the decision is promoted to settled positive.`,
      blockingGaps,
      contradictions: [],
    };
  }

  if (totalSupports > 0) {
    const fallbackLabel = majorityFallbackLabel(summary);
    return {
      status: 'insufficient',
      decisionMode: 'best-effort-insufficient',
      label: fallbackLabel,
      confidence: 0.45,
      rationale: `${buildRationale(summary, blockingGaps)} Current evidence remains insufficient for a settled positive or negative decision. A symmetric best-effort export label of ${fallbackLabel} is returned for compatibility, but debate and targeted evidence collection should continue.`,
      blockingGaps,
      contradictions: [],
    };
  }

  if (summary.allEvidence.length > 0) {
    return {
      status: 'insufficient',
      decisionMode: 'best-effort-insufficient',
      label: 0,
      confidence: 0.25,
      rationale: `${buildRationale(summary, blockingGaps)} Evidence was collected, but it does not yet justify a settled positive or negative decision. A best-effort export label of 0 is returned because no majority support emerged, but debate and evidence collection should continue.`,
      blockingGaps,
      contradictions: [],
    };
  }

  return {
    status: 'insufficient',
    decisionMode: 'best-effort-insufficient',
    label: 0,
    confidence: 0,
    rationale: `${buildRationale(summary, blockingGaps)} No meaningful evidence has been established yet. A best-effort export label of 0 is returned for compatibility only, and the case should remain treated as unresolved.`,
    blockingGaps,
    contradictions: [],
  };
}
