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
} {
  const positiveVotes = assessments.filter(
    (assessment) => assessment.recommendedLabel === 1,
  ).length;
  const negativeVotes = assessments.filter(
    (assessment) => assessment.recommendedLabel === 0,
  ).length;
  return {
    positiveVotes,
    negativeVotes,
    abstentions: Math.max(0, assessments.length - positiveVotes - negativeVotes),
  };
}

function voteToStatus(label: BiomedLabel): DecisionRecord['status'] {
  return label === 1 ? 'supported' : 'refuted';
}

function majorityDecisionLabel(assessments: AgentAssessment[]): BiomedLabel {
  const { positiveVotes, negativeVotes } = summarizeVotes(assessments);
  return positiveVotes > negativeVotes ? 1 : 0;
}

export class Arbiter {
  async decide(input: ArbiterInput): Promise<ArbiterResult> {
    const { positiveVotes, negativeVotes } = summarizeVotes(input.assessments);
    const label = majorityDecisionLabel(input.assessments);
    const stance = label === 1 ? 'supports' : 'contradicts';
    const strength =
      Math.abs(positiveVotes - negativeVotes) >= 2 ? 'strong' : 'moderate';
    const claim =
      label === 1
        ? `Majority vote supports the triplet: ${positiveVotes} agents voted 1 and ${negativeVotes} agents voted 0.`
        : `Majority vote refutes the triplet: ${negativeVotes} agents voted 0 and ${positiveVotes} agents voted 1.`;

    const assessment: AgentAssessment = {
      agentId: 'arbiter_agent',
      role: 'arbiter',
      roundNumber: input.rounds.length + 1,
      recommendedLabel: label,
      summary: `Majority-vote arbiter selects ${label} from the final agent predictions.`,
      hypothesesTouched: input.hypotheses
        .filter((hypothesis) => hypothesis.parentId === undefined)
        .map((hypothesis) => hypothesis.id),
      plannerActions: [] satisfies PlannerAction[],
      evidenceItems: [
        {
          id: `arbiter-decision-${input.sample.sampleIndex}`,
          source: 'arbiter_agent',
          toolName: 'majority_vote',
          entityScope: Object.values(input.sample.entityDict).flatMap((value) =>
            Array.isArray(value) ? value : [value],
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
        blockingGaps: input.rounds.at(-1)?.disagreements.map(
          (disagreement) => disagreement.question,
        ) ?? [],
        contradictions: input.assessments.flatMap((assessment) =>
          assessment.evidenceItems
            .filter((item) => item.stance === 'contradicts')
            .map((item) => item.claim),
        ),
      },
    };
  }
}
