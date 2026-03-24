import { DEFAULT_BIOMED_CONFIG, type BiomedWorkflowConfig } from './config.js';
import { DrugAgent } from './agents/drug-agent.js';
import { ProteinAgent } from './agents/protein-agent.js';
import { DiseaseAgent } from './agents/disease-agent.js';
import { GraphAgent } from './agents/graph-agent.js';
import { Arbiter } from './agents/arbiter.js';
import { generateInitialHypotheses } from './hypotheses/generator.js';
import {
  advanceHypothesisState,
  createHypothesisState,
} from './hypotheses/state.js';
import { NoopTraceWriter, type TraceWriter } from './trace-writer.js';
import { CsvTaskLoader, type TaskLoader } from './task-loader.js';
import { LocalGraphTool } from './tools/local-graph-tool.js';
import { PythonResearchToolAdapter } from './tools/python-researcher-adapter.js';
import { ALL_AGENT_ROLES, BIOMED_ROLES, SOURCE_BY_ROLE } from './agent-constants.js';
import { summarizePeerAssessment } from './assessment-utils.js';
import { getPrimaryEntity } from './entity-utils.js';
import {
  AgentAssessment,
  AgentRoundContext,
  BiomedTaskSample,
  EvidenceBoard,
  EvidenceItem,
  HypothesisRecord,
  ResearchToolAdapter,
  RoundObjective,
  RoundDisagreement,
  SampleTraceRecord,
  SampleRoundRecord,
  WorkflowResult,
} from './types.js';

