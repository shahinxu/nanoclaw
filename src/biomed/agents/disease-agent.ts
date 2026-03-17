import {
  AgentAssessment,
  AgentEvaluationTrace,
  BiomedTaskSample,
  EvidenceItem,
  ExpertJudge,
  HypothesisRecord,
  PlannerAction,
  ResearchToolAdapter,
} from '../types.js';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
    [/^CACN/, ['blood pressure', 'heart', 'cardiac', 'hypertensive', 'arterial']],
    [/^ADRB/, ['blood pressure', 'cardiac', 'heart', 'hypertensive', 'adrenergic']],
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
): { stance: EvidenceItem['stance']; strength: EvidenceItem['strength']; claim: string } {
  if (!proteinId) {
    return {
      stance: 'insufficient',
      strength: 'weak',
      claim: 'No protein context was available, so disease-protein consistency could not be checked.',
    };
  }

  const searchable = normalizeText(textSummary);
  const keywords = proteinKeywords(proteinId);
  const matchedKeyword = keywords.find((keyword) => searchable.includes(normalizeText(keyword)));

  if (matchedKeyword) {
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Disease researcher output contains context (${matchedKeyword}) that is consistent with protein ${proteinId}. This supports disease-protein compatibility only, not drug mechanism validity.`,
    };
  }

  return {
    stance: 'insufficient',
    strength: 'weak',
    claim: `Disease researcher output does not provide strong protein-aligned context for ${proteinId}. Disease background alone should remain weak support.`,
  };
}

export class DiseaseAgent {
  readonly agentId = 'disease_agent';

  constructor(
    private readonly toolAdapter: ResearchToolAdapter,
    private readonly expertJudge: ExpertJudge | null,
  ) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
  ): Promise<AgentAssessment> {
    const diseaseId = getPrimaryDiseaseId(sample);
    const proteinId = getPrimaryProteinId(sample);
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    if (diseaseId) {
      plannerActions.push({
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement:
          hypotheses[0]?.statement ??
          'The queried drug-protein-disease relationship exists.',
        verificationGoal: proteinId
          ? `Check whether disease ${diseaseId} provides context consistent with protein ${proteinId}, while keeping drug mechanism separate.`
          : `Check disease ${diseaseId} background and treatment context for the current sample.`,
        expectedEvidence: [
          'disease definition',
          'known targets or treatment context',
          'explicit note that disease context does not prove drug-protein linkage',
        ],
        failureRule:
          'If only disease background is available, do not upgrade the full triplet hypothesis to strong support.',
        toolCalls: [
          {
            tool: 'disease_researcher',
            arguments: { mondo_id: diseaseId },
          },
        ],
      });

      const result = await this.toolAdapter.callTool('disease_researcher', {
        mondo_id: diseaseId,
      });

      evidenceItems.push({
        id: `disease-researcher-${sample.sampleIndex}-${diseaseId}`,
        source: this.agentId,
        toolName: result.toolName,
        entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
        claim:
          result.status === 'ok'
            ? result.textSummary || `Disease researcher returned no summary for ${diseaseId}.`
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
          ? detectDiseaseProteinSignal(result.textSummary, proteinId)
          : {
              stance: 'contradicts' as const,
              strength: 'weak' as const,
              claim: `Disease researcher execution failed, so disease-side verification remains unavailable for ${diseaseId}.`,
            };

      let diseaseSignal = heuristicSignal;
      let judgeSignal = null;
      let judgeError: string | undefined;
      let finalSource: 'judge' | 'heuristic' = 'heuristic';

      if (result.status === 'ok' && this.expertJudge) {
        try {
          judgeSignal = await this.expertJudge.judge({
            agentRole: 'disease',
            sample,
            hypothesis: hypotheses[0],
            toolName: 'disease_researcher',
            toolArguments: { mondo_id: diseaseId },
            toolResult: result,
          });
          diseaseSignal = judgeSignal;
          finalSource = 'judge';
        } catch (error) {
          judgeError = error instanceof Error ? error.message : String(error);
          // Fall back to local heuristic screen if the LLM judge is unavailable.
        }
      }

      evaluationTrace.push({
        id: `disease-trace-${sample.sampleIndex}-${diseaseId}`,
        toolName: 'disease_researcher',
        toolArguments: { mondo_id: diseaseId },
        entityScope: proteinId ? [diseaseId, proteinId] : [diseaseId],
        rawToolOutput: result,
        judgeOutput: judgeSignal,
        judgeError,
        heuristicOutput: heuristicSignal,
        finalOutput: diseaseSignal,
        finalSource,
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
        ? `Disease-side researcher found ${supportCount} context-aligned signal(s). These support disease background compatibility only and must not be treated as proof of drug-target validity.`
        : 'Disease-side researcher did not provide strong context-aligned support beyond general disease background. Disease context should remain weak support until more evidence is available.';

    return {
      agentId: this.agentId,
      role: 'disease',
      summary,
      hypothesesTouched: hypotheses.map((hypothesis) => hypothesis.id),
      plannerActions,
      evidenceItems,
      evaluationTrace,
    };
  }
}