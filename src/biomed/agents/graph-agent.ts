import {
  AgentAssessment,
  AgentEvaluationTrace,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceItem,
  HypothesisRecord,
  PlannerAction,
} from '../types.js';
import { getEntityIds } from '../entity-utils.js';
import { executePlannerAction } from '../plan-executor.js';
import { formatSharedNodeBundle } from '../shared-node-context.js';
import { LocalGraphTool } from '../tools/local-graph-tool.js';

function hyperedgeLabel(relationshipType: string): string {
  if (relationshipType === 'drug_drug_sideeffect') {
    return 'drug-drug-sideeffect hyperedge';
  }
  if (relationshipType === 'drug_drug_cell-line') {
    return 'drug-drug-cell-line hyperedge';
  }
  if (relationshipType === 'drug_drug_disease') {
    return 'drug-drug-disease hyperedge';
  }
  if (relationshipType === 'drug_protein_disease') {
    return 'drug-protein-disease hyperedge';
  }
  return `${relationshipType} hyperedge`;
}

function decideFromNeighborhood(neighborhoodStats: {
  totalNeighbors: number;
  positiveNeighbors: number;
  negativeNeighbors: number;
  positiveRate: number;
  sameRelationshipNeighbors: number;
  sameRelationshipPositive: number;
  sameRelationshipNegative: number;
}): {
  recommendedLabel: 0 | 1;
  stance: 'supports' | 'contradicts';
  strength: 'strong' | 'moderate' | 'weak';
  claim: string;
} {
  const {
    totalNeighbors,
    positiveNeighbors,
    negativeNeighbors,
    positiveRate,
    sameRelationshipNeighbors,
    sameRelationshipPositive,
    sameRelationshipNegative,
  } = neighborhoodStats;

  if (totalNeighbors === 0) {
    return {
      recommendedLabel: 0,
      stance: 'contradicts',
      strength: 'weak',
      claim:
        'I vote 0 because the graph index returned no neighboring hyperedges sharing entities with the query, so there is no local graph signal to support this relation.',
    };
  }

  if (
    sameRelationshipNeighbors >= 5 &&
    sameRelationshipPositive > sameRelationshipNegative
  ) {
    return {
      recommendedLabel: 1,
      stance: 'supports',
      strength: 'strong',
      claim: `I vote 1 because same-relationship neighbors are sufficiently dense and positive (${sameRelationshipPositive}/${sameRelationshipNeighbors}), which is strong local graph support for the queried relation pattern.`,
    };
  }

  if (positiveRate >= 0.6 && positiveNeighbors >= 20) {
    return {
      recommendedLabel: 1,
      stance: 'supports',
      strength: 'moderate',
      claim: `I vote 1 because the neighborhood is overall positive (${positiveNeighbors}/${totalNeighbors}, positive rate ${positiveRate.toFixed(3)}), which supports this hyperedge being consistent with nearby labeled graph evidence.`,
    };
  }

  if (
    sameRelationshipNeighbors >= 3 &&
    sameRelationshipPositive > sameRelationshipNegative &&
    positiveRate >= 0.5
  ) {
    return {
      recommendedLabel: 1,
      stance: 'supports',
      strength: 'weak',
      claim: `I vote 1 because same-relationship neighbors are slightly positive (${sameRelationshipPositive}/${sameRelationshipNeighbors}) and the overall neighborhood does not contradict that direction.`,
    };
  }

  const strongNegative =
    sameRelationshipNeighbors >= 5 &&
    sameRelationshipNegative >= sameRelationshipPositive + 2;
  return {
    recommendedLabel: 0,
    stance: 'contradicts',
    strength: strongNegative ? 'strong' : 'moderate',
    claim: `I vote 0 because neighboring labeled hyperedges do not support the queried relation strongly enough (overall ${positiveNeighbors}/${totalNeighbors} positive, same-relationship ${sameRelationshipPositive}/${sameRelationshipNeighbors}), so the local graph evidence remains negative.`,
  };
}

export class GraphAgent {
  readonly agentId = 'graph_agent';

  constructor(private readonly localGraphTool: LocalGraphTool) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const queryEntityIds = getEntityIds(
      sample,
      'drug',
      'drugs',
      'protein',
      'disease',
      'sideeffect',
      'cellline',
    );
    const label = hyperedgeLabel(sample.relationshipType);

