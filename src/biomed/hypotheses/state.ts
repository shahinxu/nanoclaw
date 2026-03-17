import {
  HypothesisRecord,
  RoundDisagreement,
  SampleRoundRecord,
} from '../types.js';

export interface HypothesisState {
  hypotheses: HypothesisRecord[];
  rounds: SampleRoundRecord[];
  unresolvedDisagreements: RoundDisagreement[];
}

export function createHypothesisState(
  hypotheses: HypothesisRecord[] = [],
): HypothesisState {
  return {
    hypotheses,
    rounds: [],
    unresolvedDisagreements: [],
  };
}

export function advanceHypothesisState(
  state: HypothesisState,
  round: SampleRoundRecord,
): HypothesisState {
  return {
    hypotheses: state.hypotheses,
    rounds: [...state.rounds, round],
    unresolvedDisagreements: round.disagreements.filter(
      (item) => item.status !== 'resolved',
    ),
  };
}
