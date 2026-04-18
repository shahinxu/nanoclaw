import {
  AgentAssessment,
  AgentEvaluationTrace,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceItem,
  HypothesisRecord,
  PlannerAction,
  ResearchToolAdapter,
} from '../types.js';
import { parseStructuredReasonerOutput, parseLabelFromRaw, labelToStance } from '../assessment-utils.js';
import { getEntityIds, getPrimaryEntity } from '../entity-utils.js';
import { formatSharedNodeBundle } from '../shared-node-context.js';

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
    const proteinId = getPrimaryEntity(sample, 'protein');
    const diseaseId = getPrimaryEntity(sample, 'disease');
    const sideeffectId = getPrimaryEntity(sample, 'sideeffect');
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    const sharedNodeContext = roundContext?.sharedNodeContext;
    const sharedNodeText = sharedNodeContext
      ? formatSharedNodeBundle(sharedNodeContext)
      : '';

    const reviewContext: Record<string, unknown> = {};
    if (roundContext) {
      reviewContext.roundNumber = roundContext.roundNumber;
      reviewContext.focus = roundContext.focus;
      reviewContext.peerFindings = roundContext.peerAssessmentSummaries;
      reviewContext.peerEvidence = roundContext.peerEvidenceDigest;
      reviewContext.positiveEvidence = roundContext.positiveEvidenceDigest;
      reviewContext.negativeEvidence = roundContext.negativeEvidenceDigest;
      if (roundContext.roundObjective) {
        reviewContext.roundObjective = roundContext.roundObjective;
      }
      if (roundContext.sharedEvidenceBoard) {
        reviewContext.sharedEvidenceBoard = roundContext.sharedEvidenceBoard;
      }
      if (roundContext.hypothesisFocus.length > 0) {
        reviewContext.hypothesisFocus = roundContext.hypothesisFocus;
      }
    }

    const plannerAction: PlannerAction = {
      hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
      hypothesisStatement:
        roundContext?.hypothesisFocus[0] ??
        hypotheses[0]?.statement ??
        'The queried relationship exists.',
      verificationGoal:
        'Autonomous cell-line researcher: investigate the queried hyperedge freely using biological knowledge.',
      expectedEvidence: [
        'cell-line response plausibility',
        'peer findings and shared evidence board',
      ],
      failureRule:
        'End with a binary 1/0 recommendation and concise rationale.',
      toolCalls: [],
    };
    plannerActions.push(plannerAction);

    // Cell-line agent has no external researcher tools — relies on knowledge
    const availableTools: string[] = [];

    const result = await this.toolAdapter.callTool('autonomous_researcher', {
      role: 'cellline',
      available_tools: availableTools,
      entity_context: {
        relationshipType: sample.relationshipType,
        drugIds,
        celllineId,
        proteinId,
        diseaseId,
        sideeffectId,
      },
      shared_node_context: sharedNodeText,
      review_context: reviewContext,
    });

    if (result.status !== 'ok') {
      throw new Error(
        `autonomous_researcher (cellline) failed for sample ${sample.sampleIndex}: ${result.error ?? 'unknown error'}`,
      );
    }

    const reasoned = parseStructuredReasonerOutput(result.structured);
    const recommendedLabel = reasoned?.recommendedLabel ?? parseLabelFromRaw(result.structured?.recommended_label);
    const stance = reasoned?.stance ?? labelToStance(recommendedLabel);
    const strength = reasoned?.strength ?? 'moderate';
    const claim = reasoned?.claim ?? `Cell-line expert votes ${recommendedLabel}.`;

    evaluationTrace.push({
      id: `cellline-autonomous-trace-${sample.sampleIndex}`,
      toolName: 'autonomous_researcher',
      toolArguments: {
        role: 'cellline',
        roundNumber: roundContext?.roundNumber ?? 1,
        availableTools,
      },
      entityScope: celllineId ? [celllineId, ...drugIds].slice(0, 4) : drugIds,
      rawToolOutput: result,
      interpretedOutput: reasoned ?? { stance, strength, claim },
    });

    evidenceItems.push({
      id: `cellline-autonomous-${sample.sampleIndex}`,
      source: this.agentId,
      toolName: 'autonomous_researcher',
      entityScope: celllineId ? [celllineId, ...drugIds].slice(0, 4) : drugIds,
      claim,
      stance,
      strength,
      structured: {
        celllineId,
        drugIds,
        reasonerStructured: result.structured,
      },
    });

    const summary = `Cell-line expert votes ${recommendedLabel} for the current hypothesis in this round.`;

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
