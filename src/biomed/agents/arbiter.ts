import { BiomedWorkflowConfig } from '../config.js';
import {
  AgentAssessment,
  BiomedTaskSample,
  DecisionRecord,
  HypothesisRecord,
} from '../types.js';
import { decideLabel } from '../hypotheses/index.js';

export interface ArbiterInput {
  sample: BiomedTaskSample;
  hypotheses: HypothesisRecord[];
  assessments: AgentAssessment[];
  config: BiomedWorkflowConfig;
}

export class Arbiter {
  decide(input: ArbiterInput): DecisionRecord {
    return decideLabel(input);
  }
}