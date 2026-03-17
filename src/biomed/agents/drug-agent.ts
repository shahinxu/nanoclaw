import {
  AgentAssessment,
  AgentEvaluationTrace,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceItem,
  ExpertJudge,
  HypothesisRecord,
  PlannerAction,
  ResearchReviewContext,
  ResearchToolAdapter,
} from '../types.js';

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

function detectDrugProteinSignal(
  textSummary: string,
  proteinId: string | undefined,
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

  if (matchedKeyword) {
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Researcher output contains a mechanism-relevant cue (${matchedKeyword}) that may align with protein ${proteinId}.`,
    };
  }

  return {
    stance: 'insufficient',
    strength: 'weak',
    claim: `Researcher output does not provide direct mechanism or target evidence linking the queried drug to protein ${proteinId}.`,
  };
}

export class DrugAgent {
  readonly agentId = 'drug_agent';

  constructor(
    private readonly toolAdapter: ResearchToolAdapter,
    private readonly expertJudge: ExpertJudge | null,
  ) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drugIds = getDrugIds(sample);
    const proteinId = getPrimaryProteinId(sample);
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
        targetDrugId: drugId,
        targetProteinId: proteinId,
      };

      plannerActions.push({
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement:
          hypotheses[0]?.statement ??
          'The queried drug-protein-disease relationship exists.',
        verificationGoal:
          roundContext && roundContext.focus.length > 0
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
          'If no direct drug-protein evidence is found, positive conclusions must remain low-confidence or insufficient.',
        toolCalls: [
          {
            tool: 'drug_researcher',
            arguments: {
              drugbank_id: drugId,
              review_context: reviewContext,
            },
          },
        ],
      });

      const result = await this.toolAdapter.callTool('drug_researcher', {
        drugbank_id: drugId,
        review_context: reviewContext,
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
          ? detectDrugProteinSignal(result.textSummary, proteinId)
          : {
              stance: 'contradicts' as const,
              strength: 'weak' as const,
              claim: `Drug researcher execution failed, so drug-side direct evidence remains unavailable for ${drugId}.`,
            };

      let mechanismSignal = heuristicSignal;
      let judgeSignal = null;
      let judgeError: string | undefined;
      let finalSource: 'judge' | 'heuristic' = 'heuristic';

      if (result.status === 'ok' && this.expertJudge) {
        try {
          judgeSignal = await this.expertJudge.judge({
            agentRole: 'drug',
            sample,
            hypothesis: hypotheses[0],
            roundContext,
            toolName: 'drug_researcher',
            toolArguments: {
              drugbank_id: drugId,
              review_context: reviewContext,
            },
            toolResult: result,
          });
          mechanismSignal = judgeSignal;
          finalSource = 'judge';
        } catch (error) {
          judgeError = error instanceof Error ? error.message : String(error);
          // Fall back to local heuristic screen if the LLM judge is unavailable.
        }
      }

      evaluationTrace.push({
        id: `drug-trace-${sample.sampleIndex}-${drugId}`,
        toolName: 'drug_researcher',
        toolArguments: {
          drugbank_id: drugId,
          review_context: reviewContext,
        },
        entityScope: proteinId ? [drugId, proteinId] : [drugId],
        rawToolOutput: result,
        judgeOutput: judgeSignal,
        judgeError,
        heuristicOutput: heuristicSignal,
        finalOutput: mechanismSignal,
        finalSource,
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
        ? `Drug-side researcher found ${supportCount} mechanism-aligned signal(s). Drug evidence is now grounded in researcher output rather than local heuristics.`
        : 'Drug-side researcher did not provide direct mechanism support for the queried drug-protein pair. This should be treated as a blocking evidence gap for positive decisions.';

    return {
      agentId: this.agentId,
      role: 'drug',
      roundNumber: roundContext?.roundNumber ?? 1,
      summary,
      hypothesesTouched: hypotheses.map((hypothesis) => hypothesis.id),
      plannerActions,
      evidenceItems,
      evaluationTrace,
    };
  }
}
