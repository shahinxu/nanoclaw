import {
  AgentAssessment,
  AgentEvaluationTrace,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceItem,
  HypothesisRecord,
  PlannerAction,
  ResearchReviewContext,
  ResearchToolAdapter,
} from '../types.js';
import {
  binaryRecommendationFromEvidence,
  parseStructuredReasonerOutput,
} from '../assessment-utils.js';
import { getEntityIds, getPrimaryEntity } from '../entity-utils.js';
import {
  formatSharedNodeBundle,
  getSharedNodeEntry,
} from '../shared-node-context.js';

export class CelllineAgent {
  readonly agentId = 'cellline_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drugIds = getEntityIds(sample, 'drug', 'drugs');
    const celllineId = getPrimaryEntity(sample, 'cellline');
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    if (celllineId) {
      const sharedNodeContext = roundContext?.sharedNodeContext;
      const localNodeEntry = sharedNodeContext
        ? getSharedNodeEntry(sharedNodeContext, 'cellline', celllineId)
        : undefined;

      const baseReviewContext: ResearchReviewContext = {
        roundNumber: roundContext?.roundNumber ?? 1,
        focusMode:
          roundContext && roundContext.roundNumber > 1
            ? 'target_alignment'
            : 'broad',
        focalQuestion:
          roundContext?.roundObjective.sharedDebateQuestion ??
          roundContext?.focus[0],
        focus: roundContext?.focus ?? [],
        peerFindings: roundContext?.peerAssessmentSummaries ?? [],
        peerEvidence: roundContext?.peerEvidenceDigest ?? [],
        positiveEvidence: roundContext?.positiveEvidenceDigest ?? [],
        negativeEvidence: roundContext?.negativeEvidenceDigest ?? [],
        alternativeMechanismSignals:
          roundContext?.alternativeMechanismSignals ?? [],
        sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
        roundObjective: roundContext?.roundObjective,
        hypothesisFocus: roundContext?.hypothesisFocus ?? [],
        activeHypothesisIds: roundContext?.activeHypothesisIds ?? [],
        targetDrugId: drugIds[0],
        targetCelllineId: celllineId,
        sharedNodeContext,
      };
      const reviewContext: ResearchReviewContext = {
        ...baseReviewContext,
        localNodeSummary: localNodeEntry?.summary,
        localNodeStructured: localNodeEntry?.structured,
        localEvidencePriority: 'primary',
      };

      const plannerAction: PlannerAction = {
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement:
          roundContext?.hypothesisFocus[0] ??
          hypotheses[0]?.statement ??
          'The queried relationship exists.',
        verificationGoal:
          roundContext && roundContext.focus.length > 0
            ? `Round ${roundContext.roundNumber} cell-line review for ${celllineId}: first read the shared node input for the full hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then form or update a provisional 0/1 prediction for the entire hyperedge. Speak as a first-person cell-line expert and address ${roundContext.focus.join(' | ')}.`
            : `First read the shared node input for cell-line ${celllineId} and queried drugs (${drugIds.join(', ') || 'unknown'}), then form a provisional 0/1 prediction for the full hyperedge in first person.`,
        expectedEvidence: [
          'shared node descriptions for queried drugs and cell-line as primary grounding',
          'a provisional whole-hyperedge 0/1 judgment before external retrieval',
          'known cell-line response plausibility',
          'peer findings and prior positive/negative evidence',
        ],
        failureRule:
          'After reviewing the available evidence and using your biological judgment, end this round with a binary 1/0 recommendation and a concise rationale.',
        toolCalls: [
          {
            tool: 'biomedical_expert_reasoner',
            arguments: {
              role: 'cellline',
              review_context: reviewContext,
            },
          },
        ],
      };
      plannerActions.push(plannerAction);

      const localSummary = localNodeEntry?.summary ?? '';
      const reasonerResult = await this.toolAdapter.callTool(
        'biomedical_expert_reasoner',
        {
          role: 'cellline',
          review_context: reviewContext,
          entity_context: {
            relationshipType: sample.relationshipType,
            drugIds,
            celllineId,
            localNodeContext: localNodeEntry?.structured,
            sharedNodeContext,
          },
          evidence_summary: [
            localSummary,
            `Queried drugs: ${drugIds.join(', ') || 'unknown'}.`,
          ]
            .filter((value) => value.trim() !== '')
            .join(' '),
          evidence_structured: {
            primary_local_node: localNodeEntry?.structured,
            node_context: localNodeEntry?.structured,
            shared_node_context: sharedNodeContext,
          },
        },
      );
      if (reasonerResult.status !== 'ok') {
        throw new Error(
          `biomedical_expert_reasoner failed for sample ${sample.sampleIndex}, cellline ${celllineId}: ${reasonerResult.error ?? 'unknown error'}`,
        );
      }

      const reasonedOutput = parseStructuredReasonerOutput(
        reasonerResult.structured,
      );
      if (!reasonedOutput) {
        throw new Error(
          `biomedical_expert_reasoner returned invalid structured output for sample ${sample.sampleIndex}, cellline ${celllineId}`,
        );
      }

      evaluationTrace.push({
        id: `cellline-reasoner-trace-${sample.sampleIndex}-${celllineId}`,
        toolName: 'biomedical_expert_reasoner',
        toolArguments: {
          role: 'cellline',
          roundNumber: roundContext?.roundNumber ?? 1,
          objective: roundContext?.roundObjective,
          sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
        },
        entityScope: [celllineId, ...drugIds].slice(0, 4),
        rawToolOutput: reasonerResult,
        interpretedOutput: reasonedOutput,
      });

      evidenceItems.push({
        id: `cellline-assessment-${sample.sampleIndex}-${celllineId}`,
        source: this.agentId,
        toolName: 'biomedical_expert_reasoner',
        entityScope: [celllineId, ...drugIds].slice(0, 4),
        claim: reasonedOutput.claim,
        stance: reasonedOutput.stance,
        strength: reasonedOutput.strength,
        structured: {
          celllineId,
          drugIds,
          nodeContextStatus: localNodeEntry ? 'provided' : 'missing',
          reasonerStructured: reasonerResult.structured,
        },
      });
    }

    const reasonerVotes = evidenceItems
      .map((item) => item.structured.reasonerStructured)
      .filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === 'object',
      )
      .map((structured) => structured.recommended_label)
      .filter((value): value is 0 | 1 => value === 0 || value === 1);

    const recommendedLabel =
      reasonerVotes.length > 0
        ? reasonerVotes.filter((value) => value === 1).length >
          reasonerVotes.filter((value) => value === 0).length
          ? 1
          : 0
        : binaryRecommendationFromEvidence(evidenceItems);

    const summary =
      recommendedLabel === 1
        ? 'Cell-line expert votes 1 for the current hypothesis in this round.'
        : 'Cell-line expert votes 0 for the current hypothesis in this round.';

    return {
      agentId: this.agentId,
      role: 'cellline',
      roundNumber: roundContext?.roundNumber ?? 1,
      recommendedLabel,
      summary,
      hypothesesTouched: roundContext?.activeHypothesisIds.length
        ? roundContext.activeHypothesisIds
        : hypotheses.map((hypothesis) => hypothesis.id),
      plannerActions,
      evidenceItems,
      evaluationTrace,
    };
  }
}
