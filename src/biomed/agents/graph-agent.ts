import {
  AgentAssessment,
  AgentEvaluationTrace,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceItem,
  HypothesisRecord,
  PlannerAction,
} from '../types.js';
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
    const plannerActions: PlannerAction[] = [
      {
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement:
          hypotheses[0]?.statement ??
          'The queried drug-protein-disease relationship exists.',
        verificationGoal:
          roundContext && roundContext.focus.length > 0
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
            },
          },
        ],
      },
    ];

    const result = this.localGraphTool.inspectSample(sample);
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
      };
    } | null;
    const neighborhood = structured?.positiveNeighborhood;
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

    const finalOutput =
      sharedProteinDiseaseCount >= 5 ||
      sharedDrugProteinCount >= 8 ||
      sharedDrugDiseaseCount >= 8 ||
      (threeWayClosure && proteinDiseaseBackbone) ||
      (proteinDiseaseBackbone && (drugProteinBackbone || drugDiseaseBackbone))
        ? {
            stance: 'supports' as const,
            strength: 'strong' as const,
            claim:
              'The local graph shows a high-density structural backbone around the queried triplet, which constitutes strong graph evidence even after excluding the queried hyperedge itself.',
          }
        : threeWayClosure ||
            (pairSupportCount >= 2 && supportScore >= 6) ||
            sharedProteinDiseaseCount >= 3 ||
            sharedDrugProteinCount >= 4 ||
            sharedDrugDiseaseCount >= 4
          ? {
              stance: 'supports' as const,
              strength: 'moderate' as const,
              claim:
                'The local graph shows either multi-pair coverage or a medium-density structural backbone around the queried triplet, which provides moderate graph support.',
            }
          : pairSupportCount >= 1 && supportScore >= 2
            ? {
                stance: 'supports' as const,
                strength: 'weak' as const,
                claim:
                  'The local graph shows limited pair-level neighborhood support around the queried triplet, which provides weak but non-trivial graph evidence.',
              }
            : {
                stance: 'insufficient' as const,
                strength: 'weak' as const,
                claim:
                  'The local graph does not show a pair-level positive neighborhood around the queried triplet after excluding the hyperedge itself, so graph evidence remains insufficient.',
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
          graphStrengthFeatures: {
            pairSupportCount,
            supportScore,
            threeWayClosure,
            proteinDiseaseBackbone,
            drugProteinBackbone,
            drugDiseaseBackbone,
          },
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
      hypothesesTouched: hypotheses.map((hypothesis) => hypothesis.id),
      plannerActions,
      evidenceItems,
      evaluationTrace,
    };
  }
}
