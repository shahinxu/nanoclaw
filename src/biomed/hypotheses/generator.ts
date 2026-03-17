import { BiomedTaskSample, HypothesisRecord } from '../types.js';

export function generateInitialHypotheses(
  sample: BiomedTaskSample,
): HypothesisRecord[] {
  return [
    {
      id: `H-positive-${sample.sampleIndex}`,
      statement: 'The queried drug-protein-disease relationship exists.',
      kind: 'positive',
      status: 'open',
      requiredChecks: [
        'drug-protein evidence',
        'protein-disease evidence',
        'mechanism consistency',
      ],
      evidenceFor: [],
      evidenceAgainst: [],
      confidence: 0,
    },
    {
      id: `H-negative-${sample.sampleIndex}`,
      statement:
        'The queried drug-protein-disease relationship is unsupported or false.',
      kind: 'negative',
      status: 'open',
      requiredChecks: ['missing direct support', 'contradictory mechanism'],
      evidenceFor: [],
      evidenceAgainst: [],
      confidence: 0,
    },
  ];
}
