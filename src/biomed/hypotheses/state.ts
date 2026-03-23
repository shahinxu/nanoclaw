import {
  EvidenceItem,
  HypothesisRecord,
  RoundDisagreement,
  SampleRoundRecord,
} from '../types.js';

export interface HypothesisState {
  hypotheses: HypothesisRecord[];
  rounds: SampleRoundRecord[];
  unresolvedDisagreements: RoundDisagreement[];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function summarizeSupports(evidenceItems: EvidenceItem[]): string[] {
  return evidenceItems
    .filter((item) => item.stance === 'supports')
    .map((item) => item.claim);
}

function summarizeContradictions(evidenceItems: EvidenceItem[]): string[] {
  return evidenceItems
    .filter((item) => item.stance === 'contradicts')
    .map((item) => item.claim);
}

function buildAlternativeHypothesis(
  round: SampleRoundRecord,
  disagreement: RoundDisagreement,
  parentPositiveId: string | undefined,
): HypothesisRecord {
  const affectedRole = disagreement.affectedRoles[0] ?? 'drug';
  const roleSpecificStatement =
    disagreement.title === 'cross-agent mismatch'
      ? 'The queried triplet may be partially correct, but the true positive signal may depend on an alternative mechanism or incomplete alignment across drug, protein, and disease evidence.'
      : affectedRole === 'drug'
        ? 'The queried drug may match the disease context, but the true effect may be mediated by an alternative or indirect target rather than the queried protein.'
        : affectedRole === 'protein'
          ? 'The queried protein may capture disease-relevant biology, but the predictive signal may arise from broader pathway support rather than a direct triplet-level mechanism.'
          : 'The queried disease context may fit the drug-protein pair only indirectly, with disease relevance mediated by adjacent targets, treatments, or pathway-level context.';

  const requiredChecks =
    disagreement.title === 'cross-agent mismatch'
      ? [
          'resolve cross-agent support mismatch',
          'test alternative mechanism or pathway explanation',
          'check whether direct triplet support is incomplete but still predictive',
        ]
      : [
          disagreement.question,
          `re-check ${affectedRole}-side evidence under the new interpretation`,
          'test whether the new explanation improves prediction quality',
        ];

  return {
    id: `H-alt-${round.roundNumber}-${disagreement.id}`,
    statement: roleSpecificStatement,
    kind: 'alternative-mechanism',
    status: 'open',
    requiredChecks,
    evidenceFor: [],
    evidenceAgainst: [],
    confidence: 0.2,
    createdRound: round.roundNumber,
    lastUpdatedRound: round.roundNumber,
    derivedFromId: parentPositiveId,
    revisionReason: disagreement.rationale,
  };
}

function reviseHypotheses(
  hypotheses: HypothesisRecord[],
  round: SampleRoundRecord,
): HypothesisRecord[] {
  const supports = summarizeSupports(round.evidenceItems);
  const contradictions = summarizeContradictions(round.evidenceItems);
  const positiveSupportCount = supports.length;
  const contradictionCount = contradictions.length;

  const revised = hypotheses.map((hypothesis) => {
    const next: HypothesisRecord = {
      ...hypothesis,
      evidenceFor: dedupe([...hypothesis.evidenceFor, ...supports]),
      evidenceAgainst: dedupe([...hypothesis.evidenceAgainst, ...contradictions]),
      lastUpdatedRound: round.roundNumber,
    };

    if (hypothesis.kind === 'positive') {
      next.status =
        positiveSupportCount >= 2 && contradictionCount === 0
          ? 'supported'
          : contradictionCount > 0 && positiveSupportCount === 0
            ? 'refuted'
            : positiveSupportCount > 0
              ? 'insufficient'
              : 'open';
      next.confidence = Math.max(
        0,
        Math.min(1, positiveSupportCount * 0.22 - contradictionCount * 0.12),
      );
      if (round.disagreements.length > 0) {
        next.requiredChecks = dedupe([
          ...hypothesis.requiredChecks,
          ...round.disagreements.map((item) => item.question),
        ]);
      }
      return next;
    }

    if (hypothesis.kind === 'negative') {
      next.status =
        contradictionCount > 0 && positiveSupportCount <= 1
          ? 'supported'
          : positiveSupportCount >= 2 && contradictionCount === 0
            ? 'refuted'
            : positiveSupportCount > 0
              ? 'insufficient'
              : 'open';
      next.confidence = Math.max(
        0,
        Math.min(1, contradictionCount * 0.25 + (positiveSupportCount === 0 ? 0.15 : 0)),
      );
      return next;
    }

    const roleHints = round.disagreements.filter((item) => item.id === hypothesis.id.replace('H-alt-' + round.roundNumber + '-', ''));
    next.status =
      positiveSupportCount > 0 && round.disagreements.length > 0
        ? 'supported'
        : contradictionCount > 0 && roleHints.length === 0
          ? 'insufficient'
          : next.status;
    next.confidence = Math.max(next.confidence, positiveSupportCount > 0 ? 0.35 : 0.2);
    return next;
  });

  const positiveHypothesis = revised.find((item) => item.kind === 'positive');
  const existingIds = new Set(revised.map((item) => item.id));
  const newAlternatives = round.disagreements
    .filter(
      (item) =>
        item.roundNumber >= 2 &&
        (item.title.includes('mismatch') || item.title.includes('gap') || item.title.includes('contradiction')),
    )
    .map((item) => buildAlternativeHypothesis(round, item, positiveHypothesis?.id))
    .filter((item) => !existingIds.has(item.id));

  return [...revised, ...newAlternatives];
}

export function createHypothesisState(
  hypotheses: HypothesisRecord[] = [],
): HypothesisState {
  return {
    hypotheses,
    rounds: [],
    unresolvedDisagreements: [],
  };
}

export function advanceHypothesisState(
  state: HypothesisState,
  round: SampleRoundRecord,
): HypothesisState {
  const revisedHypotheses = reviseHypotheses(state.hypotheses, round);
  return {
    hypotheses: revisedHypotheses,
    rounds: [
      ...state.rounds,
      {
        ...round,
        hypothesisSnapshot: revisedHypotheses.map((item) => ({ ...item })),
      },
    ],
    unresolvedDisagreements: round.disagreements.filter(
      (item) => item.status !== 'resolved',
    ),
  };
}
