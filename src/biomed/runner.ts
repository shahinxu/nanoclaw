import { DEFAULT_BIOMED_CONFIG, type BiomedWorkflowConfig } from './config.js';
import { DrugAgent } from './agents/drug-agent.js';
import { ProteinAgent } from './agents/protein-agent.js';
import { DiseaseAgent } from './agents/disease-agent.js';
import { Arbiter } from './agents/arbiter.js';
import { generateInitialHypotheses } from './hypotheses/generator.js';
import { NoopTraceWriter, type TraceWriter } from './trace-writer.js';
import { CsvTaskLoader, type TaskLoader } from './task-loader.js';
import { OpenRouterExpertJudge } from './tools/expert-judge.js';
import { PythonResearchToolAdapter } from './tools/python-researcher-adapter.js';
import {
  BiomedTaskSample,
  ExpertJudge,
  ResearchToolAdapter,
  SampleTraceRecord,
  WorkflowResult,
} from './types.js';

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

    const drugAgent = new DrugAgent(this.toolAdapter, this.expertJudge);
    const proteinAgent = new ProteinAgent(this.toolAdapter, this.expertJudge);
    const diseaseAgent = new DiseaseAgent(this.toolAdapter, this.expertJudge);
    const arbiter = new Arbiter();

    const drugAssessment = await drugAgent.assess(sample, hypotheses);
    const proteinAssessment = await proteinAgent.assess(sample, hypotheses);
    const diseaseAssessment = await diseaseAgent.assess(sample, hypotheses);

    const decision = arbiter.decide({
      sample,
      hypotheses,
      assessments: [drugAssessment, proteinAssessment, diseaseAssessment],
      config: this.config,
    });

    const trace: SampleTraceRecord = {
      sampleIndex: sample.sampleIndex,
      relationshipType: sample.relationshipType,
      entityDict: sample.entityDict,
      groundTruth: sample.groundTruth,
      hypotheses,
      assessments: [drugAssessment, proteinAssessment, diseaseAssessment],
      evidenceItems: [
        ...drugAssessment.evidenceItems,
        ...proteinAssessment.evidenceItems,
        ...diseaseAssessment.evidenceItems,
      ],
      decision,
    };

    if (this.config.writeTrace) {
      await this.traceWriter.writeTrace(trace);
    }

    return { trace, decision };
  }
}
