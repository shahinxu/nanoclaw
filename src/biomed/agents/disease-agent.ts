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
import {
  formatSharedNodeBundle,
  getSharedNodeEntry,
} from '../shared-node-context.js';

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

function isOpenTargetsFailure(errorMessage: string | undefined): boolean {
  const normalized = (errorMessage ?? '').toLowerCase();
  const isOpenTargetsRelated =
    normalized.includes('open targets') || normalized.includes('opentargets');
  if (!isOpenTargetsRelated) {
    return false;
  }
  return (
    normalized.includes('http 400') ||
    normalized.includes('http 429') ||
    normalized.includes('http 500') ||
    normalized.includes('http 502') ||
    normalized.includes('http 503') ||
    normalized.includes('http 504') ||
    normalized.includes('read_timeout') ||
    normalized.includes('connect_timeout') ||
    normalized.includes('connection_error') ||
    normalized.includes('timeout')
  );
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
      const sharedNodeContext = roundContext?.sharedNodeContext;
      const localNodeEntry = sharedNodeContext
        ? getSharedNodeEntry(sharedNodeContext, 'disease', diseaseId)
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
        targetProteinId: proteinId,
        targetDiseaseId: diseaseId,
        sharedNodeContext,
      };
      const reviewContext: ResearchReviewContext = {
        ...baseReviewContext,
        localNodeSummary: localNodeEntry?.summary,
        localNodeStructured: localNodeEntry?.structured,
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
            ? `Round ${roundContext.roundNumber} disease-side review for ${diseaseId}: first read the shared node input for the whole hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then form or update a provisional 0/1 prediction for the entire drug-protein-disease hyperedge. Speak as a first-person expert. ${roundContext.roundObjective.sharedDebateQuestion ? `Address this shared dispute directly: ${roundContext.roundObjective.sharedDebateQuestion}. ` : ''}If this is not the first round, explicitly support or challenge another expert by role before ending with a binary vote. Use external evidence only to test the most important unresolved disease-side fact for ${roundContext.hypothesisFocus.join(' | ')}.`
            : roundContext && roundContext.focus.length > 0
              ? `Round ${roundContext.roundNumber} targeted disease-side review for ${diseaseId}: first read the shared node input for the whole hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then form or update a provisional 0/1 prediction for the entire hyperedge. Speak as a first-person expert. ${roundContext.roundObjective.sharedDebateQuestion ? `Address this shared dispute directly: ${roundContext.roundObjective.sharedDebateQuestion}. ` : ''}If this is not the first round, explicitly support or challenge another expert by role before ending with a binary vote. Use external evidence only if needed to test ${roundContext.focus.join(' | ')}.`
              : `First read the shared node input for disease ${diseaseId}, protein ${proteinId}, and drug ${getPrimaryEntity(sample, 'drug') ?? 'the queried drug'}. Form a provisional 0/1 prediction for the whole hyperedge, speak in first person as the disease-side expert, and use external evidence only to test whether the disease side implicates protein ${proteinId}.`
          : `First read the shared node input for the full hyperedge, form a provisional 0/1 prediction, speak in first person as the disease-side expert, and use external evidence only if needed to test the missing disease-side support.`,
        expectedEvidence: [
          'shared node descriptions for drug, protein, and disease as the primary grounding source',
          'a provisional whole-hyperedge 0/1 judgment before external retrieval',
          'disease definition',
          'known targets or treatment context',
          'disease-target or disease-mechanism information',
          'peer findings and prior positive/negative evidence',
        ],
        failureRule:
          'After reviewing the available evidence and using your biological judgment, end this round with a binary 1/0 recommendation and a concise rationale.',
        toolCalls: [
          {
            tool: 'disease_researcher',
            arguments: researcherArguments,
          },
        ],
      };
      plannerActions.push(plannerAction);

      let result = await this.toolAdapter.callTool(
        'disease_researcher',
        researcherArguments,
      );
      if (result.status !== 'ok') {
        if (isOpenTargetsFailure(result.error)) {
          result = {
            toolName: 'disease_researcher',
            status: 'ok',
            textSummary:
              '[disease_researcher] Open Targets lookup failed in this round; continuing with shared node context and downstream reasoning.',
            structured: {
              mondo_id: diseaseId,
              open_targets_error: result.error,
              skipped_due_to_open_targets_failure_in_round: true,
            },
          };
        } else {
          throw new Error(
            `disease_researcher failed for sample ${sample.sampleIndex}, disease ${diseaseId}: ${result.error ?? 'unknown error'}`,
          );
        }
      }
      const localNodeResult = {
        toolName: 'shared_node_context',
        status: 'ok' as const,
        textSummary: localNodeEntry?.summary ?? '',
        structured: localNodeEntry?.structured ?? null,
      };
      const mergedResult = mergeResearchOutputs(result, localNodeResult);
      const reasonerResult = await this.toolAdapter.callTool(
        'biomedical_expert_reasoner',
        {
          role: 'disease',
          review_context: reviewContext,
          entity_context: {
            relationshipType: sample.relationshipType,
            diseaseId,
            proteinId,
            localNodeContext: localNodeEntry?.structured,
            sharedNodeContext,
          },
          evidence_summary: mergedResult.textSummary,
          evidence_structured: {
            primary_local_node: localNodeEntry?.structured,
            researcher: result.structured,
            node_context: localNodeEntry?.structured,
            shared_node_context: sharedNodeContext,
          },
        },
      );
      if (reasonerResult.status !== 'ok') {
        throw new Error(
          `biomedical_expert_reasoner failed for sample ${sample.sampleIndex}, disease ${diseaseId}: ${reasonerResult.error ?? 'unknown error'}`,
        );
      }
      const reasonedOutput = parseStructuredReasonerOutput(
        reasonerResult.structured,
      );
      if (!reasonedOutput) {
        throw new Error(
          `biomedical_expert_reasoner returned invalid structured output for sample ${sample.sampleIndex}, disease ${diseaseId}`,
        );
      }

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

      {
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
          interpretedOutput: reasonedOutput,
        });
      }

      {
        evidenceItems.push({
          id: `disease-target-${sample.sampleIndex}-${diseaseId}`,
          source: this.agentId,
          toolName: 'biomedical_expert_reasoner',
          entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
          claim: reasonedOutput.claim,
          stance: reasonedOutput.stance,
          strength: reasonedOutput.strength,
          structured: {
            diseaseId,
            proteinId,
            researcherStatus: result.status,
            nodeContextStatus: localNodeEntry ? 'provided' : 'missing',
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