function disagreementFingerprint(item: RoundDisagreement): string {
  return [item.title, [...item.affectedRoles].sort().join(',')].join('::');
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function evidenceDigest(item: EvidenceItem): string {
  return `${item.source} ${item.stance}/${item.strength}: ${item.claim}`;
}

function hasAlternativeMechanismCue(value: string): boolean {
  return /(alternative|substitute target|substitute pathway|different mechanism|another mechanism|redirect|better explains|rather than|instead of)/i.test(
    value,
  );
}

function summarizeAssessmentVote(assessment: AgentAssessment): string {
  return `${assessment.role}=${assessment.recommendedLabel}: ${assessment.summary}`;
}

function buildSharedEvidenceBoard(
  previousRound: SampleRoundRecord | undefined,
  unresolvedDisagreements: RoundDisagreement[],
): EvidenceBoard {
  const priorAssessments = previousRound?.assessments ?? [];
  const priorEvidence = previousRound?.evidenceItems ?? [];
  const priorDisagreements = previousRound?.disagreements ?? unresolvedDisagreements;
  const positiveVotes = priorAssessments.filter(
    (assessment) => assessment.recommendedLabel === 1,
  ).length;
  const negativeVotes = priorAssessments.filter(
    (assessment) => assessment.recommendedLabel === 0,
  ).length;

  return {
    status:
      positiveVotes > 0 && negativeVotes > 0 ? 'conflict' : 'agreement',
    voteSummary: priorAssessments.map(summarizeAssessmentVote).slice(0, 6),
    positiveEvidence: dedupeStrings(
      priorEvidence
        .filter((item) => item.stance === 'supports')
        .map(evidenceDigest),
    ).slice(0, 6),
    negativeEvidence: dedupeStrings(
      priorEvidence
        .filter((item) => item.stance === 'contradicts')
        .map(evidenceDigest),
    ).slice(0, 6),
    contestedClaims: dedupeStrings(
      priorDisagreements.map(
        (item) => `${item.title}: ${item.rationale || item.question}`,
      ),
    ).slice(0, 5),
    alternativeMechanismSignals: dedupeStrings([
      ...priorEvidence
        .filter((item) => hasAlternativeMechanismCue(item.claim))
        .map(evidenceDigest),
      ...priorDisagreements
        .filter(
          (item) =>
            hasAlternativeMechanismCue(item.question) ||
            hasAlternativeMechanismCue(item.rationale),
        )
        .map((item) => `${item.title}: ${item.question}`),
    ]).slice(0, 5),
    openQuestions: dedupeStrings(
      priorDisagreements.map((item) => item.question),
    ).slice(0, 5),
  };
}

function buildRoundObjective(
  roundNumber: number,
  board: EvidenceBoard,
): RoundObjective {
  if (roundNumber === 1 || board.voteSummary.length === 0) {
    return {
      title: 'Establish first-pass position',
      directive:
        'Build the initial positive and negative case for the queried triplet, then cast a binary 0/1 vote.',
      responseRequirement:
        'State a binary vote and name the strongest positive or negative claim you are relying on.',
      targetRoles: [...ALL_AGENT_ROLES],
    };
  }

  if (board.status === 'conflict') {
    return {
      title: 'Resolve the shared conflict',
      directive:
        'All agents must address the same vote split and decide whether the strongest positive evidence or the strongest negative evidence better explains the queried triplet.',
      responseRequirement:
        'Cast a binary vote, explicitly respond to at least one opposing claim from the shared evidence board, and state whether your vote changed.',
      targetRoles: [...ALL_AGENT_ROLES],
    };
  }

  return {
    title: 'Stress-test the current consensus',
    directive:
      board.negativeEvidence.length > 0
        ? 'The current board leans negative. Look for concrete evidence that could overturn that view before voting.'
        : 'The current board leans positive. Look for concrete evidence that could break that view before voting.',
    responseRequirement:
      'Cast a binary vote and explain whether the shared board changed your confidence or not.',
    targetRoles: [...ALL_AGENT_ROLES],
  };
}

function collectPeerEvidence(
  role: (typeof ALL_AGENT_ROLES)[number],
  rounds: SampleRoundRecord[],
): EvidenceItem[] {
  const source = SOURCE_BY_ROLE[role];
  return (rounds.at(-1)?.evidenceItems ?? []).filter(
    (item) => item.source !== source,
  );
}

function escalationLevel(
  persistenceCount: number,
): RoundDisagreement['escalationLevel'] {
  if (persistenceCount >= 3) {
    return 'persistent';
  }
  if (persistenceCount >= 2) {
    return 'escalated';
  }
  return 'initial';
}

function createRoleGapQuestion(
  role: (typeof BIOMED_ROLES)[number],
  sample: BiomedTaskSample,
  persistenceCount = 1,
): string {
  const drug = getPrimaryEntity(sample, 'drug') ?? 'the queried drug';
  const protein = getPrimaryEntity(sample, 'protein') ?? 'the queried protein';
  const disease = getPrimaryEntity(sample, 'disease') ?? 'the queried disease';

  if (role === 'drug') {
    if (persistenceCount >= 3) {
      return `After repeated failed checks, should the debate abandon ${protein} as the primary target for ${drug} and search for an alternative mechanism that better explains ${disease}?`;
    }
    if (persistenceCount === 2) {
      return `What biological or pharmacological evidence would make the ${drug}-${protein} mechanism convincing for ${disease}?`;
    }
    return `Should the drug-side expert currently vote 1 or 0 for a biologically meaningful ${drug}-${protein} mechanism relevant to ${disease}?`;
  }
  if (role === 'protein') {
    if (persistenceCount >= 3) {
      return `If ${protein} still lacks disease-specific support for ${disease}, which adjacent pathway or substitute target would explain the signal better than the queried protein?`;
    }
    if (persistenceCount === 2) {
      return `Which phenotype, pathway, perturbation, or mechanistic clues link ${protein} to ${disease}?`;
    }
    return `Should the protein-side expert currently vote 1 or 0 for ${protein} being relevant to ${disease}?`;
  }
  if (persistenceCount >= 3) {
    return `If ${disease} still does not implicate ${protein}, should the debate treat the disease side as unresolved and stop preserving the same positive story?`;
  }
  if (persistenceCount === 2) {
    return `Which targets, treatments, biomarkers, or mechanistic clues connect ${disease} to ${protein}?`;
  }
  return `Should the disease-side expert currently vote 1 or 0 for ${protein} being supported by ${disease}?`;
}

function createRoleContradictionQuestion(
  role: (typeof BIOMED_ROLES)[number],
  sample: BiomedTaskSample,
  persistenceCount = 1,
): string {
  const drug = getPrimaryEntity(sample, 'drug') ?? 'the queried drug';
  const protein = getPrimaryEntity(sample, 'protein') ?? 'the queried protein';
  const disease = getPrimaryEntity(sample, 'disease') ?? 'the queried disease';

  if (role === 'drug') {
    return persistenceCount >= 2
      ? `Which specific claims contradict the ${drug}-${protein} mechanism for ${disease}, and do they rule out the current positive hypothesis?`
      : `What evidence contradicts a mechanism or target link between ${drug} and ${protein}?`;
  }
  if (role === 'protein') {
    return persistenceCount >= 2
      ? `Which specific findings argue against ${protein} being disease-relevant for ${disease}, rather than merely under-supported?`
      : `What evidence contradicts ${protein} being disease-relevant for ${disease}?`;
  }
  return persistenceCount >= 2
    ? `Which disease-side findings actively argue against ${protein} as a relevant target for ${disease}?`
    : `What evidence contradicts ${disease} supporting ${protein} as disease-relevant?`;
}

function createCrossAgentMismatchQuestion(
  sample: BiomedTaskSample,
  supportRoles: Array<(typeof BIOMED_ROLES)[number]>,
  persistenceCount = 1,
): string {
  const drug = getPrimaryEntity(sample, 'drug') ?? 'the queried drug';
  const protein = getPrimaryEntity(sample, 'protein') ?? 'the queried protein';
  const disease = getPrimaryEntity(sample, 'disease') ?? 'the queried disease';

  if (persistenceCount >= 3) {
    return `After repeated disagreement, should the debate stop defending the direct ${drug}-${protein}-${disease} triplet and switch to a narrower alternative mechanism?`;
  }
  if (persistenceCount === 2) {
    return `Which missing edge is preventing the ${drug}-${protein}-${disease} triplet from closing, and what additional evidence would make the current positive story convincing?`;
  }
  return 'Why are some experts currently voting 1 while others are voting 0 on the same relationship?';
}

function deriveRoundDisagreements(
  sample: BiomedTaskSample,
  assessments: AgentAssessment[],
  roundNumber: number,
  previousDisagreements: RoundDisagreement[],
): RoundDisagreement[] {
  const disagreements: RoundDisagreement[] = [];
  const previousByFingerprint = new Map(
    previousDisagreements.map((item) => [disagreementFingerprint(item), item]),
  );

  for (const assessment of assessments) {
    if (
      !BIOMED_ROLES.includes(assessment.role as (typeof BIOMED_ROLES)[number])
    ) {
      continue;
    }

    const role = assessment.role as (typeof BIOMED_ROLES)[number];
    const contradictions = assessment.evidenceItems.filter(
      (item) => item.stance === 'contradicts',
    );

    if (assessment.recommendedLabel === 0) {
      const fingerprint = `${role} contradiction::${role}`;
      const previous = previousByFingerprint.get(fingerprint);
      const persistenceCount = (previous?.persistenceCount ?? 0) + 1;
      const disagreement: RoundDisagreement = {
        id: `round-${roundNumber}-${role}-contradiction`,
        roundNumber,
        fingerprint,
        persistenceCount,
        escalationLevel: escalationLevel(persistenceCount),
        title: `${role} contradiction`,
        question: createRoleContradictionQuestion(
          role,
          sample,
          persistenceCount,
        ),
        affectedRoles: [role],
        rationale: `${contradictions.map((item) => item.claim).join(' | ')}${persistenceCount > 1 ? ` Persistent for ${persistenceCount} rounds.` : ''}`,
        triggeringEvidenceIds: contradictions.map((item) => item.id),
        status: 'open',
      };
      disagreement.status = previous !== undefined
        ? 'carried-forward'
        : 'open';
      disagreements.push(disagreement);
      continue;
    }

    if (assessment.recommendedLabel === 1) {
      const fingerprint = `${role} evidence gap::${role}`;
      const previous = previousByFingerprint.get(fingerprint);
      const persistenceCount = (previous?.persistenceCount ?? 0) + 1;
      const disagreement: RoundDisagreement = {
        id: `round-${roundNumber}-${role}-gap`,
        roundNumber,
        fingerprint,
        persistenceCount,
        escalationLevel: escalationLevel(persistenceCount),
        title: `${role} evidence gap`,
        question: createRoleGapQuestion(role, sample, persistenceCount),
        affectedRoles: [role],
        rationale: `${assessment.summary}${persistenceCount > 1 ? ` Persistent for ${persistenceCount} rounds.` : ''}`,
        triggeringEvidenceIds: assessment.evidenceItems.map((item) => item.id),
        status: 'open',
      };
      disagreement.status = previous !== undefined
        ? 'carried-forward'
        : 'open';
      disagreements.push(disagreement);
    }
  }

  const supportRoles = assessments
    .filter((assessment) =>
      BIOMED_ROLES.includes(assessment.role as (typeof BIOMED_ROLES)[number]),
    )
    .filter((assessment) => assessment.recommendedLabel === 1)
    .map((assessment) => assessment.role as (typeof BIOMED_ROLES)[number]);

  if (supportRoles.length > 0 && supportRoles.length < BIOMED_ROLES.length) {
    const fingerprint = 'cross-agent mismatch::disease,drug,protein';
    const previous = previousByFingerprint.get(fingerprint);
    const persistenceCount = (previous?.persistenceCount ?? 0) + 1;
    const disagreement: RoundDisagreement = {
      id: `round-${roundNumber}-cross-agent-mismatch`,
      roundNumber,
      fingerprint,
      persistenceCount,
      escalationLevel: escalationLevel(persistenceCount),
      title: 'cross-agent mismatch',
      question: createCrossAgentMismatchQuestion(
        sample,
        supportRoles,
        persistenceCount,
      ),
      affectedRoles: [...BIOMED_ROLES],
      rationale: `Support appears in roles: ${supportRoles.join(', ')}. Re-check the missing edge instead of repeating the same broad conclusion.${persistenceCount > 1 ? ` Persistent for ${persistenceCount} rounds.` : ''}`,
      triggeringEvidenceIds: assessments.flatMap((assessment) =>
        assessment.evidenceItems
          .filter((item) => item.stance !== 'supports')
          .map((item) => item.id),
      ),
      status: 'open',
    };
    disagreement.status = previous !== undefined
      ? 'carried-forward'
      : 'open';
    disagreements.push(disagreement);
  }

  return disagreements;
}

function createRoundSummary(
  roundNumber: number,
  assessments: AgentAssessment[],
  disagreements: RoundDisagreement[],
): string {
  const supports = assessments.reduce(
    (count, assessment) =>
      count +
      assessment.evidenceItems.filter((item) => item.stance === 'supports')
        .length,
    0,
  );
  const contradictions = assessments.reduce(
    (count, assessment) =>
      count +
      assessment.evidenceItems.filter((item) => item.stance === 'contradicts')
        .length,
    0,
  );

  return `Round ${roundNumber}: supports=${supports}, contradictions=${contradictions}, unresolved_disagreements=${disagreements.length}.`;
}

function hypothesisFocusText(hypothesis: HypothesisRecord): string {
  const checks = hypothesis.requiredChecks.slice(0, 2).join(' | ');
  return checks
    ? `${hypothesis.statement} Checks: ${checks}.`
    : hypothesis.statement;
}

function roleKeyword(role: (typeof ALL_AGENT_ROLES)[number]): string {
  if (role === 'drug') {
    return 'drug';
  }
  if (role === 'protein') {
    return 'protein';
  }
  if (role === 'disease') {
    return 'disease';
  }
  return 'mechanism';
}

function selectActiveHypotheses(
  hypotheses: HypothesisRecord[],
  role: (typeof ALL_AGENT_ROLES)[number],
  currentDisagreements: RoundDisagreement[],
): HypothesisRecord[] {
  const candidates = hypotheses.filter((item) => {
    if (!item.frontier) {
      return false;
    }
    if (!item.targetedRoles || item.targetedRoles.length === 0) {
      return true;
    }
    return item.targetedRoles.includes(role);
  });
  const keyword = roleKeyword(role);

  const scored = candidates.map((item) => {
    const haystack = [
      item.statement,
      item.topicKey ?? '',
      item.revisionReason ?? '',
      ...item.requiredChecks,
    ]
      .join(' ')
      .toLowerCase();
    let score = 0;

    score += item.kind === 'alternative-mechanism' ? 8 : 5;
    score += item.depth * 2;

    if (haystack.includes(keyword)) {
      score += 4;
    }

    if (
      item.topicKey &&
      currentDisagreements.some(
        (disagreement) => disagreement.fingerprint === item.topicKey,
      )
    ) {
      score += 6;
    }

    score += Math.min(item.lastUpdatedRound ?? 0, 10) * 0.1;
    return { item, score };
  });

  return scored
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item)
    .slice(0, 3);
}

