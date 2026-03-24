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

function detectDrugProteinSignal(
  textSummary: string,
  proteinId: string | undefined,
  diseaseId: string | undefined,
  structured: Record<string, unknown> | null,
  roundContext?: AgentRoundContext,
): {
  stance: EvidenceItem['stance'];
  strength: EvidenceItem['strength'];
  claim: string;
} {
  if (!proteinId) {
    return {
      stance: 'contradicts',
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
  const alternativePressure = hasAlternativeMechanismPressure(roundContext);

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
    if (alternativePressure && directMechanismMatches.length === 0) {
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Drug researcher found only partial mechanism language for ${proteinId}, while peer evidence already points to an alternative mechanism. This weakens the current drug-side hypothesis rather than supporting it.`,
      };
    }
    return {
      stance: 'supports',
      strength: 'moderate',
      claim: `Drug researcher found mechanism-relevant language aligned with protein ${proteinId} (${[...new Set([...proteinKeywordHits, ...(matchedKeyword ? [matchedKeyword] : [])])].slice(0, 3).join(', ')}).`,
    };
  }

  if (mechanismCount > 0 && diseaseIndicationHits.length > 0) {
    if (alternativePressure) {
      return {
        stance: 'contradicts',
        strength: 'moderate',
        claim: `Drug researcher found a concrete mechanism description plus disease-aligned indication context for ${diseaseId ?? 'the queried disease'}, but it does not align with protein ${proteinId} and peer evidence points to a different mechanism. This is negative evidence against the current drug-side story.`,
      };
    }
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Drug researcher found a concrete mechanism description plus disease-aligned indication context for ${diseaseId ?? 'the queried disease'}, but no explicit protein-level match for ${proteinId}. This is not enough to support the triplet on the drug side.`,
    };
  }

  const diseaseMatchedKeyword = diseaseKeywords(diseaseId).find((keyword) =>
    searchable.includes(normalizeText(keyword)),
  );
  if (mechanismCount > 0 && diseaseMatchedKeyword) {
    if (alternativePressure) {
      return {
        stance: 'contradicts',
        strength: 'weak',
        claim: `Drug researcher linked the drug to disease-relevant context (${diseaseMatchedKeyword}), but the mechanism still does not align with ${proteinId} and peer evidence favors another mechanism. This counts against the current drug-side hypothesis.`,
      };
    }
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Drug researcher linked the drug to disease-relevant context (${diseaseMatchedKeyword}) while also providing a mechanism description, but this remains indirect and does not establish the queried drug-protein mechanism.`,
    };
  }

  if (diseaseIndicationHits.length > 0) {
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Drug researcher found disease-aligned indication context for ${diseaseId ?? 'the queried disease'} (${diseaseIndicationHits.slice(0, 3).join(', ')}), but indication overlap without an explicit protein match should remain insufficient.`,
    };
  }

  if (mechanismCount > 0) {
    return {
      stance: 'contradicts',
      strength: 'weak',
      claim: `Drug researcher returned a concrete mechanism description for the queried drug, but without explicit alignment to protein ${proteinId} it should remain insufficient.`,
    };
  }

  return {
    stance: 'contradicts',
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

export class DrugAgent {
  readonly agentId = 'drug_agent';

  constructor(private readonly toolAdapter: ResearchToolAdapter) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drugIds = getEntityIds(sample, 'drug', 'drugs');
    const proteinId = getPrimaryEntity(sample, 'protein');
    const diseaseId = getPrimaryEntity(sample, 'disease');
    const plannerActions: PlannerAction[] = [];
    const evidenceItems: EvidenceItem[] = [];
    const evaluationTrace: AgentEvaluationTrace[] = [];

    for (const drugId of drugIds) {
      const baseReviewContext: ResearchReviewContext = {
        roundNumber: roundContext?.roundNumber ?? 1,
        focusMode:
          roundContext && roundContext.roundNumber > 1
            ? 'mechanism_only'
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
        targetDrugId: drugId,
        targetProteinId: proteinId,
        targetDiseaseId: diseaseId,
      };

      const nodeArguments = {
        entity_type: 'drug',
        entity_id: drugId,
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
        drugbank_id: drugId,
        review_context: reviewContext,
      };

      const plannerAction: PlannerAction = {
        hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
        hypothesisStatement: primaryHypothesisStatement(
          hypotheses,
          roundContext,
        ),
        verificationGoal:
          roundContext && roundContext.hypothesisFocus.length > 0
            ? `Round ${roundContext.roundNumber} drug-side review for ${drugId}: first ground the entity using local node context, then use external evidence to test ${roundContext.hypothesisFocus.join(' | ')}. Shared objective: ${roundContext.roundObjective.title}. Decide whether your current vote is 1 or 0.`
            : roundContext && roundContext.focus.length > 0
              ? `Round ${roundContext.roundNumber} targeted drug-side review for ${drugId}: first ground the entity using local node context, then use external evidence to test ${roundContext.focus.join(' | ')}. Shared objective: ${roundContext.roundObjective.title}. Decide whether your current vote is 1 or 0.`
              : proteinId !== undefined
                ? `First read the local node context for drug ${drugId}, then check whether it has biologically meaningful mechanism or target support involving protein ${proteinId}.`
                : `First read the local node context for drug ${drugId}, then check whether it has biologically meaningful drug-side support relevant to the current sample.`,
        expectedEvidence: [
          'local node description as the primary grounding source',
          'drug-target or mechanism evidence',
          'mechanism-of-action description',
          'indication context',
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
            tool: 'drug_researcher',
            arguments: researcherArguments,
          },
        ],
      };
      plannerActions.push(plannerAction);

      const result = await this.toolAdapter.callTool(
        'drug_researcher',
        researcherArguments,
      );
      const mergedResult = mergeResearchOutputs(result, nodeResult);
      const reasonerResult = await this.toolAdapter.callTool(
        'biomedical_expert_reasoner',
        {
          role: 'drug',
          review_context: reviewContext,
          entity_context: {
            relationshipType: sample.relationshipType,
            drugbankId: drugId,
            proteinId,
            diseaseId,
            localNodeContext: nodeResult.structured,
          },
          evidence_summary: mergedResult.textSummary,
          evidence_structured: {
            primary_local_node: nodeResult.structured,
            researcher: result.structured,
            node_context: nodeResult.structured,
            fallback_heuristic: detectDrugProteinSignal(
              mergedResult.textSummary,
              proteinId,
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
          id: `drug-researcher-${sample.sampleIndex}-${drugId}`,
          source: this.agentId,
          toolName: result.toolName,
          entityScope: proteinId ? [drugId, proteinId] : [drugId],
          claim:
            result.textSummary ||
            `Drug researcher returned no summary for ${drugId}.`,
          stance: 'contradicts',
          strength: 'moderate',
          structured: {
            drugbankId: drugId,
            proteinId,
            result: result.structured,
            status: result.status,
          },
        });
      }

      if (isInformativeToolResult(nodeResult)) {
        evidenceItems.push({
          id: `drug-node-context-${sample.sampleIndex}-${drugId}`,
          source: this.agentId,
          toolName: nodeResult.toolName,
          entityScope: [drugId],
          claim:
            nodeResult.textSummary ||
            `Local node context returned no summary for ${drugId}.`,
          ...localNodeEvidenceSignal(nodeResult),
          structured: {
            drugbankId: drugId,
            result: nodeResult.structured,
            status: nodeResult.status,
          },
        });
      }

      const heuristicSignal = isInformativeToolResult(result)
        ? detectDrugProteinSignal(
            mergedResult.textSummary,
            proteinId,
            diseaseId,
            mergedResult.structured,
            roundContext,
          )
        : null;

      const mechanismSignal = heuristicSignal;
      const finalOutput = reasonedOutput ?? mechanismSignal;

      if (isInformativeToolResult(result) && mechanismSignal) {
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
      }

      if (isInformativeToolResult(nodeResult) && mechanismSignal) {
        evaluationTrace.push({
          id: `drug-node-trace-${sample.sampleIndex}-${drugId}`,
          toolName: 'node_context',
          toolArguments: {
            entity_type: 'drug',
            entity_id: drugId,
          },
          entityScope: [drugId],
          rawToolOutput: nodeResult,
          interpretedOutput: mechanismSignal,
        });
      }

      if (reasonedOutput && finalOutput) {
        evaluationTrace.push({
          id: `drug-reasoner-trace-${sample.sampleIndex}-${drugId}`,
          toolName: 'biomedical_expert_reasoner',
          toolArguments: {
            role: 'drug',
            roundNumber: roundContext?.roundNumber ?? 1,
            objective: roundContext?.roundObjective,
            sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
          },
          entityScope: proteinId ? [drugId, proteinId] : [drugId],
          rawToolOutput: reasonerResult,
          interpretedOutput: finalOutput,
        });
      }

      if (finalOutput) {
        evidenceItems.push({
          id: `drug-mechanism-${sample.sampleIndex}-${drugId}`,
          source: this.agentId,
          toolName: reasonedOutput
            ? 'biomedical_expert_reasoner'
            : 'drug_researcher_screen',
          entityScope: proteinId ? [drugId, proteinId] : [drugId],
          claim: finalOutput.claim,
          stance: finalOutput.stance,
          strength: finalOutput.strength,
          structured: {
            drugbankId: drugId,
            proteinId,
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
        ? 'Drug-side expert votes 1 for the current hypothesis in this round.'
        : 'Drug-side expert votes 0 for the current hypothesis in this round.';

    return {
      agentId: this.agentId,
      role: 'drug',
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
