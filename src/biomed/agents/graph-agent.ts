import {
  AgentAssessment,
  AgentEvaluationTrace,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceItem,
  HypothesisRecord,
  PlannerAction,
} from '../types.js';
import { executePlannerAction } from '../plan-executor.js';
import { LocalGraphTool } from '../tools/local-graph-tool.js';

function primaryEntity(
  sample: BiomedTaskSample,
  key: 'drug' | 'protein' | 'disease',
): string | undefined {
  const value = sample.entityDict[key];
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    return value.find((item) => item.trim() !== '')?.trim();
  }
  return undefined;
}

export class GraphAgent {
  readonly agentId = 'graph_agent';

  constructor(private readonly localGraphTool: LocalGraphTool) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drug = primaryEntity(sample, 'drug');
    const protein = primaryEntity(sample, 'protein');
    const disease = primaryEntity(sample, 'disease');
    const plannerAction: PlannerAction = {
      hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
      hypothesisStatement:
        roundContext?.hypothesisFocus[0] ??
        hypotheses[0]?.statement ??
        'The queried drug-protein-disease relationship exists.',
      verificationGoal:
        roundContext && roundContext.hypothesisFocus.length > 0
          ? `Use neighboring hyperedges to test the active hypotheses: ${roundContext.hypothesisFocus.join(' | ')}`
          : roundContext && roundContext.focus.length > 0
            ? `Use neighboring hyperedges to probe unresolved graph structure: ${roundContext.focus.join(' | ')}`
            : 'Use neighboring positive hyperedges to test whether the triplet sits inside a supportive local graph neighborhood.',
      expectedEvidence: [
        'shared drug-protein neighborhood',
        'shared drug-disease neighborhood',
        'shared protein-disease neighborhood',
      ],
      failureRule:
        'Exclude the queried hyperedge itself and avoid treating missing neighbors as direct contradiction.',
      toolCalls: [
        {
          tool: 'local_graph_tool',
          arguments: {
            drug,
            protein,
            disease,
            roundNumber: roundContext?.roundNumber ?? 1,
            focus: roundContext?.focus ?? [],
            hypothesisFocus: roundContext?.hypothesisFocus ?? [],
            maxCandidates: 8,
          },
        },
      ],
    };
    const plannerActions: PlannerAction[] = [plannerAction];

    const [result] = await executePlannerAction(plannerAction, {
      localGraphTool: this.localGraphTool,
      sample,
    });
    const structured = result.structured as {
      positiveNeighborhood?: {
        sharedDrugProteinCount?: number;
        sharedDrugDiseaseCount?: number;
        sharedProteinDiseaseCount?: number;
        pairCoverageCount?: number;
        supportScore?: number;
        threeWayClosure?: boolean;
        proteinDiseaseBackbone?: boolean;
        drugProteinBackbone?: boolean;
        drugDiseaseBackbone?: boolean;
        localSupportTier?: 'strong' | 'moderate' | 'weak' | 'insufficient';
        retrievalTier?: 'strong' | 'moderate' | 'weak' | 'insufficient';
        supportTier?: 'strong' | 'moderate' | 'weak' | 'insufficient';
        biologicalNarratives?: string[];
      };
      informativeHyperedgeRetrieval?: {
        retrievalTier?: 'strong' | 'moderate' | 'weak' | 'insufficient';
        topCandidates?: Array<{
          relationship?: string;
          order?: number;
          entities?: string[];
          matchedQueryEntities?: string[];
          introducedEntities?: string[];
          anchorOverlapCount?: number;
          pairOverlapCount?: number;
          bridgeToTargetCount?: number;
          relationPriority?: number;
          score?: number;
          rationale?: string;
        }>;
        relationshipHistogram?: Record<string, number>;
        narratives?: string[];
      };
      biologicalInterpretation?: {
        supportTier?: 'strong' | 'moderate' | 'weak' | 'insufficient';
        narratives?: string[];
      };
    } | null;
    const neighborhood = structured?.positiveNeighborhood;
    const informativeHyperedgeRetrieval =
      structured?.informativeHyperedgeRetrieval;
    const biologicalInterpretation = structured?.biologicalInterpretation;
    const pairSupportCount = neighborhood?.pairCoverageCount ?? 0;
    const supportScore = neighborhood?.supportScore ?? 0;
    const threeWayClosure = neighborhood?.threeWayClosure ?? false;
    const proteinDiseaseBackbone =
      neighborhood?.proteinDiseaseBackbone ?? false;
    const drugProteinBackbone = neighborhood?.drugProteinBackbone ?? false;
    const drugDiseaseBackbone = neighborhood?.drugDiseaseBackbone ?? false;
    const sharedDrugProteinCount = neighborhood?.sharedDrugProteinCount ?? 0;
    const sharedDrugDiseaseCount = neighborhood?.sharedDrugDiseaseCount ?? 0;
    const sharedProteinDiseaseCount =
      neighborhood?.sharedProteinDiseaseCount ?? 0;
    const supportTier =
      biologicalInterpretation?.supportTier ??
      neighborhood?.supportTier ??
      'insufficient';
    const biologicalNarratives = biologicalInterpretation?.narratives ?? [];
    const topHyperedges = informativeHyperedgeRetrieval?.topCandidates ?? [];

