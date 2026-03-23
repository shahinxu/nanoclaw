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
  drugWeakSupports: number;
  proteinWeakSupports: number;
  diseaseWeakSupports: number;
  graphWeakSupports: number;
  drugModerateOrStrongSupports: number;
  proteinModerateOrStrongSupports: number;
  diseaseModerateOrStrongSupports: number;
  graphStrongSupports: number;
  graphModerateSupports: number;
  contradictions: EvidenceItem[];
  allEvidence: EvidenceItem[];
}

interface AgentVoteSummary {
  positiveVotes: number;
  negativeVotes: number;
  abstentions: number;
  byRole: Record<string, 0 | 1 | null>;
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
    drugWeakSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'drug_agent' &&
        item.strength === 'weak',
    ).length,
    proteinWeakSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'protein_agent' &&
        item.strength === 'weak',
    ).length,
    diseaseWeakSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'disease_agent' &&
        item.strength === 'weak',
    ).length,
    graphWeakSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'graph_agent' &&
        item.strength === 'weak',
    ).length,
    drugModerateOrStrongSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'drug_agent' &&
        item.strength !== 'weak',
    ).length,
    proteinModerateOrStrongSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'protein_agent' &&
        item.strength !== 'weak',
    ).length,
    diseaseModerateOrStrongSupports: evidenceItems.filter(
      (item) =>
        item.stance === 'supports' &&
        item.source === 'disease_agent' &&
        item.strength !== 'weak',
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
    `Expert support counts: drug=${summary.drugSupports} (weak=${summary.drugWeakSupports}), protein=${summary.proteinSupports} (weak=${summary.proteinWeakSupports}), disease=${summary.diseaseSupports} (weak=${summary.diseaseWeakSupports}), graph=${summary.graphSupports} (weak=${summary.graphWeakSupports}, strong=${summary.graphStrongSupports}, moderate=${summary.graphModerateSupports}).`,
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

function summarizeVotes(assessments: AgentAssessment[]): AgentVoteSummary {
  const roles: Array<AgentAssessment['role']> = [
    'drug',
    'protein',
    'disease',
    'graph',
  ];
  const byRole: Record<string, 0 | 1 | null> = {};

  for (const role of roles) {
    const assessment = assessments.find((item) => item.role === role);
    if (!assessment) {
      byRole[role] = null;
      continue;
    }

    const supports = assessment.evidenceItems.filter(
      (item) => item.stance === 'supports',
    ).length;
    const contradicts = assessment.evidenceItems.filter(
      (item) => item.stance === 'contradicts',
    ).length;

    if (supports === 0 && contradicts === 0) {
      byRole[role] = null;
    } else {
      byRole[role] = supports >= contradicts ? 1 : 0;
    }
  }

  const votes = Object.values(byRole);
  return {
    positiveVotes: votes.filter((vote) => vote === 1).length,
    negativeVotes: votes.filter((vote) => vote === 0).length,
    abstentions: votes.filter((vote) => vote === null).length,
    byRole,
  };
}

function hasBioSideSupport(summary: SupportSummary): boolean {
  return (
    summary.proteinSupports > 0 ||
    summary.diseaseSupports > 0 ||
    summary.graphSupports > 0
  );
}

function hasBioSideModerateSupport(summary: SupportSummary): boolean {
  return (
    summary.proteinModerateOrStrongSupports > 0 ||
    summary.diseaseModerateOrStrongSupports > 0 ||
    summary.graphModerateSupports > 0 ||
    summary.graphStrongSupports > 0
  );
}

function countRolesWithSupport(summary: SupportSummary): number {
  return [
    summary.drugSupports,
    summary.proteinSupports,
    summary.diseaseSupports,
    summary.graphSupports,
  ].filter((count) => count > 0).length;
}

export function decideLabel(input: DecisionPolicyInput): DecisionRecord {
  const evidenceItems = collectEvidence(input.assessments);
  const summary = summarizeSupport(evidenceItems);
  const votes = summarizeVotes(input.assessments);
  const blockingGaps: string[] = [];
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
    blockingGaps.push(
      `Agent vote split: positive=${votes.positiveVotes}, negative=${votes.negativeVotes}, abstain=${votes.abstentions}.`,
    );
  }

  const voteMargin = Math.abs(votes.positiveVotes - votes.negativeVotes);
  const majorityLabel: 0 | 1 =
    votes.positiveVotes > votes.negativeVotes ? 1 : 0;
  const multiRoleSupport = countRolesWithSupport(summary);
  const controlledAggressivePositive =
    summary.drugSupports > 0 &&
    hasBioSideSupport(summary) &&
    summary.contradictions.length === 0;
  const strongerControlledPositive =
    summary.drugModerateOrStrongSupports > 0 &&
    hasBioSideModerateSupport(summary) &&
    summary.contradictions.length <= 1;

  if (strongerControlledPositive) {
    return {
      status: 'supported',
      decisionMode: 'settled',
      label: 1,
      confidence: 0.74,
      rationale: `${buildRationale(summary, blockingGaps)} Controlled-aggressive rule triggered because drug-side support reached moderate-or-strong evidence and at least one biological side also provided non-weak support.`,
      blockingGaps,
      contradictions: contradictionClaims,
    };
  }

  if (
    controlledAggressivePositive &&
    multiRoleSupport >= 2 &&
    votes.negativeVotes === 0
  ) {
    return {
      status: 'supported',
      decisionMode: 'settled',
      label: 1,
      confidence: 0.66,
      rationale: `${buildRationale(summary, blockingGaps)} Controlled-aggressive rule triggered because drug-side support plus at least one biological-side support formed a closed weak evidence chain without negative votes.`,
      blockingGaps,
      contradictions: contradictionClaims,
    };
  }

  if (votes.positiveVotes !== votes.negativeVotes) {
    return {
      status: majorityLabel === 1 ? 'supported' : 'refuted',
      decisionMode: 'settled',
      label: majorityLabel,
      confidence: 0.5 + Math.min(voteMargin, 2) * 0.1,
      rationale: `${buildRationale(summary, blockingGaps)} Majority vote across agents: ${JSON.stringify(votes.byRole)}.`,
      blockingGaps,
      contradictions: contradictionClaims,
    };
  }

  if (
    votes.positiveVotes === votes.negativeVotes &&
    summary.drugSupports > 0 &&
    (summary.proteinSupports > 0 || summary.diseaseSupports > 0) &&
    votes.negativeVotes <= 1
  ) {
    return {
      status: 'supported',
      decisionMode: 'settled',
      label: 1,
      confidence: 0.58,
      rationale: `${buildRationale(summary, blockingGaps)} Positive tie-break triggered because drug support co-occurred with at least one biological-side support, and the graph side did not contribute a strong contrary signal.`,
      blockingGaps,
      contradictions: contradictionClaims,
    };
  }

  if (summary.allEvidence.length > 0) {
    return {
      status: 'insufficient',
      decisionMode: 'best-effort-insufficient',
      label: 0,
      confidence: 0.3,
      rationale: `${buildRationale(summary, blockingGaps)} Agent votes are tied (${JSON.stringify(votes.byRole)}), so no majority emerged. A compatibility label of 0 is returned for the tie case.`,
      blockingGaps,
      contradictions: contradictionClaims,
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
