export type BiomedLabel = 0 | 1;

export type BiomedEntityValue = string | string[];

export interface BiomedTaskSample {
  sampleIndex: number;
  relationshipType: string;
  entityDict: Record<string, BiomedEntityValue>;
  groundTruth?: BiomedLabel;
}

export type HypothesisKind =
  | 'positive'
  | 'negative'
  | 'alternative-mechanism';

export type HypothesisStatus =
  | 'open'
  | 'supported'
  | 'refuted'
  | 'insufficient';

export interface HypothesisRecord {
  id: string;
  statement: string;
  kind: HypothesisKind;
  status: HypothesisStatus;
  requiredChecks: string[];
  evidenceFor: string[];
  evidenceAgainst: string[];
  confidence: number;
}

export type EvidenceStance = 'supports' | 'contradicts' | 'insufficient';

export type EvidenceStrength = 'strong' | 'moderate' | 'weak';

export interface EvidenceItem {
  id: string;
  source: string;
  toolName: string;
  entityScope: string[];
  claim: string;
  stance: EvidenceStance;
  strength: EvidenceStrength;
  structured: Record<string, unknown>;
}

export interface PlannerAction {
  hypothesisId: string;
  hypothesisStatement: string;
  verificationGoal: string;
  expectedEvidence: string[];
  failureRule: string;
  toolCalls: PlannedToolCall[];
}

export interface PlannedToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ResearchToolResult {
  toolName: string;
  status: 'ok' | 'error';
  textSummary: string;
  structured: Record<string, unknown> | null;
  error?: string;
}

export interface ResearchToolAdapter {
  callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ResearchToolResult>;
}

export interface ExpertJudgeResult {
  stance: EvidenceStance;
  strength: EvidenceStrength;
  claim: string;
  rawResponse?: string;
}

export interface ExpertJudgeInput {
  agentRole: 'drug' | 'protein' | 'disease';
  sample: BiomedTaskSample;
  hypothesis: HypothesisRecord | undefined;
  toolName: string;
  toolArguments: Record<string, unknown>;
  toolResult: ResearchToolResult;
}

export interface ExpertJudge {
  judge(input: ExpertJudgeInput): Promise<ExpertJudgeResult>;
}

export interface AgentEvaluationTrace {
  id: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  entityScope: string[];
  rawToolOutput: ResearchToolResult;
  judgeOutput: ExpertJudgeResult | null;
  judgeError?: string;
  heuristicOutput: ExpertJudgeResult;
  finalOutput: ExpertJudgeResult;
  finalSource: 'judge' | 'heuristic';
}

export interface AgentAssessment {
  agentId: string;
  role: 'drug' | 'protein' | 'disease' | 'graph' | 'arbiter';
  summary: string;
  hypothesesTouched: string[];
  plannerActions: PlannerAction[];
  evidenceItems: EvidenceItem[];
  evaluationTrace: AgentEvaluationTrace[];
}

export interface DecisionRecord {
  label: BiomedLabel | null;
  confidence: number;
  rationale: string;
  blockingGaps: string[];
  contradictions: string[];
}

export interface SampleTraceRecord {
  sampleIndex: number;
  relationshipType: string;
  entityDict: Record<string, BiomedEntityValue>;
  groundTruth?: BiomedLabel;
  hypotheses: HypothesisRecord[];
  assessments: AgentAssessment[];
  evidenceItems: EvidenceItem[];
  decision: DecisionRecord;
}

export interface WorkflowResult {
  trace: SampleTraceRecord;
  decision: DecisionRecord;
}