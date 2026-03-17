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
import { OpenRouterExpertJudge } from './tools/expert-judge.js';
import { LocalGraphTool } from './tools/local-graph-tool.js';
import { PythonResearchToolAdapter } from './tools/python-researcher-adapter.js';
import {
  AgentAssessment,
  AgentRoundContext,
  BiomedTaskSample,
  ExpertJudge,
  ResearchToolAdapter,
  RoundDisagreement,
  SampleTraceRecord,
  SampleRoundRecord,
  WorkflowResult,
} from './types.js';

const BIOMED_ROLES = ['drug', 'protein', 'disease'] as const;
const ALL_AGENT_ROLES = ['drug', 'protein', 'disease', 'graph'] as const;

function getPrimaryEntity(
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

function disagreementFingerprint(item: RoundDisagreement): string {
  return [item.title, item.question, [...item.affectedRoles].sort().join(',')].join(
    '::',
  );
}

function createRoleGapQuestion(
  role: (typeof BIOMED_ROLES)[number],
  sample: BiomedTaskSample,
): string {
  const drug = getPrimaryEntity(sample, 'drug') ?? 'the queried drug';
  const protein = getPrimaryEntity(sample, 'protein') ?? 'the queried protein';
  const disease = getPrimaryEntity(sample, 'disease') ?? 'the queried disease';

  if (role === 'drug') {
    return `Does ${drug} have a direct mechanism or target link to ${protein}, rather than only disease indication context?`;
  }
  if (role === 'protein') {
    return `Does ${protein} have disease-specific relevance for ${disease}, rather than only general biology?`;
  }
  return `Does ${disease} explicitly support ${protein} as disease-relevant, rather than only generic background or treatment context?`;
}

function deriveRoundDisagreements(
  sample: BiomedTaskSample,
  assessments: AgentAssessment[],
  roundNumber: number,
  previousDisagreements: RoundDisagreement[],
): RoundDisagreement[] {
  const disagreements: RoundDisagreement[] = [];
  const previousFingerprints = new Set(
    previousDisagreements.map(disagreementFingerprint),
  );

  for (const assessment of assessments) {
    if (!BIOMED_ROLES.includes(assessment.role as (typeof BIOMED_ROLES)[number])) {
      continue;
    }

    const role = assessment.role as (typeof BIOMED_ROLES)[number];
    const supports = assessment.evidenceItems.filter(
      (item) => item.stance === 'supports',
    );
    const contradictions = assessment.evidenceItems.filter(
      (item) => item.stance === 'contradicts',
    );

    if (contradictions.length > 0) {
      const disagreement: RoundDisagreement = {
        id: `round-${roundNumber}-${role}-contradiction`,
        roundNumber,
        title: `${role} contradiction`,
        question: createRoleGapQuestion(role, sample),
        affectedRoles: [role],
        rationale: contradictions.map((item) => item.claim).join(' | '),
        triggeringEvidenceIds: contradictions.map((item) => item.id),
        status: 'open',
      };
      disagreement.status = previousFingerprints.has(
        disagreementFingerprint(disagreement),
      )
        ? 'carried-forward'
        : 'open';
      disagreements.push(disagreement);
      continue;
    }

    if (supports.length === 0) {
      const disagreement: RoundDisagreement = {
        id: `round-${roundNumber}-${role}-gap`,
        roundNumber,
        title: `${role} evidence gap`,
        question: createRoleGapQuestion(role, sample),
        affectedRoles: [role],
        rationale: assessment.summary,
        triggeringEvidenceIds: assessment.evidenceItems.map((item) => item.id),
        status: 'open',
      };
      disagreement.status = previousFingerprints.has(
        disagreementFingerprint(disagreement),
      )
        ? 'carried-forward'
        : 'open';
      disagreements.push(disagreement);
    }
  }

  const supportRoles = assessments
    .filter((assessment) =>
      BIOMED_ROLES.includes(assessment.role as (typeof BIOMED_ROLES)[number]),
    )
    .filter((assessment) =>
      assessment.evidenceItems.some((item) => item.stance === 'supports'),
    )
    .map((assessment) => assessment.role as (typeof BIOMED_ROLES)[number]);

  if (supportRoles.length > 0 && supportRoles.length < BIOMED_ROLES.length) {
    const disagreement: RoundDisagreement = {
      id: `round-${roundNumber}-cross-agent-mismatch`,
      roundNumber,
      title: 'cross-agent mismatch',
      question:
        'Why do some experts support the relationship while others still have missing or contradictory evidence?',
      affectedRoles: [...BIOMED_ROLES],
      rationale: `Support appears in roles: ${supportRoles.join(', ')}. Re-check the missing edge instead of repeating the same broad conclusion.`,
      triggeringEvidenceIds: assessments.flatMap((assessment) =>
        assessment.evidenceItems
          .filter((item) => item.stance !== 'supports')
          .map((item) => item.id),
      ),
      status: 'open',
    };
    disagreement.status = previousFingerprints.has(
      disagreementFingerprint(disagreement),
    )
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

function buildRoundContext(
  role: (typeof ALL_AGENT_ROLES)[number],
  roundNumber: number,
  maxRounds: number,
  rounds: SampleRoundRecord[],
  unresolvedDisagreements: RoundDisagreement[],
): AgentRoundContext {
  const roleDisagreements =
    role === 'graph'
      ? unresolvedDisagreements
      : unresolvedDisagreements.filter((item) => item.affectedRoles.includes(role));
  const previousRound = rounds.at(-1);

  return {
    roundNumber,
    maxRounds,
    focus: roleDisagreements.map((item) => item.question),
    disagreements: roleDisagreements,
    priorRoundSummaries: rounds
      .slice(-2)
      .map((round) => `Round ${round.roundNumber}: ${round.summary}`),
    peerAssessmentSummaries:
      previousRound?.assessments
        .filter((assessment) => assessment.role !== role)
        .map((assessment) => `${assessment.role}: ${assessment.summary}`) ?? [],
  };
}

function shouldContinue(
  roundNumber: number,
  maxRounds: number,
  current: RoundDisagreement[],
): boolean {
  if (roundNumber >= maxRounds || current.length === 0) {
    return false;
  }

  return true;
}

export interface WorkflowDependencies {
  traceWriter?: TraceWriter;
  taskLoader?: TaskLoader;
  toolAdapter?: ResearchToolAdapter;
  expertJudge?: ExpertJudge;
}

export class BiomedWorkflowRunner {
  private readonly config: BiomedWorkflowConfig;
  private readonly traceWriter: TraceWriter;
  private readonly taskLoader: TaskLoader;
  private readonly toolAdapter: ResearchToolAdapter;
  private readonly expertJudge: ExpertJudge | null;

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
    this.expertJudge = this.config.enableExpertJudge
      ? (deps.expertJudge ?? new OpenRouterExpertJudge(this.config))
      : null;
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
    const hypotheses = generateInitialHypotheses(sample);
    let state = createHypothesisState(hypotheses);

    const drugAgent = new DrugAgent(this.toolAdapter, this.expertJudge);
    const proteinAgent = new ProteinAgent(this.toolAdapter, this.expertJudge);
    const diseaseAgent = new DiseaseAgent(this.toolAdapter, this.expertJudge);
    const graphAgent = new GraphAgent(
      new LocalGraphTool(
        this.config.graphDataDir,
        this.config.relationshipType,
      ),
    );
    const arbiter = new Arbiter();

    let latestAssessments: AgentAssessment[] = [];
    for (let roundNumber = 1; roundNumber <= this.config.maxRounds; roundNumber++) {
      const drugAssessment = await drugAgent.assess(
        sample,
        hypotheses,
        buildRoundContext(
          'drug',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
        ),
      );
      const proteinAssessment = await proteinAgent.assess(
        sample,
        hypotheses,
        buildRoundContext(
          'protein',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
        ),
      );
      const diseaseAssessment = await diseaseAgent.assess(
        sample,
        hypotheses,
        buildRoundContext(
          'disease',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
        ),
      );
      const graphAssessment = await graphAgent.assess(
        sample,
        hypotheses,
        buildRoundContext(
          'graph',
          roundNumber,
          this.config.maxRounds,
          state.rounds,
          state.unresolvedDisagreements,
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
        assessments: latestAssessments,
        evidenceItems: latestAssessments.flatMap(
          (assessment) => assessment.evidenceItems,
        ),
        summary: createRoundSummary(roundNumber, latestAssessments, disagreements),
      };
      state = advanceHypothesisState(state, round);

      if (
        !shouldContinue(
          roundNumber,
          this.config.maxRounds,
          disagreements,
        )
      ) {
        break;
      }
    }

    const decision = arbiter.decide({
      sample,
      hypotheses,
      assessments: latestAssessments,
      config: this.config,
    });

    const trace: SampleTraceRecord = {
      sampleIndex: sample.sampleIndex,
      relationshipType: sample.relationshipType,
      entityDict: sample.entityDict,
      groundTruth: sample.groundTruth,
      hypotheses,
      rounds: state.rounds,
      assessments: latestAssessments,
      evidenceItems: latestAssessments.flatMap(
        (assessment) => assessment.evidenceItems,
      ),
      decision,
    };

    if (this.config.writeTrace) {
      await this.traceWriter.writeTrace(trace);
    }

    return { trace, decision };
  }
}
