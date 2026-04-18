import {
  AgentAssessment,
  AgentEvaluationTrace,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceItem,
  HypothesisRecord,
  PlannerAction,
  ResearchToolAdapter,
} from '../types.js';
import { getEntityIds } from '../entity-utils.js';
import { executePlannerAction } from '../plan-executor.js';
import { formatSharedNodeBundle } from '../shared-node-context.js';
import { parseStructuredReasonerOutput, parseLabelFromRaw, labelToStance } from '../assessment-utils.js';
import {
  InformativeHyperedgeCandidate,
  LocalGraphTool,
} from '../tools/local-graph-tool.js';

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
  if (relationshipType === 'drug_disease') {
    return 'drug-disease indication/contraindication edge';
  }
  if (relationshipType === 'drug_protein_disease') {
    return 'drug-protein-disease hyperedge';
  }
  return `${relationshipType} hyperedge`;
}

// ---------------------------------------------------------------------------
// Build a rich, human-readable narrative from graph neighbourhood data so the
// LLM can reason over it the way a human researcher would browse a knowledge
// graph — going beyond simple positive-rate thresholds.
// ---------------------------------------------------------------------------
function buildGraphNarrative(
  queryEntities: string[],
  relationshipType: string,
  stats: {
    totalNeighbors: number;
    positiveNeighbors: number;
    negativeNeighbors: number;
    positiveRate: number;
    sameRelationshipNeighbors: number;
    sameRelationshipPositive: number;
    sameRelationshipNegative: number;
  },
  relationshipBreakdown:
    | Record<string, { total?: number; positive?: number; negative?: number }>
    | undefined,
  topNeighbors: InformativeHyperedgeCandidate[],
): string {
  const lines: string[] = [];

  lines.push(
    '## Neighbourhood overview',
    `Query entities: ${queryEntities.join(', ')}`,
    `Query relationship type: ${relationshipType}`,
    `Total neighbouring hyperedges sharing ≥1 entity: ${stats.totalNeighbors}`,
    `  Positive (label=1): ${stats.positiveNeighbors}  |  Negative (label=0): ${stats.negativeNeighbors}  |  Positive rate: ${(stats.positiveRate * 100).toFixed(1)}%`,
    `Same-relationship neighbours: ${stats.sameRelationshipNeighbors} (positive=${stats.sameRelationshipPositive}, negative=${stats.sameRelationshipNegative})`,
  );

  if (relationshipBreakdown && Object.keys(relationshipBreakdown).length > 0) {
    lines.push('', '## Relationship-type breakdown of neighbours');
    for (const [rel, counts] of Object.entries(relationshipBreakdown)) {
      const total = counts.total ?? 0;
      const pos = counts.positive ?? 0;
      const neg = counts.negative ?? 0;
      const rate = total > 0 ? ((pos / total) * 100).toFixed(1) : '0.0';
      lines.push(
        `  ${rel}: ${total} edges (${pos} positive, ${neg} negative, ${rate}% positive)`,
      );
    }
  }

  if (topNeighbors.length > 0) {
    lines.push('', '## Most informative neighbouring hyperedges');
    for (const [i, n] of topNeighbors.entries()) {
      const labelStr = n.label === 1 ? 'POSITIVE' : 'NEGATIVE';
      const sameRel = n.sameRelationship ? ' [same-relationship]' : '';
      lines.push(
        `  ${i + 1}. ${n.relationship}(${n.entities.join(', ')})  label=${labelStr}${sameRel}`,
        `     Shared entities with query: ${n.sharedEntities.join(', ')} (${n.sharedCount} shared)  score=${n.score}`,
      );
    }
  }

  if (topNeighbors.length > 0) {
    lines.push('', '## Patterns to consider');

    // Entity co-occurrence patterns
    const entityAppearances = new Map<string, { pos: number; neg: number }>();
    for (const n of topNeighbors) {
      for (const e of n.entities) {
        const counts = entityAppearances.get(e) ?? { pos: 0, neg: 0 };
        if (n.label === 1) counts.pos += 1;
        else counts.neg += 1;
        entityAppearances.set(e, counts);
      }
    }
    const frequentEntities = [...entityAppearances.entries()]
      .filter(([, c]) => c.pos + c.neg >= 2)
      .sort(([, a], [, b]) => b.pos + b.neg - (a.pos + a.neg))
      .slice(0, 10);
    if (frequentEntities.length > 0) {
      lines.push('  Frequently co-occurring entities in neighbourhood:');
      for (const [entity, counts] of frequentEntities) {
        const isQuery = queryEntities.includes(entity)
          ? ' (query entity)'
          : '';
        lines.push(
          `    ${entity}${isQuery}: appears in ${counts.pos} positive + ${counts.neg} negative edges`,
        );
      }
    }

    // Same-relationship neighbor details
    const sameRelNeighbors = topNeighbors.filter((n) => n.sameRelationship);
    if (sameRelNeighbors.length > 0) {
      lines.push('  Same-relationship neighbours detail:');
      for (const n of sameRelNeighbors) {
        const nonShared = n.entities.filter(
          (e) => !n.sharedEntities.includes(e),
        );
        lines.push(
          `    ${n.entities.join(' + ')} → label=${n.label}  (non-shared: ${nonShared.join(', ') || 'none'})`,
        );
      }
    }

    // Cross-relationship signals
    const crossRelNeighbors = topNeighbors.filter((n) => !n.sameRelationship);
    if (crossRelNeighbors.length > 0) {
      lines.push(
        '  Cross-relationship signals (different relationship types sharing query entities):',
      );
      for (const n of crossRelNeighbors.slice(0, 5)) {
        lines.push(
          `    ${n.relationship}(${n.entities.join(', ')}) → label=${n.label}  shared=[${n.sharedEntities.join(', ')}]`,
        );
      }
    }
  }

  return lines.join('\n');
}

