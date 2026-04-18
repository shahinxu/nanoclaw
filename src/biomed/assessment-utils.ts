import { AgentAssessment, AgentRoundContext, BiomedLabel, EvidenceItem } from './types.js';

const VALID_LABELS: ReadonlySet<number> = new Set([-1, 0, 1, 2]);

/** Parse a recommended_label from the Python result, supporting multiclass. */
export function parseLabelFromRaw(raw: unknown): BiomedLabel {
  if (typeof raw === 'number' && VALID_LABELS.has(raw)) {
    return raw as BiomedLabel;
  }
  const n = Number(raw);
  if (!Number.isNaN(n) && VALID_LABELS.has(n)) {
    return n as BiomedLabel;
  }
  return 0;
}

/** Map a label to stance. Labels >= 1 are 'supports', others 'contradicts'. */
export function labelToStance(label: BiomedLabel): 'supports' | 'contradicts' {
  return label >= 1 ? 'supports' : 'contradicts';
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function hasAlternativeMechanismPressure(
  roundContext?: AgentRoundContext,
): boolean {
  return (
    (roundContext?.alternativeMechanismSignals.length ?? 0) > 0 ||
    (roundContext?.negativeEvidenceDigest.length ?? 0) > 1
  );
}

export function binaryRecommendationFromEvidence(
  evidenceItems: EvidenceItem[],
): 0 | 1 {
  const supportCount = evidenceItems.filter(
    (item) => item.stance === 'supports',
  ).length;
  const contradictionCount = evidenceItems.filter(
    (item) => item.stance === 'contradicts',
  ).length;
  return supportCount > contradictionCount ? 1 : 0;
}

export function parseStructuredReasonerOutput(
  structured: Record<string, unknown> | null,
): {
  stance: EvidenceItem['stance'];
  strength: EvidenceItem['strength'];
  claim: string;
  recommendedLabel: BiomedLabel;
} | null {
  if (!structured) {
    return null;
  }
  const stance = structured.stance;
  const strength = structured.strength;
  const claim = structured.claim;
  const recommendedLabel = structured.recommended_label;
  if (
    (stance === 'supports' || stance === 'contradicts') &&
    (strength === 'strong' || strength === 'moderate' || strength === 'weak') &&
    typeof claim === 'string' &&
    (recommendedLabel === -1 || recommendedLabel === 0 || recommendedLabel === 1 || recommendedLabel === 2)
  ) {
    return {
      stance,
      strength,
      claim,
      recommendedLabel: recommendedLabel as BiomedLabel,
    };
  }
  return null;
}

export function evidenceStrengthScore(item: EvidenceItem): number {
  if (item.strength === 'strong') {
    return 3;
  }
  if (item.strength === 'moderate') {
    return 2;
  }
  return 1;
}

export function summarizePeerAssessment(assessment: AgentAssessment): string {
  const strongestEvidence = [...assessment.evidenceItems].sort(
    (left, right) => evidenceStrengthScore(right) - evidenceStrengthScore(left),
  )[0];

  if (!strongestEvidence) {
    return `${assessment.role}: vote=${assessment.recommendedLabel}. ${assessment.summary}`;
  }

  return `${assessment.role}: vote=${assessment.recommendedLabel}. ${assessment.summary} Strongest prior claim: ${strongestEvidence.stance}/${strongestEvidence.strength} via ${strongestEvidence.toolName}: ${strongestEvidence.claim}`;
}
