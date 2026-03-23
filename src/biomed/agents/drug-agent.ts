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

function proteinKeywords(proteinId: string): string[] {
  const normalized = proteinId.trim().toUpperCase();
  const keywordMap: Array<[RegExp, string[]]> = [
    [
      /^CACN/,
      [
        'calcium channel',
        'voltage gated calcium channel',
        'l type calcium channel',
      ],
    ],
    [
      /^ADRB/,
      ['adrenergic receptor', 'beta adrenergic receptor', 'adrenoceptor'],
    ],
    [
      /^ADRA/,
      ['adrenergic receptor', 'alpha adrenergic receptor', 'adrenoceptor'],
    ],
    [/^AGTR/, ['angiotensin receptor']],
    [/^EGFR$/, ['epidermal growth factor receptor', 'egfr']],
    [/^MTOR$/, ['mtor', 'mechanistic target of rapamycin']],
    [/^DHFR$/, ['dihydrofolate reductase', 'dhfr']],
  ];

  for (const [pattern, keywords] of keywordMap) {
    if (pattern.test(normalized)) {
      return [normalized.toLowerCase(), ...keywords];
    }
  }

  return [normalized.toLowerCase()];
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

function getDrugIds(sample: BiomedTaskSample): string[] {
  const values: string[] = [];
  const singleDrug = sample.entityDict.drug;
  const multiDrug = sample.entityDict.drugs;

  if (typeof singleDrug === 'string') {
    values.push(singleDrug);
  }
  if (Array.isArray(singleDrug)) {
    values.push(...singleDrug);
  }
  if (typeof multiDrug === 'string') {
    values.push(multiDrug);
  }
  if (Array.isArray(multiDrug)) {
    values.push(...multiDrug);
  }

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function detectDrugProteinSignal(
  textSummary: string,
  proteinId: string | undefined,
  diseaseId: string | undefined,
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
        'No protein was provided, so drug-protein mechanism alignment could not be checked.',
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
  const directMechanismMatches = Array.isArray(
    targetedReview?.direct_mechanism_matches,
  )
    ? targetedReview?.direct_mechanism_matches
    : [];
  const proteinKeywordHits = Array.isArray(targetedReview?.protein_keyword_hits)
    ? targetedReview?.protein_keyword_hits.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const diseaseIndicationHits = Array.isArray(
    taskRelevance?.disease_indication_hits,
  )
    ? taskRelevance?.disease_indication_hits.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim() !== '',
      )
    : [];
  const mechanismCount = Array.isArray(structured?.mechanism_of_action)
    ? structured.mechanism_of_action.length
    : 0;

  if (directMechanismMatches.length > 0) {
    if (diseaseIndicationHits.length > 0) {
      return {
        stance: 'supports',
        strength: 'strong',
        claim: `Drug researcher found direct mechanism evidence aligned with protein ${proteinId}, and the drug indications also overlap disease ${diseaseId ?? 'context'} (${diseaseIndicationHits.join(', ')}).`,
      };
    }

    return {
      stance: 'supports',
      strength: 'strong',
      claim: `Drug researcher found direct mechanism evidence aligned with protein ${proteinId}, which is stronger than generic indication-level plausibility.`,
    };
  }

  if (proteinKeywordHits.length > 0 || matchedKeyword) {
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Drug researcher found mechanism-relevant language aligned with protein ${proteinId} (${[...new Set([...proteinKeywordHits, ...(matchedKeyword ? [matchedKeyword] : [])])].slice(0, 3).join(', ')}).`,
    };
  }

  if (mechanismCount > 0 && diseaseIndicationHits.length > 0) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Drug researcher found a concrete mechanism description plus disease-aligned indication context for ${diseaseId ?? 'the queried disease'}, but no explicit protein-level match for ${proteinId}.`,
    };
  }

  const diseaseMatchedKeyword = diseaseKeywords(diseaseId).find((keyword) =>
    searchable.includes(normalizeText(keyword)),
  );
  if (mechanismCount > 0 && diseaseMatchedKeyword) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Drug researcher linked the drug to disease-relevant context (${diseaseMatchedKeyword}) while also providing a mechanism description, which is indirect but non-trivial support.`,
    };
  }

  if (diseaseIndicationHits.length > 0) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Drug researcher found disease-aligned indication context for ${diseaseId ?? 'the queried disease'} (${diseaseIndicationHits.slice(0, 3).join(', ')}), which is weak but usable drug-side support even without an explicit protein match.`,
    };
  }

  if (mechanismCount > 0) {
    return {
      stance: 'supports',
      strength: 'weak',
      claim: `Drug researcher returned a concrete mechanism description for the queried drug, which is weak drug-side support even though the mechanism was not explicitly aligned to protein ${proteinId}.`,
    };
  }

  return {
    stance: 'insufficient',
    strength: 'weak',
    claim: `Researcher output does not provide direct mechanism or target evidence linking the queried drug to protein ${proteinId}.`,
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

export class DrugAgent {
  readonly agentId = 'drug_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drugIds = getDrugIds(sample);
    const proteinId = getPrimaryProteinId(sample);
    const diseaseId = getPrimaryDiseaseId(sample);
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    for (const drugId of drugIds) {
      const reviewContext: ResearchReviewContext = {
        roundNumber: roundContext?.roundNumber ?? 1,
        focusMode:
          roundContext && roundContext.roundNumber > 1
            ? 'mechanism_only'
            : 'broad',
        focalQuestion: roundContext?.focus[0],
        focus: roundContext?.focus ?? [],
        peerFindings: roundContext?.peerAssessmentSummaries ?? [],
        hypothesisFocus: roundContext?.hypothesisFocus ?? [],
        activeHypothesisIds: roundContext?.activeHypothesisIds ?? [],
        targetDrugId: drugId,
        targetProteinId: proteinId,
        targetDiseaseId: diseaseId,
      };

      const plannerAction: PlannerAction = {
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement: primaryHypothesisStatement(
          hypotheses,
          roundContext,
        ),
        verificationGoal:
          roundContext && roundContext.hypothesisFocus.length > 0
            ? `Round ${roundContext.roundNumber} hypothesis-driven re-check for drug ${drugId}: ${roundContext.hypothesisFocus.join(' | ')}`
            : roundContext && roundContext.focus.length > 0
              ? `Round ${roundContext.roundNumber} targeted re-check for drug ${drugId}: ${roundContext.focus.join(' | ')}`
              : proteinId !== undefined
                ? `Check whether drug ${drugId} has direct mechanism or target support involving protein ${proteinId}.`
                : `Check whether drug ${drugId} has drug-side mechanism evidence relevant to the current sample.`,
        expectedEvidence: [
          'direct drug-target evidence',
          'mechanism-of-action description',
          'indication context',
        ],
        failureRule:
          roundContext && roundContext.hypothesisFocus.length > 0
            ? 'If the active hypothesis is not supported by drug-side mechanism evidence, do not keep reusing the same explanation; downgrade it or favor an alternative mechanism hypothesis.'
            : 'If no direct drug-protein evidence is found, positive conclusions must remain low-confidence or insufficient.',
        toolCalls: [
          {
            tool: 'drug_researcher',
            arguments: {
              drugbank_id: drugId,
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
        id: `drug-researcher-${sample.sampleIndex}-${drugId}`,
        source: this.agentId,
        toolName: result.toolName,
        entityScope: proteinId ? [drugId, proteinId] : [drugId],
        claim:
          result.status === 'ok'
            ? result.textSummary ||
              `Drug researcher returned no summary for ${drugId}.`
            : `Drug researcher failed for ${drugId}: ${result.error ?? 'unknown error'}`,
        stance: result.status === 'ok' ? 'insufficient' : 'contradicts',
        strength: result.status === 'ok' ? 'moderate' : 'weak',
        structured: {
          drugbankId: drugId,
          proteinId,
          result: result.structured,
          status: result.status,
        },
      });

      const heuristicSignal =
        result.status === 'ok'
          ? detectDrugProteinSignal(
              result.textSummary,
              proteinId,
              diseaseId,
              result.structured,
            )
          : {
              stance: 'contradicts' as const,
              strength: 'weak' as const,
              claim: `Drug researcher execution failed, so drug-side direct evidence remains unavailable for ${drugId}.`,
            };

      const mechanismSignal = heuristicSignal;

      evaluationTrace.push({
        id: `drug-trace-${sample.sampleIndex}-${drugId}`,
        toolName: 'drug_researcher',
        toolArguments: {
          drugbank_id: drugId,
          review_context: reviewContext,
        },
        entityScope: proteinId ? [drugId, proteinId] : [drugId],
        rawToolOutput: result,
        interpretedOutput: mechanismSignal,
      });

      evidenceItems.push({
        id: `drug-mechanism-${sample.sampleIndex}-${drugId}`,
        source: this.agentId,
        toolName: 'drug_researcher_screen',
        entityScope: proteinId ? [drugId, proteinId] : [drugId],
        claim: mechanismSignal.claim,
        stance: mechanismSignal.stance,
        strength: mechanismSignal.strength,
        structured: {
          drugbankId: drugId,
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
        ? `Drug-side researcher found ${supportCount} task-shaped drug signal(s), prioritizing direct mechanism alignment and then disease-aligned mechanism context.`
        : 'Drug-side researcher did not provide usable mechanism-aligned support for the queried drug-protein pair, so the drug side remains a blocking gap.';

    return {
      agentId: this.agentId,
      role: 'drug',
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
