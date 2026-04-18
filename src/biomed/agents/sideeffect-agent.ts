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

export class SideeffectAgent {
  readonly agentId = 'sideeffect_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drugIds = getEntityIds(sample, 'drug', 'drugs');
    const sideeffectId = getPrimaryEntity(sample, 'sideeffect');
    const proteinId = getPrimaryEntity(sample, 'protein');
    const diseaseId = getPrimaryEntity(sample, 'disease');
    const celllineId = getPrimaryEntity(sample, 'cellline');
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
        'Autonomous side-effect researcher: investigate the queried hyperedge freely using available tools.',
      expectedEvidence: [
        'side-effect plausibility and adverse event evidence',
        'peer findings and shared evidence board',
      ],
      failureRule:
        'End with a binary 1/0 recommendation and concise rationale.',
      toolCalls: [],
    };
    plannerActions.push(plannerAction);

    const availableTools = ['sideeffect_researcher'];

    const result = await this.toolAdapter.callTool('autonomous_researcher', {
      role: 'sideeffect',
      available_tools: availableTools,
      entity_context: {
        relationshipType: sample.relationshipType,
        drugIds,
        sideeffectId,
        proteinId,
        diseaseId,
        celllineId,
      },
      shared_node_context: sharedNodeText,
      review_context: reviewContext,
    });

    if (result.status !== 'ok') {
      throw new Error(
        `autonomous_researcher (sideeffect) failed for sample ${sample.sampleIndex}: ${result.error ?? 'unknown error'}`,
      );
    }

    const reasoned = parseStructuredReasonerOutput(result.structured);
    const recommendedLabel = reasoned?.recommendedLabel ?? parseLabelFromRaw(result.structured?.recommended_label);
    const stance = reasoned?.stance ?? labelToStance(recommendedLabel);
    const strength = reasoned?.strength ?? 'moderate';
    const claim = reasoned?.claim ?? `Side-effect expert votes ${recommendedLabel}.`;

    evaluationTrace.push({
      id: `sideeffect-autonomous-trace-${sample.sampleIndex}`,
      toolName: 'autonomous_researcher',
      toolArguments: {
        role: 'sideeffect',
        roundNumber: roundContext?.roundNumber ?? 1,
        availableTools,
      },
      entityScope: sideeffectId ? [sideeffectId, ...drugIds].slice(0, 4) : drugIds,
      rawToolOutput: result,
      interpretedOutput: reasoned ?? { stance, strength, claim },
    });

    evidenceItems.push({
      id: `sideeffect-autonomous-${sample.sampleIndex}`,
      source: this.agentId,
      toolName: 'autonomous_researcher',
      entityScope: sideeffectId ? [sideeffectId, ...drugIds].slice(0, 4) : drugIds,
      claim,
      stance,
      strength,
      structured: {
        sideeffectId,
        drugIds,
        reasonerStructured: result.structured,
      },
    });

    const summary = `Side-effect expert votes ${recommendedLabel} for the current hypothesis in this round.`;

    return {
      agentId: this.agentId,
      role: 'sideeffect',
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
