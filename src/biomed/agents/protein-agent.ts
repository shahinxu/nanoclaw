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

function diseaseKeywords(diseaseId: string | undefined): string[] {
  if (!diseaseId) {
    return [];
  }

  const normalized = diseaseId.trim().toUpperCase();
  const keywordMap: Array<[RegExp, string[]]> = [
    [
      /^MONDO:0005044$/,
      [
        'hypertension',
        'hypertensive',
        'blood pressure',
        'arterial blood pressure',
      ],
    ],
    [
      /^MONDO:0005045$/,
      ['cardiac', 'heart', 'hypertrophic cardiomyopathy', 'myocard'],
    ],
  ];

  for (const [pattern, keywords] of keywordMap) {
    if (pattern.test(normalized)) {
      return keywords;
    }
  }

  return [];
}

function getProteinIds(sample: BiomedTaskSample): string[] {
  const values: string[] = [];
  const singleProtein = sample.entityDict.protein;

  if (typeof singleProtein === 'string') {
    values.push(singleProtein);
  }
  if (Array.isArray(singleProtein)) {
    values.push(...singleProtein);
  }

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function detectProteinDiseaseSignal(
  textSummary: string,
  diseaseId: string | undefined,
  structured: Record<string, unknown> | null,
): {
  stance: EvidenceItem['stance'];
  strength: EvidenceItem['strength'];
  claim: string;
} {
  if (!diseaseId) {
    return {
      stance: 'insufficient',
      strength: 'weak',
      claim:
        'No disease was provided, so protein-disease relevance could not be checked.',
    };
  }

  const searchable = normalizeText(textSummary);
  const keywords = diseaseKeywords(diseaseId);
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
  const diseaseKeywordHits = Array.isArray(targetedReview?.disease_keyword_hits)
    ? targetedReview?.disease_keyword_hits.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const matchedProcesses = Array.isArray(
    taskRelevance?.matched_biological_processes,
  )
    ? taskRelevance?.matched_biological_processes.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const matchedPathways = Array.isArray(
    taskRelevance?.matched_reactome_pathways,
  )
    ? taskRelevance?.matched_reactome_pathways.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const biologicalProcesses = Array.isArray(structured?.biological_processes)
    ? structured.biological_processes.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const reactomePathways = Array.isArray(structured?.reactome_pathways)
    ? structured.reactome_pathways.filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null,
      )
    : [];
  const functionDescription =
    typeof structured?.function_description === 'string'
      ? structured.function_description.trim()
      : '';

  if (diseaseKeywordHits.length >= 2 || matchedPathways.length >= 2) {
    return {
      stance: 'supports',
      strength: 'strong',
      claim: `Protein researcher found repeated disease-aligned biology for ${diseaseId}, including ${[...diseaseKeywordHits, ...matchedPathways].slice(0, 3).join(', ')}.`,
    };
  }

  if (
    diseaseKeywordHits.length > 0 ||
    matchedPathways.length > 0 ||
    matchedProcesses.length > 0
  ) {
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Protein researcher found disease-aligned protein biology for ${diseaseId} via ${[...diseaseKeywordHits, ...matchedProcesses, ...matchedPathways].slice(0, 3).join(', ')}. This still does not by itself prove drug involvement.`,
    };
  }

  if (matchedKeyword) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Protein researcher output contains disease-relevant cue (${matchedKeyword}) consistent with disease ${diseaseId}. This supports protein-disease relevance only, not drug involvement.`,
    };
  }

  if (biologicalProcesses.length > 0 && reactomePathways.length > 0) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Protein researcher returned both biological-process and pathway annotations for ${diseaseId}, which is weak but usable protein-side support even without an explicit disease keyword hit.`,
    };
  }

  if (functionDescription) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Protein researcher returned a concrete function description for the queried protein, so protein-side evidence remains weakly supportive rather than fully insufficient for disease ${diseaseId}.`,
    };
  }

  return {
    stance: 'insufficient',
    strength: 'weak',
    claim: `Protein researcher output does not provide direct disease-aligned evidence for ${diseaseId}. General biological plausibility should remain weak evidence.`,
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

export class ProteinAgent {
  readonly agentId = 'protein_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const proteinIds = getProteinIds(sample);
    const diseaseId = getPrimaryDiseaseId(sample);
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    for (const proteinId of proteinIds) {
      const reviewContext: ResearchReviewContext = {
        roundNumber: roundContext?.roundNumber ?? 1,
        focusMode:
          roundContext && roundContext.roundNumber > 1
            ? 'disease_alignment'
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
        hypothesisStatement: primaryHypothesisStatement(
          hypotheses,
          roundContext,
        ),
        verificationGoal: diseaseId
          ? roundContext && roundContext.hypothesisFocus.length > 0
            ? `Round ${roundContext.roundNumber} hypothesis-driven re-check for protein ${proteinId}: ${roundContext.hypothesisFocus.join(' | ')}`
            : roundContext && roundContext.focus.length > 0
              ? `Round ${roundContext.roundNumber} targeted re-check for protein ${proteinId}: ${roundContext.focus.join(' | ')}`
              : `Check whether protein ${proteinId} has disease-relevant evidence for ${diseaseId}, while keeping drug involvement separate.`
          : `Check whether protein ${proteinId} has disease-relevant evidence for the current sample.`,
        expectedEvidence: [
          'protein function summary',
          'disease-relevant pathway or phenotype signal',
          'explicit note that protein relevance does not imply drug-protein support',
        ],
        failureRule:
          roundContext && roundContext.hypothesisFocus.length > 0
            ? 'If the active hypothesis requires protein-disease alignment and the protein side cannot support it, do not keep the same hypothesis unchanged; downgrade it or favor an alternative pathway hypothesis.'
            : 'If only general protein-disease plausibility is found, do not upgrade the full drug-protein-disease hypothesis to strong support.',
        toolCalls: [
          {
            tool: 'protein_researcher',
            arguments: {
              gene_symbol: proteinId,
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
        id: `protein-researcher-${sample.sampleIndex}-${proteinId}`,
        source: this.agentId,
        toolName: result.toolName,
        entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
        claim:
          result.status === 'ok'
            ? result.textSummary ||
              `Protein researcher returned no summary for ${proteinId}.`
            : `Protein researcher failed for ${proteinId}: ${result.error ?? 'unknown error'}`,
        stance: result.status === 'ok' ? 'insufficient' : 'contradicts',
        strength: result.status === 'ok' ? 'moderate' : 'weak',
        structured: {
          proteinId,
          diseaseId,
          result: result.structured,
          status: result.status,
        },
      });

      const heuristicSignal =
        result.status === 'ok'
          ? detectProteinDiseaseSignal(
              result.textSummary,
              diseaseId,
              result.structured,
            )
          : {
              stance: 'contradicts' as const,
              strength: 'weak' as const,
              claim: `Protein researcher execution failed, so protein-side verification remains unavailable for ${proteinId}.`,
            };

      const diseaseSignal = heuristicSignal;

      evaluationTrace.push({
        id: `protein-trace-${sample.sampleIndex}-${proteinId}`,
        toolName: 'protein_researcher',
        toolArguments: {
          gene_symbol: proteinId,
          review_context: reviewContext,
        },
        entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
        rawToolOutput: result,
        interpretedOutput: diseaseSignal,
      });

      evidenceItems.push({
        id: `protein-disease-${sample.sampleIndex}-${proteinId}`,
        source: this.agentId,
        toolName: 'protein_researcher_screen',
        entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
        claim: diseaseSignal.claim,
        stance: diseaseSignal.stance,
        strength: diseaseSignal.strength,
        structured: {
          proteinId,
          diseaseId,
          researcherStatus: result.status,
        },
      });
    }

    const supportCount = evidenceItems.filter(
      (item) => item.stance === 'supports',
    ).length;
    const summary =
      supportCount > 0
        ? `Protein-side researcher found ${supportCount} disease-aligned protein signal(s), with preference for explicit pathway and process alignment over generic plausibility.`
        : 'Protein-side researcher did not provide usable disease-aligned protein evidence beyond broad plausibility.';

    return {
      agentId: this.agentId,
      role: 'protein',
      roundNumber: roundContext?.roundNumber ?? 1,
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
