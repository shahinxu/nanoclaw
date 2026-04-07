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
import {
  getInformativeToolStructured,
  getInformativeToolSummary,
  isInformativeToolResult,
} from '../tool-result-utils.js';

function mergeResearchOutputs(
  primaryResult: {
    toolName: string;
    status: 'ok' | 'error';
    textSummary: string;
    structured: Record<string, unknown> | null;
  },
  nodeResult: {
    toolName: string;
    status: 'ok' | 'error';
    textSummary: string;
    structured: Record<string, unknown> | null;
  },
): { textSummary: string; structured: Record<string, unknown> } {
  const primarySummary = getInformativeToolSummary(primaryResult);
  const nodeSummary = getInformativeToolSummary(nodeResult);
  const primaryStructured = getInformativeToolStructured(primaryResult);
  const nodeStructured = getInformativeToolStructured(nodeResult);
  return {
    textSummary: [nodeSummary, primarySummary]
      .filter((value) => value.trim() !== '')
      .join(' '),
    structured: {
      local_node_context: nodeStructured,
      ...(primaryStructured ?? {}),
      node_context: nodeStructured,
    },
  };
}

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
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    if (sideeffectId) {
      const sharedNodeContext = roundContext?.sharedNodeContext;
      const localNodeEntry = sharedNodeContext
        ? getSharedNodeEntry(sharedNodeContext, 'sideeffect', sideeffectId)
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
        targetDrugIds: drugIds,
        targetSideeffectId: sideeffectId,
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
        verificationGoal: `Review the complete shared hyperedge context${roundContext?.sharedNodeContext ? ` (${formatSharedNodeBundle(roundContext.sharedNodeContext)})` : ''}. Form a 0/1 judgment for the entire hyperedge. Speak as the side-effect expert. ${roundContext?.roundObjective.sharedDebateQuestion ? `Address this directly: ${roundContext.roundObjective.sharedDebateQuestion}. ` : ''}${roundContext && roundContext.roundNumber > 1 ? 'Explicitly support or challenge peer assessments by role. ' : ''}Use external research only if needed to resolve the most critical side-effect fact for this hyperedge.`,
        expectedEvidence: [
          'complete shared node descriptions for all entities',
          'a whole-hyperedge 0/1 judgment before external retrieval',
          'side-effect plausibility and adverse event evidence',
          'peer findings and shared evidence board',
        ],
        failureRule:
          'After reviewing all evidence and applying your expert judgment, end with a binary 1/0 recommendation and concise rationale.',
        toolCalls: [
          {
            tool: 'sideeffect_researcher',
            arguments: {
              cui: sideeffectId,
              drug_ids: drugIds,
              review_context: reviewContext,
            },
          },
        ],
      };
      plannerActions.push(plannerAction);

      const researcherResult = await this.toolAdapter.callTool(
        'sideeffect_researcher',
        {
          cui: sideeffectId,
          drug_ids: drugIds,
          review_context: reviewContext,
        },
      );
      if (researcherResult.status !== 'ok') {
        throw new Error(
          `sideeffect_researcher failed for sample ${sample.sampleIndex}, sideeffect ${sideeffectId}: ${researcherResult.error ?? 'unknown error'}`,
        );
      }
      const localNodeResult = {
        toolName: 'shared_node_context',
        status: 'ok' as const,
        textSummary: localNodeEntry?.summary ?? '',
        structured: localNodeEntry?.structured ?? null,
      };
      const drugNodeSummaries = (sharedNodeContext?.drug ?? [])
        .map((entry) => entry.summary)
        .filter((s): s is string => Boolean(s) && s.trim() !== '');
      const drugNodeText = drugNodeSummaries.join(' ');
      const basemerged = mergeResearchOutputs(researcherResult, localNodeResult);
      const mergedResult = {
        ...basemerged,
        textSummary: [drugNodeText, basemerged.textSummary]
          .filter((s) => s.trim() !== '')
          .join(' '),
      };

      const reasonerResult = await this.toolAdapter.callTool(
        'biomedical_expert_reasoner',
        {
          role: 'sideeffect',
          review_context: reviewContext,
          entity_context: {
            relationshipType: sample.relationshipType,
            drugIds,
            sideeffectId,
            localNodeContext: localNodeEntry?.structured,
            sharedNodeContext,
          },
          evidence_summary: mergedResult.textSummary,
          evidence_structured: {
            primary_local_node: localNodeEntry?.structured,
            researcher: researcherResult.structured,
            node_context: localNodeEntry?.structured,
            shared_node_context: sharedNodeContext,
          },
        },
      );
      if (reasonerResult.status !== 'ok') {
        throw new Error(
          `biomedical_expert_reasoner failed for sample ${sample.sampleIndex}, sideeffect ${sideeffectId}: ${reasonerResult.error ?? 'unknown error'}`,
        );
      }

      const reasonedOutput = parseStructuredReasonerOutput(
        reasonerResult.structured,
      );
      if (!reasonedOutput) {
        throw new Error(
          `biomedical_expert_reasoner returned invalid structured output for sample ${sample.sampleIndex}, sideeffect ${sideeffectId}`,
        );
      }

      // Record the researcher tool call as a raw evidence item.
      if (isInformativeToolResult(researcherResult)) {
        evidenceItems.push({
          id: `sideeffect-researcher-${sample.sampleIndex}-${sideeffectId}`,
          source: this.agentId,
          toolName: researcherResult.toolName,
          entityScope: [sideeffectId, ...drugIds].slice(0, 4),
          claim:
            researcherResult.textSummary ||
            `Sideeffect researcher returned no summary for ${sideeffectId}.`,
          stance: 'contradicts',
          strength: 'moderate',
          structured: {
            sideeffectId,
            drugIds,
            result: researcherResult.structured,
            status: researcherResult.status,
          },
        });
      }

      evaluationTrace.push({
        id: `sideeffect-reasoner-trace-${sample.sampleIndex}-${sideeffectId}`,
        toolName: 'biomedical_expert_reasoner',
        toolArguments: {
          role: 'sideeffect',
          roundNumber: roundContext?.roundNumber ?? 1,
          objective: roundContext?.roundObjective,
          sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
        },
        entityScope: [sideeffectId, ...drugIds].slice(0, 4),
        rawToolOutput: reasonerResult,
        interpretedOutput: reasonedOutput,
      });

      evidenceItems.push({
        id: `sideeffect-assessment-${sample.sampleIndex}-${sideeffectId}`,
        source: this.agentId,
        toolName: 'biomedical_expert_reasoner',
        entityScope: [sideeffectId, ...drugIds].slice(0, 4),
        claim: reasonedOutput.claim,
        stance: reasonedOutput.stance,
        strength: reasonedOutput.strength,
        structured: {
          sideeffectId,
          drugIds,
          researcherStatus: researcherResult.status,
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
        ? 'Side-effect expert votes 1 for the current hypothesis in this round.'
        : 'Side-effect expert votes 0 for the current hypothesis in this round.';

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