function buildRoundContext(
  role: (typeof ALL_AGENT_ROLES)[number],
  roundNumber: number,
  maxRounds: number,
  rounds: SampleRoundRecord[],
  unresolvedDisagreements: RoundDisagreement[],
  hypotheses: HypothesisRecord[],
  sharedEvidenceBoard: EvidenceBoard,
  roundObjective: RoundObjective,
): AgentRoundContext {
  const previousRound = rounds.at(-1);
  const contextDisagreements = previousRound?.disagreements ?? [];
  const roleDisagreements =
    role === 'graph'
      ? contextDisagreements
      : contextDisagreements.filter((item) =>
          item.affectedRoles.includes(role),
        );
  const prioritizedDisagreements = [...roleDisagreements].sort(
    (left, right) => right.persistenceCount - left.persistenceCount,
  );
  const activeHypotheses = selectActiveHypotheses(
    hypotheses,
    role,
    prioritizedDisagreements,
  );
  const peerEvidenceItems = collectPeerEvidence(role, rounds);
  const peerEvidenceDigest = dedupeStrings(
    peerEvidenceItems.map(evidenceDigest),
  ).slice(0, 8);
  const positiveEvidenceDigest = dedupeStrings(
    peerEvidenceItems
      .filter((item) => item.stance === 'supports')
      .map(evidenceDigest),
  ).slice(0, 5);
  const negativeEvidenceDigest = dedupeStrings(
    peerEvidenceItems
      .filter((item) => item.stance === 'contradicts')
      .map(evidenceDigest),
  ).slice(0, 5);
  const alternativeMechanismSignals = dedupeStrings([
    ...peerEvidenceItems
      .filter((item) => hasAlternativeMechanismCue(item.claim))
      .map(evidenceDigest),
    ...prioritizedDisagreements
      .filter(
        (item) =>
          hasAlternativeMechanismCue(item.question) ||
          hasAlternativeMechanismCue(item.rationale),
      )
      .map((item) => `${item.title}: ${item.question}`),
    ...activeHypotheses
      .filter(
        (item) =>
          item.kind === 'alternative-mechanism' ||
          hasAlternativeMechanismCue(item.statement) ||
          hasAlternativeMechanismCue(item.revisionReason ?? ''),
      )
      .map((item) => item.statement),
  ]).slice(0, 5);
  const focus = dedupeStrings([
    roundObjective.directive,
    ...prioritizedDisagreements.slice(0, 2).map((item) => item.question),
    ...activeHypotheses.flatMap((item) => item.requiredChecks.slice(0, 1)),
  ]).slice(0, 3);

  return {
    roundNumber,
    maxRounds,
    focus,
    disagreements: prioritizedDisagreements,
    sharedEvidenceBoard,
    roundObjective,
    peerAssessmentSummaries:
      previousRound?.assessments
        .filter((assessment) => assessment.role !== role)
        .map(summarizePeerAssessment)
        .slice(0, 8) ?? [],
    peerEvidenceDigest,
    positiveEvidenceDigest,
    negativeEvidenceDigest,
    alternativeMechanismSignals,
    hypothesisFocus: activeHypotheses.map(hypothesisFocusText),
    activeHypothesisIds: activeHypotheses.map((item) => item.id),
  };
}

