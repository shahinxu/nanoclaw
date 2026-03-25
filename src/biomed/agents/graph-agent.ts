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
import {
  binaryRecommendationFromEvidence,
  parseStructuredReasonerOutput,
} from '../assessment-utils.js';
import { getPrimaryEntity } from '../entity-utils.js';
import { executePlannerAction } from '../plan-executor.js';
import { formatSharedNodeBundle } from '../shared-node-context.js';
import { isInformativeToolResult } from '../tool-result-utils.js';
import { LocalGraphTool } from '../tools/local-graph-tool.js';

export class GraphAgent {
  readonly agentId = 'graph_agent';

  constructor(
    private readonly localGraphTool: LocalGraphTool,
    private readonly researchToolAdapter: ResearchToolAdapter,
  ) {}

  async assess(
    sample: BiomedTaskSample,
    hypotheses: HypothesisRecord[],
    roundContext?: AgentRoundContext,
  ): Promise<AgentAssessment> {
    const drug = getPrimaryEntity(sample, 'drug');
    const protein = getPrimaryEntity(sample, 'protein');
    const disease = getPrimaryEntity(sample, 'disease');
    const plannerAction: PlannerAction = {
      hypothesisId: hypotheses[0]?.id ?? `H-positive-${sample.sampleIndex}`,
      hypothesisStatement:
        roundContext?.hypothesisFocus[0] ??
        hypotheses[0]?.statement ??
        'The queried drug-protein-disease relationship exists.',
      verificationGoal:
        roundContext && roundContext.hypothesisFocus.length > 0
          ? `First read the shared node input for the full hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then form or update a provisional 0/1 prediction for the entire drug-protein-disease hyperedge. Speak as a first-person graph expert. ${roundContext.roundObjective.sharedDebateQuestion ? `Address this shared dispute directly: ${roundContext.roundObjective.sharedDebateQuestion}. ` : ''}If this is not the first round, explicitly support or challenge another expert by role before ending with a binary vote. After that, use neighboring hyperedges only to test ${roundContext.hypothesisFocus.join(' | ')}.`
          : roundContext && roundContext.focus.length > 0
            ? `First read the shared node input for the full hyperedge (${formatSharedNodeBundle(roundContext.sharedNodeContext)}), then form or update a provisional 0/1 prediction for the entire hyperedge. Speak as a first-person graph expert. ${roundContext.roundObjective.sharedDebateQuestion ? `Address this shared dispute directly: ${roundContext.roundObjective.sharedDebateQuestion}. ` : ''}If this is not the first round, explicitly support or challenge another expert by role before ending with a binary vote. Use neighboring hyperedges only to probe ${roundContext.focus.join(' | ')}.`
            : 'First read the shared node input for the full hyperedge, form a provisional 0/1 prediction, speak in first person as the graph-side expert, and use neighboring positive hyperedges only if needed to test whether the triplet sits inside a supportive local graph neighborhood.',
      expectedEvidence: [
        'shared node descriptions for drug, protein, and disease as the primary grounding source',
        'a provisional whole-hyperedge 0/1 judgment before graph retrieval',
        'shared drug-protein neighborhood',
        'shared drug-disease neighborhood',
        'shared protein-disease neighborhood',
        'graph patterns and peer evidence',
      ],
      failureRule:
        'After reviewing the available evidence and using your graph and biological judgment, end this round with a binary 1/0 recommendation and a concise rationale.',
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
    const localGraphInformative = isInformativeToolResult(result);
    const structured = (localGraphInformative ? result.structured : null) as {
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
    const alternativePressure =
      (roundContext?.alternativeMechanismSignals.length ?? 0) > 0 ||
      (roundContext?.negativeEvidenceDigest.length ?? 0) > 1;
    const biologicalNarratives = biologicalInterpretation?.narratives ?? [];
    const topHyperedges = informativeHyperedgeRetrieval?.topCandidates ?? [];
    const narrativeText = biologicalNarratives.join(' ');

    const reasonerResult = await this.researchToolAdapter.callTool(
      'graph_reasoner',
      {
        review_context: {
          roundNumber: roundContext?.roundNumber ?? 1,
          focusMode: 'broad',
          focalQuestion:
            roundContext?.roundObjective.sharedDebateQuestion ??
            roundContext?.focus[0],
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
          sharedNodeContext: roundContext?.sharedNodeContext,
          targetDrugId: drug,
          targetProteinId: protein,
          targetDiseaseId: disease,
        },
        graph_summary: result.textSummary,
        graph_structured: {
          graphNeighborhood: neighborhood,
          informativeHyperedgeRetrieval,
          biologicalInterpretation,
          graphStrengthFeatures: {
            pairSupportCount,
            supportScore,
            threeWayClosure,
            proteinDiseaseBackbone,
            drugProteinBackbone,
            drugDiseaseBackbone,
            sharedDrugProteinCount,
            sharedDrugDiseaseCount,
            sharedProteinDiseaseCount,
            localSupportTier: neighborhood?.localSupportTier,
            retrievalTier: neighborhood?.retrievalTier,
            supportTier,
          },
          topHyperedges,
        },
      },
    );
    const reasonedOutput = parseStructuredReasonerOutput(
      reasonerResult.structured,
    );

    const finalOutput =
      reasonedOutput ??
      (localGraphInformative && supportTier === 'strong'
        ? {
            stance: 'supports' as const,
            strength: 'strong' as const,
            claim:
              narrativeText ||
              'The local graph places the queried triplet inside a dense biologically coherent positive neighborhood.',
          }
        : localGraphInformative && supportTier === 'moderate'
          ? {
              stance: 'supports' as const,
              strength: 'moderate' as const,
              claim:
                narrativeText ||
                'The local graph provides moderate neighborhood evidence for the queried triplet.',
            }
          : localGraphInformative &&
              alternativePressure &&
              topHyperedges.some(
                (candidate) => (candidate.introducedEntities?.length ?? 0) > 0,
              )
            ? {
                stance: 'contradicts' as const,
                strength: 'weak' as const,
                claim:
                  narrativeText ||
                  'The local graph is better bridged through alternative entities than through the queried triplet, which counts against the current mechanism.',
              }
            : localGraphInformative && supportTier === 'weak'
              ? {
                  stance: 'contradicts' as const,
                  strength: 'weak' as const,
                  claim:
                    narrativeText ||
                    'The local graph provides weak but incomplete neighborhood evidence for the queried triplet.',
                }
              : null);

    const entityScope = [drug, protein, disease].filter(
      (value): value is string => Boolean(value),
    );

    const evaluationTrace: AgentEvaluationTrace[] = [];
    if (localGraphInformative && finalOutput) {
      evaluationTrace.push({
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
        interpretedOutput: finalOutput,
      });
    }
    if (reasonedOutput && finalOutput) {
      evaluationTrace.push({
        id: `graph-reasoner-trace-${sample.sampleIndex}`,
        toolName: 'graph_reasoner',
        toolArguments: {
          roundNumber: roundContext?.roundNumber ?? 1,
          objective: roundContext?.roundObjective,
          sharedEvidenceBoard: roundContext?.sharedEvidenceBoard,
        },
        entityScope,
        rawToolOutput: reasonerResult,
        interpretedOutput: finalOutput,
      });
    }

    const evidenceItems: EvidenceItem[] = [];
    if (finalOutput) {
      evidenceItems.push({
        id: `graph-neighborhood-${sample.sampleIndex}`,
        source: this.agentId,
        toolName: reasonedOutput ? 'graph_reasoner' : 'local_graph_tool',
        entityScope,
        claim: finalOutput.claim,
        stance: finalOutput.stance,
        strength: finalOutput.strength,
        structured: {
          graphSummary: result.textSummary,
          reasonerSummary: reasonerResult.textSummary,
          reasonerStructured: reasonerResult.structured,
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
      });
    }

    const recommendedLabel = reasonedOutput
      ? reasonedOutput.recommendedLabel
      : binaryRecommendationFromEvidence(evidenceItems);
    const summary =
      recommendedLabel === 1
        ? 'Graph-side expert votes 1 for the current hypothesis in this round.'
        : 'Graph-side expert votes 0 for the current hypothesis in this round.';

    return {
      agentId: this.agentId,
      role: 'graph',
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
