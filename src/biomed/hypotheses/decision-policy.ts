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
    `Expert support counts: drug=${summary.drugSupports}, protein=${summary.proteinSupports}, disease=${summary.diseaseSupports}.`,
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

export function decideLabel(input: DecisionPolicyInput): DecisionRecord {
  const evidenceItems = collectEvidence(input.assessments);
  const summary = summarizeSupport(evidenceItems);
  const blockingGaps: string[] = [];
  const totalSupports =
    summary.drugSupports + summary.proteinSupports + summary.diseaseSupports;

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
      label: 0,
      confidence: 0.75,
      rationale: buildRationale(summary, blockingGaps),
      blockingGaps,
      contradictions: summary.contradictions.map((item) => item.claim),
    };
  }

  if (
    summary.drugSupports > 0 &&
    summary.proteinSupports > 0 &&
    summary.diseaseSupports > 0
  ) {
    return {
      label: 1,
      confidence: 0.75,
      rationale: buildRationale(summary, blockingGaps),
      blockingGaps,
      contradictions: [],
    };
  }

  if (totalSupports > 0) {
    return {
      label: 0,
      confidence: 0.55,
      rationale: buildRationale(summary, blockingGaps),
      blockingGaps,
      contradictions: [],
    };
  }

  if (summary.allEvidence.length > 0) {
    return {
      label: 0,
      confidence: 0.35,
      rationale: buildRationale(summary, blockingGaps),
      blockingGaps,
      contradictions: [],
    };
  }

  return {
    label: 0,
    confidence: 0,
    rationale: buildRationale(summary, blockingGaps),
    blockingGaps,
    contradictions: [],
  };
}
