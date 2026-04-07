import { BiomedTaskSample, HypothesisRecord, ResearchToolAdapter } from '../types.js';

type HypothesisTargetRole =
  | 'drug'
  | 'protein'
  | 'disease'
  | 'sideeffect'
  | 'cellline'
  | 'graph';

function parseRoleList(value: unknown): HypothesisTargetRole[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set([
    'drug',
    'protein',
    'disease',
    'sideeffect',
    'cellline',
    'graph',
  ]);
  return [...new Set(
    value
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item): item is HypothesisTargetRole =>
        allowed.has(item),
      ),
  )];
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0);
}

export async function generateInitialHypotheses(
  sample: BiomedTaskSample,
  toolAdapter: ResearchToolAdapter,
): Promise<HypothesisRecord[]> {
  const result = await toolAdapter.callTool('hypothesis_generator', {
    sample: {
      sampleIndex: sample.sampleIndex,
      relationshipType: sample.relationshipType,
      entityDict: sample.entityDict,
    },
  });

  if (result.status !== 'ok') {
    throw new Error(
      `hypothesis_generator failed for sample ${sample.sampleIndex}: ${result.error ?? 'unknown error'}`,
    );
  }
  if (!result.structured) {
    throw new Error(
      `hypothesis_generator returned empty structured payload for sample ${sample.sampleIndex}`,
    );
  }

  const positiveRootStatement = String(
    result.structured.positive_root_statement ?? '',
  ).trim();
  const negativeRootStatement = String(
    result.structured.negative_root_statement ?? '',
  ).trim();
  const criteriaRaw = result.structured.criteria;

  if (!positiveRootStatement || !negativeRootStatement) {
    throw new Error(
      `hypothesis_generator returned invalid root statements for sample ${sample.sampleIndex}`,
    );
  }
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length < 3) {
    throw new Error(
      `hypothesis_generator must return at least 3 criteria for sample ${sample.sampleIndex}`,
    );
  }

  const positiveRootId = `H-positive-${sample.sampleIndex}`;
  const negativeRootId = `H-negative-${sample.sampleIndex}`;

  const criteria: HypothesisRecord[] = criteriaRaw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(
        `hypothesis_generator criterion ${index} is not an object for sample ${sample.sampleIndex}`,
      );
    }
    const payload = item as Record<string, unknown>;
    const statement = String(payload.statement ?? '').trim();
    const topicKey = String(payload.topic_key ?? `criterion.generated-${index + 1}`).trim();
    const targetedRoles = parseRoleList(payload.targeted_roles);
    const requiredChecks = parseStringList(payload.required_checks);

    if (!statement) {
      throw new Error(
        `hypothesis_generator criterion ${index} has empty statement for sample ${sample.sampleIndex}`,
      );
    }
    if (targetedRoles.length === 0) {
      throw new Error(
        `hypothesis_generator criterion ${index} has no valid targeted_roles for sample ${sample.sampleIndex}`,
      );
    }
    if (requiredChecks.length === 0) {
      throw new Error(
        `hypothesis_generator criterion ${index} has no required_checks for sample ${sample.sampleIndex}`,
      );
    }

    return {
      id: `H-criterion-${index + 1}-${sample.sampleIndex}`,
      statement,
      kind: 'criterion',
      status: 'open',
      topicKey,
      parentId: positiveRootId,
      childIds: [],
      depth: 1,
      frontier: true,
      dependencyMode: 'any',
      targetedRoles,
      requiredChecks,
      evidenceFor: [],
      evidenceAgainst: [],
      confidence: 0,
      createdRound: 0,
      lastUpdatedRound: 0,
    };
  });

  return [
    {
      id: positiveRootId,
      statement: positiveRootStatement,
      kind: 'positive',
      status: 'open',
      topicKey: 'root-positive',
      childIds: criteria.map((item) => item.id),
      depth: 0,
      frontier: false,
      dependencyMode: 'all',
      requiredChecks: ['resolve all positive child hypotheses'],
      evidenceFor: [],
      evidenceAgainst: [],
      confidence: 0,
      createdRound: 0,
      lastUpdatedRound: 0,
    },
    {
      id: negativeRootId,
      statement: negativeRootStatement,
      kind: 'negative',
      status: 'open',
      topicKey: 'root-negative',
      childIds: [],
      depth: 0,
      frontier: false,
      dependencyMode: 'all',
      requiredChecks: [
        'evaluate the positive root before settling the negative root',
      ],
      evidenceFor: [],
      evidenceAgainst: [],
      confidence: 0,
      createdRound: 0,
      lastUpdatedRound: 0,
    },
    ...criteria,
  ];
}