    const narrativeText = biologicalNarratives.join(' ');
    const finalOutput =
      supportTier === 'strong'
        ? {
            stance: 'supports' as const,
            strength: 'strong' as const,
            claim:
              narrativeText ||
              'The local graph places the queried triplet inside a dense biologically coherent positive neighborhood.',
          }
        : supportTier === 'moderate'
          ? {
              stance: 'supports' as const,
              strength: 'moderate' as const,
              claim:
                narrativeText ||
                'The local graph provides moderate neighborhood evidence for the queried triplet.',
            }
          : supportTier === 'weak'
            ? {
                stance: 'supports' as const,
                strength: 'weak' as const,
                claim:
                  narrativeText ||
                  'The local graph provides weak but non-zero neighborhood evidence for the queried triplet.',
              }
            : {
                stance: 'insufficient' as const,
                strength: 'weak' as const,
                claim:
                  narrativeText ||
                  'The local graph does not recover a biologically coherent neighborhood around the queried triplet after excluding the queried hyperedge.',
              };

    const entityScope = [drug, protein, disease].filter(
      (value): value is string => Boolean(value),
    );

    const evaluationTrace: AgentEvaluationTrace[] = [
      {
        id: `graph-trace-${sample.sampleIndex}`,
        toolName: 'local_graph_tool',
        toolArguments: {
          drug,
          protein,
          disease,
          roundNumber: roundContext?.roundNumber ?? 1,
        },
        entityScope,
        rawToolOutput: result,
        judgeOutput: null,
        heuristicOutput: finalOutput,
        finalOutput,
        finalSource: 'heuristic',
      },
    ];

    const evidenceItems: EvidenceItem[] = [
      {
        id: `graph-neighborhood-${sample.sampleIndex}`,
        source: this.agentId,
        toolName: 'local_graph_tool',
        entityScope,
        claim: finalOutput.claim,
        stance: finalOutput.stance,
        strength: finalOutput.strength,
        structured: {
          graphSummary: result.textSummary,
          graphNeighborhood: neighborhood,
          informativeHyperedgeRetrieval,
          graphStrengthFeatures: {
            pairSupportCount,
            supportScore,
            threeWayClosure,
            proteinDiseaseBackbone,
            drugProteinBackbone,
            drugDiseaseBackbone,
            localSupportTier: neighborhood?.localSupportTier,
            retrievalTier: neighborhood?.retrievalTier,
            supportTier,
          },
          topHyperedges,
          biologicalNarratives,
        },
      },
    ];

    const summary =
      finalOutput.stance === 'supports'
        ? 'Graph-side neighborhood search found local positive hyperedge structure that supports the queried triplet without using the queried hyperedge itself.'
        : 'Graph-side neighborhood search did not find enough pair-level positive structure around the queried triplet, so graph evidence remains insufficient.';

    return {
      agentId: this.agentId,
      role: 'graph',
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
