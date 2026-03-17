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

function diseaseKeywords(diseaseId: string | undefined): string[] {
  if (!diseaseId) {
    return [];
  }

  const normalized = diseaseId.trim().toUpperCase();
  const keywordMap: Array<[RegExp, string[]]> = [
    [/^MONDO:0005044$/, ['hypertension', 'hypertensive', 'blood pressure', 'arterial blood pressure']],
    [/^MONDO:0005045$/, ['cardiac', 'heart', 'hypertrophic cardiomyopathy', 'myocard']],
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
): { stance: EvidenceItem['stance']; strength: EvidenceItem['strength']; claim: string } {
  if (!diseaseId) {
    return {
      stance: 'insufficient',
      strength: 'weak',
      claim: 'No disease was provided, so protein-disease relevance could not be checked.',
    };
  }

  const searchable = normalizeText(textSummary);
  const keywords = diseaseKeywords(diseaseId);
  const matchedKeyword = keywords.find((keyword) => searchable.includes(normalizeText(keyword)));

  if (matchedKeyword) {
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Protein researcher output contains disease-relevant cue (${matchedKeyword}) consistent with disease ${diseaseId}. This supports protein-disease relevance only, not drug involvement.`,
    };
  }

  return {
    stance: 'insufficient',
    strength: 'weak',
    claim: `Protein researcher output does not provide direct disease-aligned evidence for ${diseaseId}. General biological plausibility should remain weak evidence.`,
  };
}

export class ProteinAgent {
  readonly agentId = 'protein_agent';

  constructor(
    private readonly toolAdapter: ResearchToolAdapter,
    private readonly expertJudge: ExpertJudge | null,
  ) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
  ): Promise<AgentAssessment> {
    const proteinIds = getProteinIds(sample);
    const diseaseId = getPrimaryDiseaseId(sample);
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    for (const proteinId of proteinIds) {
      plannerActions.push({
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement:
          hypotheses[0]?.statement ??
          'The queried drug-protein-disease relationship exists.',
        verificationGoal: diseaseId
          ? `Check whether protein ${proteinId} has disease-relevant evidence for ${diseaseId}, while keeping drug involvement separate.`
          : `Check whether protein ${proteinId} has disease-relevant evidence for the current sample.`,
        expectedEvidence: [
          'protein function summary',
          'disease-relevant pathway or phenotype signal',
          'explicit note that protein relevance does not imply drug-protein support',
        ],
        failureRule:
          'If only general protein-disease plausibility is found, do not upgrade the full drug-protein-disease hypothesis to strong support.',
        toolCalls: [
          {
            tool: 'protein_researcher',
            arguments: { gene_symbol: proteinId },
          },
        ],
      });

      const result = await this.toolAdapter.callTool('protein_researcher', {
        gene_symbol: proteinId,
      });

      evidenceItems.push({
        id: `protein-researcher-${sample.sampleIndex}-${proteinId}`,
        source: this.agentId,
        toolName: result.toolName,
        entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
        claim:
          result.status === 'ok'
            ? result.textSummary || `Protein researcher returned no summary for ${proteinId}.`
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
          ? detectProteinDiseaseSignal(result.textSummary, diseaseId)
          : {
              stance: 'contradicts' as const,
              strength: 'weak' as const,
              claim: `Protein researcher execution failed, so protein-side verification remains unavailable for ${proteinId}.`,
            };

      let diseaseSignal = heuristicSignal;
      let judgeSignal = null;
      let judgeError: string | undefined;
      let finalSource: 'judge' | 'heuristic' = 'heuristic';

      if (result.status === 'ok' && this.expertJudge) {
        try {
          judgeSignal = await this.expertJudge.judge({
            agentRole: 'protein',
            sample,
            hypothesis: hypotheses[0],
            toolName: 'protein_researcher',
            toolArguments: { gene_symbol: proteinId },
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
        id: `protein-trace-${sample.sampleIndex}-${proteinId}`,
        toolName: 'protein_researcher',
        toolArguments: { gene_symbol: proteinId },
        entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
        rawToolOutput: result,
        judgeOutput: judgeSignal,
        judgeError,
        heuristicOutput: heuristicSignal,
        finalOutput: diseaseSignal,
        finalSource,
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
        ? `Protein-side researcher found ${supportCount} disease-aligned signal(s). These support protein-disease relevance only and must not be treated as proof of drug involvement.`
        : 'Protein-side researcher did not provide strong disease-aligned support beyond general plausibility. Protein context should remain weak support until more evidence is available.';

    return {
      agentId: this.agentId,
      role: 'protein',
      summary,
      hypothesesTouched: hypotheses.map((hypothesis) => hypothesis.id),
      plannerActions,
      evidenceItems,
      evaluationTrace,
    };
  }
}