function hasAgentConsensus(assessments: AgentAssessment[]): boolean {
  if (assessments.length !== ALL_AGENT_ROLES.length) {
    return false;
  }

  const firstLabel = assessments[0]?.recommendedLabel;
  if (firstLabel === undefined) {
    return false;
  }

  return assessments.every(
    (assessment) => assessment.recommendedLabel === firstLabel,
  );
}

function shouldContinue(
  roundNumber: number,
  maxRounds: number,
  assessments: AgentAssessment[],
  current: RoundDisagreement[],
  hypotheses: HypothesisRecord[],
): boolean {
  const unresolvedFrontier = hypotheses.some(
    (hypothesis) =>
      hypothesis.frontier &&
      (hypothesis.status === 'open' || hypothesis.status === 'insufficient'),
  );

  if (roundNumber >= maxRounds) {
    return false;
  }

  if (hasAgentConsensus(assessments)) {
    return false;
  }

  if (current.length === 0 && !unresolvedFrontier) {
    return false;
  }

  return true;
}

export interface WorkflowDependencies {
  traceWriter?: TraceWriter;
  taskLoader?: TaskLoader;
  toolAdapter?: ResearchToolAdapter;
}

export class BiomedWorkflowRunner {
  private readonly config: BiomedWorkflowConfig;
  private readonly traceWriter: TraceWriter;
  private readonly taskLoader: TaskLoader;
  private readonly toolAdapter: ResearchToolAdapter;