    const plannerAction: PlannerAction = {
      hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
      hypothesisStatement:
        roundContext?.hypothesisFocus[0] ??
        hypotheses[0]?.statement ??
        'The queried relationship exists.',
      verificationGoal:
        roundContext && roundContext.hypothesisFocus.length > 0
          ? `First read the shared node input for the full hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then form or update a provisional 0/1 prediction for the entire ${label}. After that, inspect labeled neighboring hyperedges and decide whether local graph evidence supports or contradicts ${roundContext.hypothesisFocus.join(' | ')}.`
          : roundContext && roundContext.focus.length > 0
            ? `First read the shared node input for the full hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then inspect labeled neighboring hyperedges and use them to answer ${roundContext.focus.join(' | ')} before ending with a binary vote.`
            : `Inspect labeled neighboring hyperedges around the queried entities and decide whether the ${label} is supported or contradicted by local graph evidence.`,
      expectedEvidence: [
        'shared node descriptions for queried entities as grounding',
        'neighboring hyperedges sharing at least one query entity',
        'neighbor labels (positive/negative) in the local neighborhood',
        'same-relationship neighbor balance and overall positive rate',
      ],
      failureRule:
        'Use only retrieved neighborhood statistics and labeled neighbors to issue one binary recommendation with a concise rationale.',
      toolCalls: [
        {
          tool: 'local_graph_tool',
          arguments: {
            relationshipType: sample.relationshipType,
            query_entities: queryEntityIds,
            roundNumber: roundContext?.roundNumber ?? 1,
            focus: roundContext?.focus ?? [],
            hypothesisFocus: roundContext?.hypothesisFocus ?? [],
            maxCandidates: 8,
          },
        },
      ],
    };

    const [result] = await executePlannerAction(plannerAction, {
      localGraphTool: this.localGraphTool,
      sample,
    });

    if (result.status !== 'ok') {
      throw new Error(
        `local_graph_tool failed for sample ${sample.sampleIndex}: ${result.error ?? result.textSummary}`,
      );
    }

    const structured = result.structured as {
      query?: { relationship?: string; entities?: string[]; key?: string };
      neighborhoodStats?: {
        totalNeighbors?: number;
        positiveNeighbors?: number;
        negativeNeighbors?: number;
        positiveRate?: number;
        sameRelationshipNeighbors?: number;
        sameRelationshipPositive?: number;
        sameRelationshipNegative?: number;
      };
      relationshipBreakdown?: Record<
        string,
        { total?: number; positive?: number; negative?: number }
      >;
      topNeighbors?: Array<{
        relationship?: string;
        entities?: string[];
        label?: 0 | 1;
        sharedEntities?: string[];
        sharedCount?: number;
        sameRelationship?: boolean;
        score?: number;
      }>;
    } | null;

    const stats = structured?.neighborhoodStats;
    if (
      !stats ||
      typeof stats.totalNeighbors !== 'number' ||
      typeof stats.positiveNeighbors !== 'number' ||
      typeof stats.negativeNeighbors !== 'number' ||
      typeof stats.positiveRate !== 'number' ||
      typeof stats.sameRelationshipNeighbors !== 'number' ||
      typeof stats.sameRelationshipPositive !== 'number' ||
      typeof stats.sameRelationshipNegative !== 'number'
    ) {
      throw new Error(
        `local_graph_tool returned invalid neighborhood statistics for sample ${sample.sampleIndex}.`,
      );
    }

    const decision = decideFromNeighborhood({
      totalNeighbors: stats.totalNeighbors,
      positiveNeighbors: stats.positiveNeighbors,
      negativeNeighbors: stats.negativeNeighbors,
      positiveRate: stats.positiveRate,
      sameRelationshipNeighbors: stats.sameRelationshipNeighbors,
      sameRelationshipPositive: stats.sameRelationshipPositive,
      sameRelationshipNegative: stats.sameRelationshipNegative,
    });

    const evidenceItems: EvidenceItem[] = [
      {
        id: `graph-neighborhood-${sample.sampleIndex}`,
        source: this.agentId,
        toolName: 'local_graph_tool',
        entityScope: queryEntityIds,
        claim: decision.claim,
        stance: decision.stance,
        strength: decision.strength,
        structured: {
          query: structured?.query,
          neighborhoodStats: stats,
          relationshipBreakdown: structured?.relationshipBreakdown,
          topNeighbors: structured?.topNeighbors ?? [],
          graphSummary: result.textSummary,
          recommended_label: decision.recommendedLabel,
        },
      },
    ];

    const evaluationTrace: AgentEvaluationTrace[] = [
      {
        id: `graph-trace-${sample.sampleIndex}`,
        toolName: 'local_graph_tool',
        toolArguments: plannerAction.toolCalls[0]?.arguments ?? {},
        entityScope: queryEntityIds,
        rawToolOutput: result,
        interpretedOutput: {
          stance: decision.stance,
          strength: decision.strength,
          claim: decision.claim,
        },
      },
    ];

    const summary =
      decision.recommendedLabel === 1
        ? 'Graph-side expert votes 1 for the current hypothesis in this round.'
        : 'Graph-side expert votes 0 for the current hypothesis in this round.';

    return {
      agentId: this.agentId,
      role: 'graph',
      roundNumber: roundContext?.roundNumber ?? 1,
      recommendedLabel: decision.recommendedLabel,
      summary,
      hypothesesTouched: roundContext?.activeHypothesisIds.length
        ? roundContext.activeHypothesisIds
        : hypotheses.map((hypothesis) => hypothesis.id),
      plannerActions: [plannerAction],
      evidenceItems,
      evaluationTrace,
    };
  }
}
