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

export class DiseaseAgent {
  readonly agentId = 'disease_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const diseaseId = getPrimaryEntity(sample, 'disease');
    const proteinId = getPrimaryEntity(sample, 'protein');
    const drugIds = getEntityIds(sample, 'drug', 'drugs');
    const sideeffectId = getPrimaryEntity(sample, 'sideeffect');
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
        'Autonomous disease-side researcher: investigate the queried hyperedge freely using available tools.',
      expectedEvidence: [
        'disease definition, associated targets, known drugs',
        'peer findings and shared evidence board',
      ],
      failureRule:
        'End with a binary 1/0 recommendation and concise rationale.',
      toolCalls: [],
    };
    plannerActions.push(plannerAction);

    const availableTools = ['disease_researcher'];

    const result = await this.toolAdapter.callTool('autonomous_researcher', {
      role: 'disease',
      available_tools: availableTools,
      entity_context: {
        relationshipType: sample.relationshipType,
        diseaseId,
        proteinId,
        drugIds,
        sideeffectId,
        celllineId,
      },
      shared_node_context: sharedNodeText,
      review_context: reviewContext,
    });

    if (result.status !== 'ok') {
      throw new Error(
        `autonomous_researcher (disease) failed for sample ${sample.sampleIndex}: ${result.error ?? 'unknown error'}`,
      );
    }

    const reasoned = parseStructuredReasonerOutput(result.structured);
    const recommendedLabel = reasoned?.recommendedLabel ?? parseLabelFromRaw(result.structured?.recommended_label);
    const stance = reasoned?.stance ?? labelToStance(recommendedLabel);
    const strength = reasoned?.strength ?? 'moderate';
    const claim = reasoned?.claim ?? `Disease-side expert votes ${recommendedLabel}.`;

    evaluationTrace.push({
      id: `disease-autonomous-trace-${sample.sampleIndex}`,
      toolName: 'autonomous_researcher',
      toolArguments: {
        role: 'disease',
        roundNumber: roundContext?.roundNumber ?? 1,
        availableTools,
      },
      entityScope: diseaseId ? [diseaseId] : [],
      rawToolOutput: result,
      interpretedOutput: reasoned ?? { stance, strength, claim },
    });

    evidenceItems.push({
      id: `disease-autonomous-${sample.sampleIndex}`,
      source: this.agentId,
      toolName: 'autonomous_researcher',
      entityScope: diseaseId ? [diseaseId] : [],
      claim,
      stance,
      strength,
      structured: {
        diseaseId,
        proteinId,
        drugIds,
        reasonerStructured: result.structured,
      },
    });

    const summary = `Disease-side expert votes ${recommendedLabel} for the current hypothesis in this round.`;

    return {
      agentId: this.agentId,
      role: 'disease',
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