  constructor(
    config: Partial<BiomedWorkflowConfig> = {},
    deps: WorkflowDependencies = {},
  ) {
    this.config = { ...DEFAULT_BIOMED_CONFIG, ...config };
    this.traceWriter = deps.traceWriter ?? new NoopTraceWriter();
    this.taskLoader =
      deps.taskLoader ??
      new CsvTaskLoader({
        dataDir: this.config.dataDir,
        relationshipType: this.config.relationshipType,
      });
    this.toolAdapter =
      deps.toolAdapter ?? new PythonResearchToolAdapter(this.config);
  }

  async loadSamples(limit?: number): Promise<BiomedTaskSample[]> {
    return this.taskLoader.loadSamples(limit);
  }

  async runLoadedSamples(limit?: number): Promise<WorkflowResult[]> {
    const samples = await this.loadSamples(limit);
    const results: WorkflowResult[] = [];
    for (const sample of samples) {
      results.push(await this.runSample(sample));
    }
    return results;
  }

  async runSample(sample: BiomedTaskSample): Promise<WorkflowResult> {
    let state = createHypothesisState(generateInitialHypotheses(sample));

    const drugAgent = new DrugAgent(this.toolAdapter);
    const proteinAgent = new ProteinAgent(this.toolAdapter);
    const diseaseAgent = new DiseaseAgent(this.toolAdapter);
    const graphAgent = new GraphAgent(
      new LocalGraphTool(
        this.config.graphDataDir,
        this.config.relationshipType,
      ),
      this.toolAdapter,
    );
    const arbiter = new Arbiter();

    let latestAssessments: AgentAssessment[] = [];
    for (
      let roundNumber = 1;
      roundNumber <= this.config.maxRounds;
      roundNumber++
    ) {
      const previousRound = state.rounds.at(-1);
      const sharedEvidenceBoard = buildSharedEvidenceBoard(
        previousRound,
        state.unresolvedDisagreements,
      );
      const roundObjective = buildRoundObjective(
        roundNumber,
        sharedEvidenceBoard,
      );
      const drugAssessment = await drugAgent.assess(
        sample,
        state.hypotheses,
        buildRoundContext(
          'drug',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
          state.hypotheses,
          sharedEvidenceBoard,
          roundObjective,
        ),
      );
      const proteinAssessment = await proteinAgent.assess(
        sample,
        state.hypotheses,
        buildRoundContext(
          'protein',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
          state.hypotheses,
          sharedEvidenceBoard,
          roundObjective,
        ),
      );
      const diseaseAssessment = await diseaseAgent.assess(
        sample,
        state.hypotheses,
        buildRoundContext(
          'disease',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
          state.hypotheses,
          sharedEvidenceBoard,
          roundObjective,
        ),
      );
      const graphAssessment = await graphAgent.assess(
        sample,
        state.hypotheses,
        buildRoundContext(
          'graph',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
          state.hypotheses,
          sharedEvidenceBoard,
          roundObjective,
        ),
      );

      latestAssessments = [
        drugAssessment,
        proteinAssessment,
        diseaseAssessment,
        graphAssessment,
      ];
      const disagreements = deriveRoundDisagreements(
        sample,
        latestAssessments,
        roundNumber,
        state.unresolvedDisagreements,
      );
      const round: SampleRoundRecord = {
        roundNumber,
        focus: disagreements.map((item) => item.question),
        disagreements,
        sharedEvidenceBoard,
        roundObjective,
        assessments: latestAssessments,
        evidenceItems: latestAssessments.flatMap(
          (assessment) => assessment.evidenceItems,
        ),
        hypothesisSnapshot: state.hypotheses.map((item) => ({ ...item })),
        summary: createRoundSummary(
          roundNumber,
          latestAssessments,
          disagreements,
        ),
      };
      state = advanceHypothesisState(state, round, this.config.maxRounds);

      if (
        !shouldContinue(
          roundNumber,
          this.config.maxRounds,
          latestAssessments,
          state.unresolvedDisagreements,
          state.hypotheses,
        )
      ) {
        break;
      }
    }

    const arbiterResult = await arbiter.decide({
      sample,
      hypotheses: state.hypotheses,
      assessments: latestAssessments,
      rounds: state.rounds,
    });
    const finalAssessments = [...latestAssessments, arbiterResult.assessment];
    const finalEvidenceItems = finalAssessments.flatMap(
      (assessment) => assessment.evidenceItems,
    );

    const trace: SampleTraceRecord = {
      sampleIndex: sample.sampleIndex,
      relationshipType: sample.relationshipType,
      entityDict: sample.entityDict,
      groundTruth: sample.groundTruth,
      hypotheses: state.hypotheses,
      rounds: state.rounds,
      assessments: finalAssessments,
      evidenceItems: finalEvidenceItems,
      decision: arbiterResult.decision,
    };

    if (this.config.writeTrace) {
      await this.traceWriter.writeTrace(trace);
    }

    return { trace, decision: arbiterResult.decision };
  }
}