export class GraphAgent {
  readonly agentId = 'graph_agent';

  constructor(
    private readonly localGraphTool: LocalGraphTool,
    private readonly toolAdapter: ResearchToolAdapter,
  ) {}

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
    const heLabel = hyperedgeLabel(sample.relationshipType);

    // ── Step 1: Retrieve neighbourhood from local graph tool ────────────
    const plannerAction: PlannerAction = {
      hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
      hypothesisStatement:
        roundContext?.hypothesisFocus[0] ??
        hypotheses[0]?.statement ??
        'The queried relationship exists.',
      verificationGoal:
        roundContext && roundContext.hypothesisFocus.length > 0
          ? `First read the shared node input for the full hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then form or update a provisional 0/1 prediction for the entire ${heLabel}. After that, inspect labeled neighboring hyperedges and decide whether local graph evidence supports or contradicts ${roundContext.hypothesisFocus.join(' | ')}.`
          : roundContext && roundContext.focus.length > 0
            ? `First read the shared node input for the full hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then inspect labeled neighboring hyperedges and use them to answer ${roundContext.focus.join(' | ')} before ending with a binary vote.`
            : `Inspect labeled neighboring hyperedges around the queried entities and decide whether the ${heLabel} is supported or contradicted by local graph evidence.`,
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
            maxCandidates: 15,
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
      topNeighbors?: InformativeHyperedgeCandidate[];
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

    const topNeighbors = (structured?.topNeighbors ??
      []) as InformativeHyperedgeCandidate[];

    // ── Step 2: Build rich narrative for LLM reasoning ──────────────────
    const graphNarrative = buildGraphNarrative(
      queryEntityIds,
      sample.relationshipType,
      {
        totalNeighbors: stats.totalNeighbors,
        positiveNeighbors: stats.positiveNeighbors,
        negativeNeighbors: stats.negativeNeighbors,
        positiveRate: stats.positiveRate,
        sameRelationshipNeighbors: stats.sameRelationshipNeighbors,
        sameRelationshipPositive: stats.sameRelationshipPositive,
        sameRelationshipNegative: stats.sameRelationshipNegative,
      },
      structured?.relationshipBreakdown,
      topNeighbors,
    );

    // Build debate-aware review context
    const reviewContext: Record<string, unknown> = {};
    if (roundContext) {
      if (roundContext.roundObjective) {
        reviewContext.round_objective = roundContext.roundObjective;
      }
      if (roundContext.sharedEvidenceBoard) {
        reviewContext.shared_evidence_board = roundContext.sharedEvidenceBoard;
      }
      if (roundContext.focus.length > 0) {
        reviewContext.debate_focus = roundContext.focus;
      }
      if (roundContext.hypothesisFocus.length > 0) {
        reviewContext.hypothesis_focus = roundContext.hypothesisFocus;
      }
    }

    // ── Step 3: Call graph_reasoner LLM ─────────────────────────────────
    const reasonerResult = await this.toolAdapter.callTool('graph_reasoner', {
      review_context: reviewContext,
      graph_summary: graphNarrative,
      graph_structured: {
        query: structured?.query,
        neighborhoodStats: stats,
        relationshipBreakdown: structured?.relationshipBreakdown,
        topNeighbors,
      },
      relationship_type: sample.relationshipType,
    });

    let recommendedLabel: -1 | 0 | 1 | 2;
    let stance: 'supports' | 'contradicts';
    let strength: 'strong' | 'moderate' | 'weak';
    let claim: string;

    if (reasonerResult.status !== 'ok') {
      throw new Error(
        `graph_reasoner LLM failed for sample ${sample.sampleIndex}: ${reasonerResult.error ?? 'unknown'}`,
      );
    }

    const reasoned = parseStructuredReasonerOutput(reasonerResult.structured);
    if (reasoned) {
      recommendedLabel = reasoned.recommendedLabel;
      stance = reasoned.stance;
      strength = reasoned.strength;
      claim = reasoned.claim;
    } else {
      // Fallback: parse from structured directly
      const s = reasonerResult.structured as Record<string, unknown> | null;
      recommendedLabel = parseLabelFromRaw(s?.recommended_label);
      stance = labelToStance(recommendedLabel);
      strength = 'moderate';
      claim =
        typeof s?.claim === 'string'
          ? s.claim
          : `Graph-side expert votes ${recommendedLabel} based on neighbourhood analysis.`;
    }

    // ── Step 4: Assemble assessment ─────────────────────────────────────
    const evidenceItems: EvidenceItem[] = [
      {
        id: `graph-neighborhood-${sample.sampleIndex}`,
        source: this.agentId,
        toolName: 'local_graph_tool',
        entityScope: queryEntityIds,
        claim,
        stance,
        strength,
        structured: {
          query: structured?.query,
          neighborhoodStats: stats,
          relationshipBreakdown: structured?.relationshipBreakdown,
          topNeighbors,
          graphNarrative,
          recommended_label: recommendedLabel,
          reasonerStructured: reasonerResult.structured,
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
          stance,
          strength,
          claim,
        },
      },
      {
        id: `graph-reasoner-trace-${sample.sampleIndex}`,
        toolName: 'graph_reasoner',
        toolArguments: {
          relationship_type: sample.relationshipType,
          roundNumber: roundContext?.roundNumber ?? 1,
        },
        entityScope: queryEntityIds,
        rawToolOutput: reasonerResult,
        interpretedOutput: {
          stance,
          strength,
          claim,
        },
      },
    ];

    const summary = `Graph-side expert votes ${recommendedLabel} for the current hypothesis in this round.`;

    return {
      agentId: this.agentId,
      role: 'graph',
      roundNumber: roundContext?.roundNumber ?? 1,
      recommendedLabel,
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
