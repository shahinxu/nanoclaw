import {
  AgentAssessment,
  BiomedLabel,
  BiomedTaskSample,
  DecisionRecord,
  HypothesisRecord,
  PlannerAction,
  SampleRoundRecord,
} from '../types.js';

export interface ArbiterInput {
  sample: BiomedTaskSample;
  hypotheses: HypothesisRecord[];
  assessments: AgentAssessment[];
  rounds: SampleRoundRecord[];
}

export interface ArbiterResult {
  assessment: AgentAssessment;
  decision: DecisionRecord;
}

function summarizeVotes(assessments: AgentAssessment[]): {
  positiveVotes: number;
  negativeVotes: number;
  abstentions: number;
  voteCounts: Map<BiomedLabel, number>;
} {
  const voteCounts = new Map<BiomedLabel, number>();
  for (const assessment of assessments) {
    const label = assessment.recommendedLabel;
    voteCounts.set(label, (voteCounts.get(label) ?? 0) + 1);
  }
  const positiveVotes = assessments.filter(
    (assessment) => assessment.recommendedLabel === 1,
  ).length;
  const negativeVotes = assessments.filter(
    (assessment) => assessment.recommendedLabel === 0,
  ).length;
  return {
    positiveVotes,
    negativeVotes,
    abstentions: Math.max(
      0,
      assessments.length - positiveVotes - negativeVotes,
    ),
    voteCounts,
  };
}

function voteToStatus(label: BiomedLabel): DecisionRecord['status'] {
  return label >= 1 ? 'supported' : 'refuted';
}

function majorityDecisionLabel(assessments: AgentAssessment[]): BiomedLabel {
  // Plurality vote: the label with the most votes wins.
  // Ties are broken by preferring the lower label (more conservative).
  const { voteCounts } = summarizeVotes(assessments);
  let bestLabel: BiomedLabel = 0;
  let bestCount = 0;
  for (const [label, count] of voteCounts) {
    if (count > bestCount || (count === bestCount && label < bestLabel)) {
      bestLabel = label;
      bestCount = count;
    }
  }
  return bestLabel;
}

export class Arbiter {
  async decide(input: ArbiterInput): Promise<ArbiterResult> {
    const { positiveVotes, negativeVotes, voteCounts } = summarizeVotes(input.assessments);
    const label = majorityDecisionLabel(input.assessments);
    const stance = label >= 1 ? 'supports' : 'contradicts';

    // Compute vote margin for confidence
    const sortedCounts = [...voteCounts.values()].sort((a, b) => b - a);
    const topCount = sortedCounts[0] ?? 0;
    const secondCount = sortedCounts[1] ?? 0;
    const margin = topCount - secondCount;
    const strength = margin >= 2 ? 'strong' : 'moderate';

    // Build vote summary string
    const voteEntries = [...voteCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([l, c]) => `${c} voted ${l}`)
      .join(', ');
    const claim = `Plurality vote selects label ${label}: ${voteEntries}.`;

    const assessment: AgentAssessment = {
      agentId: 'arbiter_agent',
      role: 'arbiter',
      roundNumber: input.rounds.length + 1,
      recommendedLabel: label,
      summary: `Plurality-vote arbiter selects ${label} from the final agent predictions.`,
      hypothesesTouched: input.hypotheses
        .filter((hypothesis) => hypothesis.parentId === undefined)
        .map((hypothesis) => hypothesis.id),
      plannerActions: [] satisfies PlannerAction[],
      evidenceItems: [
        {
          id: `arbiter-decision-${input.sample.sampleIndex}`,
          source: 'arbiter_agent',
          toolName: 'plurality_vote',
          entityScope: Object.values(input.sample.entityDict).flatMap(
            (value) => (Array.isArray(value) ? value : [value]),
          ),
          claim,
          stance,
          strength,
          structured: {
            positiveVotes,
            negativeVotes,
            finalPredictions: input.assessments.map((assessment) => ({
              role: assessment.role,
              recommendedLabel: assessment.recommendedLabel,
              summary: assessment.summary,
            })),
          },
        },
      ],
      evaluationTrace: [],
    };

    return {
      assessment,
      decision: {
        status: voteToStatus(label),
        decisionMode: 'settled',
        label,
        confidence:
          strength === 'strong' ? 0.8 : strength === 'moderate' ? 0.68 : 0.56,
        rationale: claim,
        blockingGaps:
          input.rounds
            .at(-1)
            ?.disagreements.map((disagreement) => disagreement.question) ?? [],
        contradictions: input.assessments.flatMap((assessment) =>
          assessment.evidenceItems
            .filter((item) => item.stance === 'contradicts')
            .map((item) => item.claim),
        ),
      },
    };
  }
}
