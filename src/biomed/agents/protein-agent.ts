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
import {
  binaryRecommendationFromEvidence,
  hasAlternativeMechanismPressure,
  normalizeText,
  parseStructuredReasonerOutput,
} from '../assessment-utils.js';
import { getEntityIds, getPrimaryEntity } from '../entity-utils.js';
import {
  getInformativeToolStructured,
  getInformativeToolSummary,
  isInformativeToolResult,
} from '../tool-result-utils.js';

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

function detectProteinDiseaseSignal(
  textSummary: string,
  diseaseId: string | undefined,
  structured: Record<string, unknown> | null,
  roundContext?: AgentRoundContext,
): {
  stance: EvidenceItem['stance'];
  strength: EvidenceItem['strength'];
  claim: string;
} {
  if (!diseaseId) {
    return {
      stance: 'contradicts',
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
  const alternativePressure = hasAlternativeMechanismPressure(roundContext);

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
    if (diseaseKeywordHits.length === 0 && matchedPathways.length === 0) {
      if (alternativePressure) {
        return {
          stance: 'contradicts',
          strength: 'weak',
          claim: `Protein researcher found only broad disease-adjacent biology for ${diseaseId}, while peer evidence points to another mechanism or target axis. This counts against the current protein-disease hypothesis.`,
        };
      }
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Protein researcher found only broad disease-adjacent biology for ${diseaseId} via ${matchedProcesses.slice(0, 3).join(', ')}. Without disease-specific pathway or keyword alignment, this should remain insufficient.`,
      };
    }
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Protein researcher found disease-aligned protein biology for ${diseaseId} via ${[...diseaseKeywordHits, ...matchedProcesses, ...matchedPathways].slice(0, 3).join(', ')}. This still does not by itself prove drug involvement.`,
    };
  }

  if (matchedKeyword) {
    if (alternativePressure) {
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Protein researcher found only a single disease cue (${matchedKeyword}) for ${diseaseId}, while peer evidence favors another mechanism. This weakens the current protein-side story.`,
      };
    }
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Protein researcher output contains disease-relevant cue (${matchedKeyword}) consistent with disease ${diseaseId}, but a single cue without stronger pathway or disease-specific evidence should remain insufficient.`,
    };
  }

  if (biologicalProcesses.length > 0 && reactomePathways.length > 0) {
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Protein researcher returned both biological-process and pathway annotations for ${diseaseId}, but without explicit disease-specific alignment this should remain insufficient.`,
    };
  }

  if (functionDescription) {
    if (alternativePressure) {
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Protein researcher returned only generic function text for the queried protein, and peer evidence points to another mechanism. This is negative evidence for the current protein-disease hypothesis.`,
      };
    }
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Protein researcher returned a concrete function description for the queried protein, but generic function text alone should remain insufficient for disease ${diseaseId}.`,
    };
  }

  return {
    stance: 'contradicts',
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

function mergeResearchOutputs(
  primaryResult: {
    toolName: string;
    status: 'ok' | 'error';
    textSummary: string;
    structured: Record<string, unknown> | null;
  },
  nodeResult: {
    toolName: string;
    status: 'ok' | 'error';
    textSummary: string;
    structured: Record<string, unknown> | null;
  },
): {
  textSummary: string;
  structured: Record<string, unknown>;
} {
  const primarySummary = getInformativeToolSummary(primaryResult);
  const nodeSummary = getInformativeToolSummary(nodeResult);
  const primaryStructured = getInformativeToolStructured(primaryResult);
  const nodeStructured = getInformativeToolStructured(nodeResult);

  return {
    textSummary: [nodeSummary, primarySummary]
      .filter((value) => value.trim() !== '')
      .join(' '),
    structured: {
      local_node_context: nodeStructured,
      ...(primaryStructured ?? {}),
      node_context: nodeStructured,
    },
  };
}

function localNodeEvidenceSignal(nodeResult: {
  status: string;
  structured: Record<string, unknown> | null;
}): Pick<EvidenceItem, 'stance' | 'strength'> {
  const nodeFound = nodeResult.structured?.node_found === true;
  if (nodeResult.status === 'ok' && nodeFound) {
    return { stance: 'supports', strength: 'weak' };
  }
  return { stance: 'contradicts', strength: 'weak' };
}

export class ProteinAgent {
  readonly agentId = 'protein_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const proteinIds = getEntityIds(sample, 'protein');
    const diseaseId = getPrimaryEntity(sample, 'disease');
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    for (const proteinId of proteinIds) {
      const baseReviewContext: ResearchReviewContext = {
        roundNumber: roundContext?.roundNumber ?? 1,
        focusMode:
          roundContext && roundContext.roundNumber > 1
            ? 'disease_alignment'
            : 'broad',
        focalQuestion: roundContext?.focus[0],
        focus: roundContext?.focus ?? [],
        peerFindings: roundContext?.peerAssessmentSummaries ?? [],
        peerEvidence: roundContext?.peerEvidenceDigest ?? [],
        positiveEvidence: roundContext?.positiveEvidenceDigest ?? [],
        negativeEvidence: roundContext?.negativeEvidenceDigest ?? [],
        alternativeMechanismSignals:
          roundContext?.alternativeMechanismSignals ?? [],
        sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
        roundObjective: roundContext?.roundObjective,
        hypothesisFocus: roundContext?.hypothesisFocus ?? [],
        activeHypothesisIds: roundContext?.activeHypothesisIds ?? [],
        targetProteinId: proteinId,
        targetDiseaseId: diseaseId,
      };

      const nodeArguments = {
        entity_type: 'protein',
        entity_id: proteinId,
      };
      const nodeResult = await this.toolAdapter.callTool(
        'node_context',
        nodeArguments,
      );
      const reviewContext: ResearchReviewContext = {
        ...baseReviewContext,
        localNodeSummary: nodeResult.textSummary,
        localNodeStructured: nodeResult.structured ?? undefined,
        localEvidencePriority: 'primary',
      };
      const researcherArguments = {
        gene_symbol: proteinId,
        review_context: reviewContext,
      };

      const plannerAction: PlannerAction = {
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement: primaryHypothesisStatement(
          hypotheses,
          roundContext,
        ),
        verificationGoal: diseaseId
          ? roundContext && roundContext.hypothesisFocus.length > 0
            ? `Round ${roundContext.roundNumber} protein-side review for protein ${proteinId}: first ground the entity using local node context, then test ${roundContext.hypothesisFocus.join(' | ')}. Shared objective: ${roundContext.roundObjective.title}. Decide whether your current vote is 1 or 0.`
            : roundContext && roundContext.focus.length > 0
              ? `Round ${roundContext.roundNumber} targeted protein-side review for protein ${proteinId}: first ground the entity using local node context, then test ${roundContext.focus.join(' | ')}. Shared objective: ${roundContext.roundObjective.title}. Decide whether your current vote is 1 or 0.`
              : `First read the local node context for protein ${proteinId}, then check whether it has disease-relevant evidence for ${diseaseId}, while keeping drug involvement separate.`
          : `First read the local node context for protein ${proteinId}, then check whether it has disease-relevant evidence for the current sample.`,
        expectedEvidence: [
          'local node description as the primary grounding source',
          'protein function summary',
          'disease-relevant pathway, phenotype, or mechanistic signal',
          'protein relevance information',
          'peer findings and prior positive/negative evidence',
        ],
        failureRule:
          'After reviewing the available evidence and using your biological judgment, end this round with a binary 1/0 recommendation and a concise rationale.',
        toolCalls: [
          {
            tool: 'node_context',
            arguments: nodeArguments,
          },
          {
            tool: 'protein_researcher',
            arguments: researcherArguments,
          },
        ],
      };
      plannerActions.push(plannerAction);

      const result = await this.toolAdapter.callTool(
        'protein_researcher',
        researcherArguments,
      );
      const mergedResult = mergeResearchOutputs(result, nodeResult);
      const reasonerResult = await this.toolAdapter.callTool(
        'biomedical_expert_reasoner',
        {
          role: 'protein',
          review_context: reviewContext,
          entity_context: {
            relationshipType: sample.relationshipType,
            proteinId,
            diseaseId,
            localNodeContext: nodeResult.structured,
          },
          evidence_summary: mergedResult.textSummary,
          evidence_structured: {
            primary_local_node: nodeResult.structured,
            researcher: result.structured,
            node_context: nodeResult.structured,
            fallback_heuristic: detectProteinDiseaseSignal(
              mergedResult.textSummary,
              diseaseId,
              mergedResult.structured,
              roundContext,
            ),
          },
        },
      );
      const reasonedOutput = parseStructuredReasonerOutput(
        reasonerResult.structured,
      );

      if (isInformativeToolResult(result)) {
        evidenceItems.push({
          id: `protein-researcher-${sample.sampleIndex}-${proteinId}`,
          source: this.agentId,
          toolName: result.toolName,
          entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
          claim:
            result.textSummary ||
            `Protein researcher returned no summary for ${proteinId}.`,
          stance: 'contradicts',
          strength: 'moderate',
          structured: {
            proteinId,
            diseaseId,
            result: result.structured,
            status: result.status,
          },
        });
      }

      if (isInformativeToolResult(nodeResult)) {
        evidenceItems.push({
          id: `protein-node-context-${sample.sampleIndex}-${proteinId}`,
          source: this.agentId,
          toolName: nodeResult.toolName,
          entityScope: [proteinId],
          claim:
            nodeResult.textSummary ||
            `Local node context returned no summary for ${proteinId}.`,
          ...localNodeEvidenceSignal(nodeResult),
          structured: {
            proteinId,
            result: nodeResult.structured,
            status: nodeResult.status,
          },
        });
      }

      const heuristicSignal = isInformativeToolResult(result)
        ? detectProteinDiseaseSignal(
            mergedResult.textSummary,
            diseaseId,
            mergedResult.structured,
            roundContext,
          )
        : null;

      const diseaseSignal = heuristicSignal;
      const finalOutput = reasonedOutput ?? diseaseSignal;

      if (isInformativeToolResult(result) && diseaseSignal) {
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
      }

      if (isInformativeToolResult(nodeResult) && diseaseSignal) {
        evaluationTrace.push({
          id: `protein-node-trace-${sample.sampleIndex}-${proteinId}`,
          toolName: 'node_context',
          toolArguments: {
            entity_type: 'protein',
            entity_id: proteinId,
          },
          entityScope: [proteinId],
          rawToolOutput: nodeResult,
          interpretedOutput: diseaseSignal,
        });
      }

      if (reasonedOutput && finalOutput) {
        evaluationTrace.push({
          id: `protein-reasoner-trace-${sample.sampleIndex}-${proteinId}`,
          toolName: 'biomedical_expert_reasoner',
          toolArguments: {
            role: 'protein',
            roundNumber: roundContext?.roundNumber ?? 1,
            objective: roundContext?.roundObjective,
            sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
          },
          entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
          rawToolOutput: reasonerResult,
          interpretedOutput: finalOutput,
        });
      }

      if (finalOutput) {
        evidenceItems.push({
          id: `protein-disease-${sample.sampleIndex}-${proteinId}`,
          source: this.agentId,
          toolName: reasonedOutput
            ? 'biomedical_expert_reasoner'
            : 'protein_researcher_screen',
          entityScope: diseaseId ? [proteinId, diseaseId] : [proteinId],
          claim: finalOutput.claim,
          stance: finalOutput.stance,
          strength: finalOutput.strength,
          structured: {
            proteinId,
            diseaseId,
            researcherStatus: result.status,
            nodeContextStatus: nodeResult.status,
            reasonerStructured: reasonerResult.structured,
          },
        });
      }
    }

    const reasonerVotes = evidenceItems
      .map((item) => item.structured.reasonerStructured)
      .filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === 'object',
      )
      .map((structured) => structured.recommended_label)
      .filter((value): value is 0 | 1 => value === 0 || value === 1);
    const recommendedLabel =
      reasonerVotes.length > 0
        ? reasonerVotes.filter((value) => value === 1).length >
          reasonerVotes.filter((value) => value === 0).length
          ? 1
          : 0
        : binaryRecommendationFromEvidence(evidenceItems);
    const summary =
      recommendedLabel === 1
        ? 'Protein-side expert votes 1 for the current hypothesis in this round.'
        : 'Protein-side expert votes 0 for the current hypothesis in this round.';

    return {
      agentId: this.agentId,
      role: 'protein',
      roundNumber: roundContext?.roundNumber ?? 1,
      recommendedLabel,
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
