export type BiomedLabel = 0 | 1;

export type BiomedEntityValue = string | string[];

export interface BiomedTaskSample {
  sampleIndex: number;
  relationshipType: string;
  entityDict: Record<string, BiomedEntityValue>;
  groundTruth?: BiomedLabel;
}

export type HypothesisKind = 'positive' | 'negative' | 'alternative-mechanism';

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
  createdRound?: number;
  lastUpdatedRound?: number;
  derivedFromId?: string;
  revisionReason?: string;
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

export interface ResearchReviewContext {
  roundNumber: number;
  focusMode:
    | 'broad'
    | 'mechanism_only'
    | 'disease_alignment'
    | 'target_alignment';
  focalQuestion?: string;
  focus: string[];
  peerFindings: string[];
  hypothesisFocus?: string[];
  activeHypothesisIds?: string[];
  targetDrugId?: string;
  targetProteinId?: string;
  targetDiseaseId?: string;
}

export interface ResearchToolAdapter {
  callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ResearchToolResult>;
}

export interface AgentEvaluationTrace {
  id: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  entityScope: string[];
  rawToolOutput: ResearchToolResult;
  interpretedOutput: {
    stance: EvidenceStance;
    strength: EvidenceStrength;
    claim: string;
  };
}

export interface RoundDisagreement {
  id: string;
  roundNumber: number;
  title: string;
  question: string;
  affectedRoles: Array<'drug' | 'protein' | 'disease'>;
  rationale: string;
  triggeringEvidenceIds: string[];
  status: 'open' | 'carried-forward' | 'resolved';
}

export interface AgentRoundContext {
  roundNumber: number;
  maxRounds: number;
  focus: string[];
  disagreements: RoundDisagreement[];
  priorRoundSummaries: string[];
  peerAssessmentSummaries: string[];
  hypothesisFocus: string[];
  activeHypothesisIds: string[];
}

export interface AgentAssessment {
  agentId: string;
  role: 'drug' | 'protein' | 'disease' | 'graph' | 'arbiter';
  roundNumber: number;
  summary: string;
  hypothesesTouched: string[];
  plannerActions: PlannerAction[];
  evidenceItems: EvidenceItem[];
  evaluationTrace: AgentEvaluationTrace[];
}

export interface DecisionRecord {
  status: 'supported' | 'refuted' | 'insufficient';
  decisionMode: 'settled' | 'best-effort-insufficient';
  label: BiomedLabel;
  confidence: number;
  rationale: string;
  blockingGaps: string[];
  contradictions: string[];
}

export interface SampleRoundRecord {
  roundNumber: number;
  focus: string[];
  disagreements: RoundDisagreement[];
  assessments: AgentAssessment[];
  evidenceItems: EvidenceItem[];
  hypothesisSnapshot: HypothesisRecord[];
  summary: string;
}

export interface SampleTraceRecord {
  sampleIndex: number;
  relationshipType: string;
  entityDict: Record<string, BiomedEntityValue>;
  groundTruth?: BiomedLabel;
  hypotheses: HypothesisRecord[];
  rounds: SampleRoundRecord[];
  assessments: AgentAssessment[];
  evidenceItems: EvidenceItem[];
  decision: DecisionRecord;
}

export interface WorkflowResult {
  trace: SampleTraceRecord;
  decision: DecisionRecord;
}
