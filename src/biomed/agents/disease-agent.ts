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
  hasAlternativeMechanismPressure,
  normalizeText,
  parseStructuredReasonerOutput,
} from '../assessment-utils.js';
import { getPrimaryEntity } from '../entity-utils.js';
import {
  getInformativeToolStructured,
  getInformativeToolSummary,
  isInformativeToolResult,
} from '../tool-result-utils.js';

function proteinKeywords(proteinId: string | undefined): string[] {
  if (!proteinId) {
    return [];
  }

  const normalized = proteinId.trim().toUpperCase();
  const keywordMap: Array<[RegExp, string[]]> = [
    [
      /^CACN/,
      ['blood pressure', 'heart', 'cardiac', 'hypertensive', 'arterial'],
    ],
    [
      /^ADRB/,
      ['blood pressure', 'cardiac', 'heart', 'hypertensive', 'adrenergic'],
    ],
    [/^AGTR/, ['blood pressure', 'hypertensive', 'arterial', 'cardiovascular']],
    [/^MTOR$/, ['growth', 'metabolic', 'proliferation']],
    [/^DHFR$/, ['folate', 'cell proliferation', 'malignan']],
  ];

  for (const [pattern, keywords] of keywordMap) {
    if (pattern.test(normalized)) {
      return keywords;
    }
  }

  return [];
}

function detectDiseaseProteinSignal(
  textSummary: string,
  proteinId: string | undefined,
  structured: Record<string, unknown> | null,
  roundContext?: AgentRoundContext,
): {
  stance: EvidenceItem['stance'];
  strength: EvidenceItem['strength'];
  claim: string;
} {
  if (!proteinId) {
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim:
        'No protein context was available, so disease-protein consistency could not be checked.',
    };
  }

  const searchable = normalizeText(textSummary);
  const keywords = proteinKeywords(proteinId);
  const matchedKeyword = keywords.find((keyword) =>
    searchable.includes(normalizeText(keyword)),
  );
  const targetedReview =
    structured && typeof structured.targeted_review === 'object'
      ? (structured.targeted_review as Record<string, unknown>)
      : null;
  const taskRelevance =
    structured && typeof structured.task_relevance === 'object'
      ? (structured.task_relevance as Record<string, unknown>)
      : null;
  const matchedAssociatedTargets = Array.isArray(
    targetedReview?.matched_associated_targets,
  )
    ? targetedReview?.matched_associated_targets
    : [];
  const matchedTreatmentTargets = Array.isArray(
    taskRelevance?.matched_treatment_targets,
  )
    ? taskRelevance?.matched_treatment_targets.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const proteinKeywordHits = Array.isArray(taskRelevance?.protein_keyword_hits)
    ? taskRelevance?.protein_keyword_hits.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const associatedTargets = Array.isArray(structured?.associated_targets)
    ? structured.associated_targets.filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null,
      )
    : [];
  const standardTreatments = Array.isArray(structured?.standard_treatments)
    ? structured.standard_treatments.filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null,
      )
    : [];
  const alternativePressure = hasAlternativeMechanismPressure(roundContext);

  if (matchedAssociatedTargets.length > 0) {
    return {
      stance: 'supports',
      strength: 'strong',
      claim: `Disease researcher explicitly lists protein ${proteinId} among disease-associated targets, which is direct disease-side support for the queried target context.`,
    };
  }

  if (matchedTreatmentTargets.length > 0) {
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Disease researcher found treatment signals in which queried protein ${proteinId} appears as a treatment target (${matchedTreatmentTargets.slice(0, 3).join(', ')}).`,
    };
  }

  if (proteinKeywordHits.length > 0) {
    if (alternativePressure) {
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Disease researcher found only protein-aligned disease context for ${proteinId}, while peer evidence points to a different target or mechanism. This counts against the current disease-target hypothesis.`,
      };
    }
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Disease researcher found protein-aligned disease context for ${proteinId} (${proteinKeywordHits.slice(0, 3).join(', ')}), but without an explicit associated-target or treatment-target match this should remain insufficient.`,
    };
  }

  if (matchedKeyword) {
    if (alternativePressure) {
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Disease researcher found only contextual overlap (${matchedKeyword}) for ${proteinId}, while peer evidence favors another mechanism. This weakens the current disease-side story.`,
      };
    }
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Disease researcher output contains context (${matchedKeyword}) that is consistent with protein ${proteinId}, but this alone should remain insufficient for disease-target alignment.`,
    };
  }

  if (associatedTargets.length >= 3) {
    if (alternativePressure) {
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Disease researcher returned a broad associated-target set, but peer evidence points to a different mechanism and the queried protein ${proteinId} is not explicitly recovered. This is negative evidence for the current disease-target hypothesis.`,
      };
    }
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Disease researcher returned a non-trivial associated-target set, but without an explicit queried-protein match this should remain insufficient for ${proteinId}.`,
    };
  }

  if (standardTreatments.length > 0) {
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Disease researcher returned standard-treatment evidence for the queried disease, but treatment background without explicit protein alignment should remain insufficient.`,
    };
  }

  return {
    stance: 'contradicts',
    strength: 'weak',
    claim: `Disease researcher output does not provide strong protein-aligned context for ${proteinId}. Disease background alone should remain weak support.`,
  };
}

