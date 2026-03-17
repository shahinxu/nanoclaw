import { HypothesisRecord } from '../types.js';

export interface HypothesisState {
  hypotheses: HypothesisRecord[];
}

export function createHypothesisState(
  hypotheses: HypothesisRecord[] = [],
): HypothesisState {
  return { hypotheses };
}