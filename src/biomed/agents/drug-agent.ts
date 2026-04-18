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

export class DrugAgent {
  readonly agentId = 'drug_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drugIds = getEntityIds(sample, 'drug', 'drugs');
    const proteinId = getPrimaryEntity(sample, 'protein');
    const diseaseId = getPrimaryEntity(sample, 'disease');
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
        'Autonomous drug-side researcher: investigate the queried hyperedge freely using available tools.',
      expectedEvidence: [
        'drug mechanism, indication, or relevant biomedical evidence',
        'peer findings and shared evidence board',
      ],
      failureRule:
        'End with a binary 1/0 recommendation and concise rationale.',
      toolCalls: [],
    };
    plannerActions.push(plannerAction);

    // Determine which tools the drug agent can use
    const availableTools = ['drug_researcher'];

    const result = await this.toolAdapter.callTool('autonomous_researcher', {
      role: 'drug',
      available_tools: availableTools,
      entity_context: {
        relationshipType: sample.relationshipType,
        drugIds,
        proteinId,
        diseaseId,
        sideeffectId,
        celllineId,
      },
      shared_node_context: sharedNodeText,
      review_context: reviewContext,
    });

    if (result.status !== 'ok') {
      throw new Error(
        `autonomous_researcher (drug) failed for sample ${sample.sampleIndex}: ${result.error ?? 'unknown error'}`,
      );
    }

    const reasoned = parseStructuredReasonerOutput(result.structured);
    const recommendedLabel = reasoned?.recommendedLabel ?? parseLabelFromRaw(result.structured?.recommended_label);
    const stance = reasoned?.stance ?? labelToStance(recommendedLabel);
    const strength = reasoned?.strength ?? 'moderate';
    const claim = reasoned?.claim ?? `Drug-side expert votes ${recommendedLabel}.`;

    evaluationTrace.push({
      id: `drug-autonomous-trace-${sample.sampleIndex}`,
      toolName: 'autonomous_researcher',
      toolArguments: {
        role: 'drug',
        roundNumber: roundContext?.roundNumber ?? 1,
        availableTools,
      },
      entityScope: drugIds,
      rawToolOutput: result,
      interpretedOutput: reasoned ?? { stance, strength, claim },
    });

    evidenceItems.push({
      id: `drug-autonomous-${sample.sampleIndex}`,
      source: this.agentId,
      toolName: 'autonomous_researcher',
      entityScope: drugIds,
      claim,
      stance,
      strength,
      structured: {
        drugIds,
        proteinId,
        diseaseId,
        reasonerStructured: result.structured,
      },
    });

    const summary = `Drug-side expert votes ${recommendedLabel} for the current hypothesis in this round.`;

    return {
      agentId: this.agentId,
      role: 'drug',
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
