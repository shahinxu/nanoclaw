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
import { executePlannerAction } from '../plan-executor.js';

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getPrimaryDiseaseId(sample: BiomedTaskSample): string | undefined {
  const disease = sample.entityDict.disease;

  if (typeof disease === 'string') {
    return disease.trim() || undefined;
  }
  if (Array.isArray(disease)) {
    return disease.find((value) => value.trim() !== '')?.trim();
  }

  return undefined;
}

function getPrimaryProteinId(sample: BiomedTaskSample): string | undefined {
  const protein = sample.entityDict.protein;

  if (typeof protein === 'string') {
    return protein.trim() || undefined;
  }
  if (Array.isArray(protein)) {
    return protein.find((value) => value.trim() !== '')?.trim();
  }

  return undefined;
}

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
): {
  stance: EvidenceItem['stance'];
  strength: EvidenceItem['strength'];
  claim: string;
} {
  if (!proteinId) {
    return {
      stance: 'insufficient',
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
  const matchedTreatmentTargets = Array.isArray(taskRelevance?.matched_treatment_targets)
    ? taskRelevance?.matched_treatment_targets.filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const proteinKeywordHits = Array.isArray(taskRelevance?.protein_keyword_hits)
    ? taskRelevance?.protein_keyword_hits.filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
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
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Disease researcher found protein-aligned disease context for ${proteinId} (${proteinKeywordHits.slice(0, 3).join(', ')}), but not an explicit associated-target match.`,
    };
  }

  if (matchedKeyword) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Disease researcher output contains context (${matchedKeyword}) that is consistent with protein ${proteinId}. This supports disease-protein compatibility only, not drug mechanism validity.`,
    };
  }

  if (associatedTargets.length >= 3) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Disease researcher returned a non-trivial associated-target set for ${proteinId}, so disease-side target context is weakly supportive even without an explicit queried-protein match.`,
    };
  }

  if (standardTreatments.length > 0) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Disease researcher returned standard-treatment evidence for the queried disease, which is weak but usable disease-side support even when protein alignment is indirect.`,
    };
  }

  return {
    stance: 'insufficient',
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

export class DiseaseAgent {
  readonly agentId = 'disease_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const diseaseId = getPrimaryDiseaseId(sample);
    const proteinId = getPrimaryProteinId(sample);
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    if (diseaseId) {
      const reviewContext: ResearchReviewContext = {
        roundNumber: roundContext?.roundNumber ?? 1,
        focusMode:
          roundContext && roundContext.roundNumber > 1
            ? 'target_alignment'
            : 'broad',
        focalQuestion: roundContext?.focus[0],
        focus: roundContext?.focus ?? [],
        peerFindings: roundContext?.peerAssessmentSummaries ?? [],
        hypothesisFocus: roundContext?.hypothesisFocus ?? [],
        activeHypothesisIds: roundContext?.activeHypothesisIds ?? [],
        targetProteinId: proteinId,
        targetDiseaseId: diseaseId,
      };

      const plannerAction: PlannerAction = {
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement: primaryHypothesisStatement(hypotheses, roundContext),
        verificationGoal: proteinId
          ? roundContext && roundContext.hypothesisFocus.length > 0
            ? `Round ${roundContext.roundNumber} hypothesis-driven re-check for disease ${diseaseId}: ${roundContext.hypothesisFocus.join(' | ')}`
            : roundContext && roundContext.focus.length > 0
              ? `Round ${roundContext.roundNumber} targeted re-check for disease ${diseaseId}: ${roundContext.focus.join(' | ')}`
            : `Check whether disease ${diseaseId} provides context consistent with protein ${proteinId}, while keeping drug mechanism separate.`
          : `Check disease ${diseaseId} background and treatment context for the current sample.`,
        expectedEvidence: [
          'disease definition',
          'known targets or treatment context',
          'explicit note that disease context does not prove drug-protein linkage',
        ],
        failureRule:
          roundContext && roundContext.hypothesisFocus.length > 0
            ? 'If the active hypothesis depends on disease-target alignment and disease-side evidence does not support it, revise the active hypothesis instead of reusing the same disease explanation.'
            : 'If only disease background is available, do not upgrade the full triplet hypothesis to strong support.',
        toolCalls: [
          {
            tool: 'disease_researcher',
            arguments: {
              mondo_id: diseaseId,
              review_context: reviewContext,
            },
          },
        ],
      };
      plannerActions.push(plannerAction);

      const [result] = await executePlannerAction(plannerAction, {
        researchToolAdapter: this.toolAdapter,
      });

      evidenceItems.push({
        id: `disease-researcher-${sample.sampleIndex}-${diseaseId}`,
        source: this.agentId,
        toolName: result.toolName,
        entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
        claim:
          result.status === 'ok'
            ? result.textSummary ||
              `Disease researcher returned no summary for ${diseaseId}.`
            : `Disease researcher failed for ${diseaseId}: ${result.error ?? 'unknown error'}`,
        stance: result.status === 'ok' ? 'insufficient' : 'contradicts',
        strength: result.status === 'ok' ? 'moderate' : 'weak',
        structured: {
          diseaseId,
          proteinId,
          result: result.structured,
          status: result.status,
        },
      });

      const heuristicSignal =
        result.status === 'ok'
          ? detectDiseaseProteinSignal(
              result.textSummary,
              proteinId,
              result.structured,
            )
          : {
              stance: 'contradicts' as const,
              strength: 'weak' as const,
              claim: `Disease researcher execution failed, so disease-side verification remains unavailable for ${diseaseId}.`,
            };

      const diseaseSignal = heuristicSignal;

      evaluationTrace.push({
        id: `disease-trace-${sample.sampleIndex}-${diseaseId}`,
        toolName: 'disease_researcher',
        toolArguments: {
          mondo_id: diseaseId,
          review_context: reviewContext,
        },
        entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
        rawToolOutput: result,
        judgeOutput: null,
        heuristicOutput: heuristicSignal,
        finalOutput: diseaseSignal,
        finalSource: 'heuristic',
      });

      evidenceItems.push({
        id: `disease-protein-${sample.sampleIndex}-${diseaseId}`,
        source: this.agentId,
        toolName: 'disease_researcher_screen',
        entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
        claim: diseaseSignal.claim,
        stance: diseaseSignal.stance,
        strength: diseaseSignal.strength,
        structured: {
          diseaseId,
          proteinId,
          researcherStatus: result.status,
        },
      });
    }

    const supportCount = evidenceItems.filter(
      (item) => item.stance === 'supports',
    ).length;
    const summary =
      supportCount > 0
        ? `Disease-side researcher found ${supportCount} disease-side target signal(s), prioritizing explicit associated targets and treatment-target overlap.`
        : 'Disease-side researcher did not provide usable target-shaped disease evidence beyond broad background context.';

    return {
      agentId: this.agentId,
      role: 'disease',
      roundNumber: roundContext?.roundNumber ?? 1,
      summary,
      hypothesesTouched:
        roundContext?.activeHypothesisIds.length
          ? roundContext.activeHypothesisIds
          : hypotheses.map((hypothesis) => hypothesis.id),
      plannerActions,
      evidenceItems,
      evaluationTrace,
    };
  }
}