function primaryHypothesisStatement(
  hypotheses: HypothesisRecord[],
  roundContext?: AgentRoundContext,
): string {
  if (roundContext?.hypothesisFocus.length) {
    return roundContext.hypothesisFocus[0];
  }
  return (
    hypotheses[0]?.statement ??
    'The queried drug-protein-disease relationship exists.'
  );
}

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
): {
  textSummary: string;
  structured: Record<string, unknown>;
} {
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

function localNodeEvidenceSignal(nodeResult: {
  status: string;
  structured: Record<string, unknown> | null;
}): Pick<EvidenceItem, 'stance' | 'strength'> {
  const nodeFound = nodeResult.structured?.node_found === true;
  if (nodeResult.status === 'ok' && nodeFound) {
    return { stance: 'supports', strength: 'weak' };
  }
  return { stance: 'contradicts', strength: 'weak' };
}

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
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    if (diseaseId) {
      const baseReviewContext: ResearchReviewContext = {
        roundNumber: roundContext?.roundNumber ?? 1,
        focusMode:
          roundContext && roundContext.roundNumber > 1
            ? 'target_alignment'
            : 'broad',
        focalQuestion: roundContext?.focus[0],
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
        targetProteinId: proteinId,
        targetDiseaseId: diseaseId,
      };

      const nodeArguments = {
        entity_type: 'disease',
        entity_id: diseaseId,
      };
      const nodeResult = await this.toolAdapter.callTool(
        'node_context',
        nodeArguments,
      );
      const reviewContext: ResearchReviewContext = {
        ...baseReviewContext,
        localNodeSummary: nodeResult.textSummary,
        localNodeStructured: nodeResult.structured ?? undefined,
        localEvidencePriority: 'primary',
      };
      const researcherArguments = {
        mondo_id: diseaseId,
        review_context: reviewContext,
      };

      const plannerAction: PlannerAction = {
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement: primaryHypothesisStatement(
          hypotheses,
          roundContext,
        ),
        verificationGoal: proteinId
          ? roundContext && roundContext.hypothesisFocus.length > 0
            ? `Round ${roundContext.roundNumber} disease-side review for ${diseaseId}: first ground the entity using local node context, then test ${roundContext.hypothesisFocus.join(' | ')}. Shared objective: ${roundContext.roundObjective.title}. Decide whether your current vote is 1 or 0.`
            : roundContext && roundContext.focus.length > 0
              ? `Round ${roundContext.roundNumber} targeted disease-side review for ${diseaseId}: first ground the entity using local node context, then test ${roundContext.focus.join(' | ')}. Shared objective: ${roundContext.roundObjective.title}. Decide whether your current vote is 1 or 0.`
              : `First read the local node context for disease ${diseaseId}, then check whether it provides context consistent with protein ${proteinId}, while keeping drug mechanism separate.`
          : `First read the local node context for disease ${diseaseId}, then check its background and treatment context for the current sample.`,
        expectedEvidence: [
          'local node definition as the primary grounding source',
          'disease definition',
          'known targets or treatment context',
          'disease-target or disease-mechanism information',
          'peer findings and prior positive/negative evidence',
        ],
        failureRule:
          'After reviewing the available evidence and using your biological judgment, end this round with a binary 1/0 recommendation and a concise rationale.',
        toolCalls: [
          {
            tool: 'node_context',
            arguments: nodeArguments,
          },
          {
            tool: 'disease_researcher',
            arguments: researcherArguments,
          },
        ],
      };
      plannerActions.push(plannerAction);

      const result = await this.toolAdapter.callTool(
        'disease_researcher',
        researcherArguments,
      );
      const mergedResult = mergeResearchOutputs(result, nodeResult);
      const reasonerResult = await this.toolAdapter.callTool(
        'biomedical_expert_reasoner',
        {
          role: 'disease',
          review_context: reviewContext,
          entity_context: {
            relationshipType: sample.relationshipType,
            diseaseId,
            proteinId,
            localNodeContext: nodeResult.structured,
          },
          evidence_summary: mergedResult.textSummary,
          evidence_structured: {
            primary_local_node: nodeResult.structured,
            researcher: result.structured,
            node_context: nodeResult.structured,
            fallback_heuristic: detectDiseaseProteinSignal(
              mergedResult.textSummary,
              proteinId,
              mergedResult.structured,
              roundContext,
            ),
          },
        },
      );
      const reasonedOutput = parseStructuredReasonerOutput(
        reasonerResult.structured,
      );

      if (isInformativeToolResult(result)) {
        evidenceItems.push({
          id: `disease-researcher-${sample.sampleIndex}-${diseaseId}`,
          source: this.agentId,
          toolName: result.toolName,
          entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
          claim:
            result.textSummary ||
            `Disease researcher returned no summary for ${diseaseId}.`,
          stance: 'contradicts',
          strength: 'moderate',
          structured: {
            diseaseId,
            proteinId,
            result: result.structured,
            status: result.status,
          },
        });
      }

      if (isInformativeToolResult(nodeResult)) {
        evidenceItems.push({
          id: `disease-node-context-${sample.sampleIndex}-${diseaseId}`,
          source: this.agentId,
          toolName: nodeResult.toolName,
          entityScope: [diseaseId],
          claim:
            nodeResult.textSummary ||
            `Local node context returned no summary for ${diseaseId}.`,
          ...localNodeEvidenceSignal(nodeResult),
          structured: {
            diseaseId,
            result: nodeResult.structured,
            status: nodeResult.status,
          },
        });
      }

      const heuristicSignal = isInformativeToolResult(result)
        ? detectDiseaseProteinSignal(
            mergedResult.textSummary,
            proteinId,
            mergedResult.structured,
            roundContext,
          )
        : null;

      const diseaseSignal = heuristicSignal;
      const finalOutput = reasonedOutput ?? diseaseSignal;

      if (isInformativeToolResult(result) && diseaseSignal) {
        evaluationTrace.push({
          id: `disease-trace-${sample.sampleIndex}-${diseaseId}`,
          toolName: 'disease_researcher',
          toolArguments: {
            mondo_id: diseaseId,
            review_context: reviewContext,
          },
          entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
          rawToolOutput: result,
          interpretedOutput: diseaseSignal,
        });
      }

      if (isInformativeToolResult(nodeResult) && diseaseSignal) {
        evaluationTrace.push({
          id: `disease-node-trace-${sample.sampleIndex}-${diseaseId}`,
          toolName: 'node_context',
          toolArguments: {
            entity_type: 'disease',
            entity_id: diseaseId,
          },
          entityScope: [diseaseId],
          rawToolOutput: nodeResult,
          interpretedOutput: diseaseSignal,
        });
      }

      if (reasonedOutput && finalOutput) {
        evaluationTrace.push({
          id: `disease-reasoner-trace-${sample.sampleIndex}-${diseaseId}`,
          toolName: 'biomedical_expert_reasoner',
          toolArguments: {
            role: 'disease',
            roundNumber: roundContext?.roundNumber ?? 1,
            objective: roundContext?.roundObjective,
            sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
          },
          entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
          rawToolOutput: reasonerResult,
          interpretedOutput: finalOutput,
        });
      }

      if (finalOutput) {
        evidenceItems.push({
          id: `disease-target-${sample.sampleIndex}-${diseaseId}`,
          source: this.agentId,
          toolName: reasonedOutput
            ? 'biomedical_expert_reasoner'
            : 'disease_researcher_screen',
          entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
          claim: finalOutput.claim,
          stance: finalOutput.stance,
          strength: finalOutput.strength,
          structured: {
            diseaseId,
            proteinId,
            researcherStatus: result.status,
            nodeContextStatus: nodeResult.status,
            reasonerStructured: reasonerResult.structured,
          },
        });
      }
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
        ? 'Disease-side expert votes 1 for the current hypothesis in this round.'
        : 'Disease-side expert votes 0 for the current hypothesis in this round.';

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
