import {
  EvidenceItem,
  HypothesisRecord,
  RoundDisagreement,
  SampleRoundRecord,
} from '../types.js';
import { SOURCE_BY_ROLE } from '../agent-constants.js';

export interface HypothesisState {
  hypotheses: HypothesisRecord[];
  rounds: SampleRoundRecord[];
  unresolvedDisagreements: RoundDisagreement[];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function summarizeSupports(evidenceItems: EvidenceItem[]): string[] {
  return evidenceItems
    .filter((item) => item.stance === 'supports')
    .map((item) => item.claim);
}

function summarizeContradictions(evidenceItems: EvidenceItem[]): string[] {
  return evidenceItems
    .filter((item) => item.stance === 'contradicts')
    .map((item) => item.claim);
}

function getHypothesisMap(
  hypotheses: HypothesisRecord[],
): Map<string, HypothesisRecord> {
  return new Map(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
}

function isLeaf(hypothesis: HypothesisRecord): boolean {
  return hypothesis.childIds.length === 0;
}

function baseBranchTopic(disagreement: RoundDisagreement): string {
  if (disagreement.title.startsWith('drug ')) {
    return 'criterion.drug-target';
  }
  if (disagreement.title.startsWith('protein ')) {
    return 'criterion.protein-disease';
  }
  if (disagreement.title.startsWith('disease ')) {
    return 'criterion.disease-target';
  }
  return 'criterion.graph-specificity';
}

function roleForBranchTopic(
  topicKey: string | undefined,
): HypothesisRecord['targetedRoles'] {
  if (!topicKey) {
    return ['drug', 'protein', 'disease', 'graph'];
  }
  if (topicKey.startsWith('criterion.drug-target')) {
    return ['drug'];
  }
  if (topicKey.startsWith('criterion.protein-disease')) {
    return ['protein'];
  }
  if (topicKey.startsWith('criterion.disease-target')) {
    return ['disease'];
  }
  if (topicKey.startsWith('criterion.graph-specificity')) {
    return ['graph'];
  }
  return ['drug', 'protein', 'disease', 'graph'];
}

function findRelatedDisagreement(
  round: SampleRoundRecord,
  hypothesis: HypothesisRecord,
): RoundDisagreement | undefined {
  if (!hypothesis.topicKey) {
    return undefined;
  }
  const baseTopic = hypothesis.topicKey.split('>')[0];
  return round.disagreements.find(
    (disagreement) => baseBranchTopic(disagreement) === baseTopic,
  );
}

function collectRelevantEvidence(
  round: SampleRoundRecord,
  hypothesis: HypothesisRecord,
): EvidenceItem[] {
  const targetedRoles = hypothesis.targetedRoles ??
    roleForBranchTopic(hypothesis.topicKey) ?? [
      'drug',
      'protein',
      'disease',
      'graph',
    ];
  const sources = new Set(
    targetedRoles
      .map((role) => SOURCE_BY_ROLE[role])
      .filter((value): value is string => Boolean(value)),
  );

  return round.evidenceItems.filter((item) => sources.has(item.source));
}

function summarizeEvidenceStrength(evidenceItems: EvidenceItem[]): {
  nonWeakSupports: EvidenceItem[];
  weakSupports: EvidenceItem[];
  contradictions: EvidenceItem[];
  supportsByRole: Record<string, number>;
} {
  const nonWeakSupports = evidenceItems.filter(
    (item) => item.stance === 'supports' && item.strength !== 'weak',
  );
  const weakSupports = evidenceItems.filter(
    (item) => item.stance === 'supports' && item.strength === 'weak',
  );
  const contradictions = evidenceItems.filter(
    (item) => item.stance === 'contradicts',
  );
  const supportsByRole = evidenceItems.reduce<Record<string, number>>(
    (accumulator, item) => {
      if (item.stance !== 'supports') {
        return accumulator;
      }
      accumulator[item.source] = (accumulator[item.source] ?? 0) + 1;
      return accumulator;
    },
    {},
  );

  return { nonWeakSupports, weakSupports, contradictions, supportsByRole };
}

function distinctSourceCount(evidenceItems: EvidenceItem[]): number {
  return new Set(evidenceItems.map((item) => item.source)).size;
}

function collectDiscussionSignals(
  round: SampleRoundRecord,
  hypothesis: HypothesisRecord,
): {
  relevantEvidence: EvidenceItem[];
  peerEvidence: EvidenceItem[];
  relevant: ReturnType<typeof summarizeEvidenceStrength>;
  peer: ReturnType<typeof summarizeEvidenceStrength>;
  global: ReturnType<typeof summarizeEvidenceStrength>;
} {
  const relevantEvidence = collectRelevantEvidence(round, hypothesis);
  const relevantSources = new Set(relevantEvidence.map((item) => item.source));
  const peerEvidence = round.evidenceItems.filter(
    (item) => !relevantSources.has(item.source),
  );

  return {
    relevantEvidence,
    peerEvidence,
    relevant: summarizeEvidenceStrength(relevantEvidence),
    peer: summarizeEvidenceStrength(peerEvidence),
    global: summarizeEvidenceStrength(round.evidenceItems),
  };
}

function localVoteStatus(
  supportedCount: number,
  refutedCount: number,
): 'supported' | 'refuted' | 'insufficient' {
  if (supportedCount === 0 && refutedCount === 0) {
    return 'insufficient';
  }
  if (supportedCount > refutedCount) {
    return 'supported';
  }
  if (refutedCount > supportedCount) {
    return 'refuted';
  }
  return 'insufficient';
}

function evaluateFrontierHypothesis(
  hypothesis: HypothesisRecord,
  round: SampleRoundRecord,
  maxRounds: number,
): Pick<
  HypothesisRecord,
  'status' | 'confidence' | 'evidenceFor' | 'evidenceAgainst'
> {
  const { relevantEvidence, peerEvidence, relevant, peer, global } =
    collectDiscussionSignals(round, hypothesis);
  const { nonWeakSupports, weakSupports, contradictions, supportsByRole } =
    relevant;
  const relatedDisagreement = findRelatedDisagreement(round, hypothesis);
  const persistenceCount = relatedDisagreement?.persistenceCount ?? 0;
  const targetedSupportRoleCount = distinctSourceCount([
    ...nonWeakSupports,
    ...weakSupports,
  ]);
  const peerSupportRoleCount = distinctSourceCount([
    ...peer.nonWeakSupports,
    ...peer.weakSupports,
  ]);
  const evidenceFor = dedupe([
    ...summarizeSupports(relevantEvidence),
    ...summarizeSupports(peerEvidence).slice(0, 2),
  ]);
  const evidenceAgainst = dedupe(summarizeContradictions(relevantEvidence));

  if (
    contradictions.length > 0 &&
    nonWeakSupports.length === 0 &&
    peerSupportRoleCount === 0 &&
    (persistenceCount >= 2 || maxRounds <= round.roundNumber)
  ) {
    return {
      status: 'refuted',
      confidence: 0.7,
      evidenceFor,
      evidenceAgainst,
    };
  }

  if (nonWeakSupports.length > 0) {
    return {
      status: 'supported',
      confidence: 0.6 + Math.min(nonWeakSupports.length, 2) * 0.08,
      evidenceFor,
      evidenceAgainst,
    };
  }

  if (
    contradictions.length > 0 &&
    peerSupportRoleCount > 0 &&
    maxRounds > round.roundNumber
  ) {
    return {
      status: 'insufficient',
      confidence: 0.34,
      evidenceFor,
      evidenceAgainst: dedupe([
        ...evidenceAgainst,
        ...summarizeContradictions(peerEvidence).slice(0, 1),
      ]),
    };
  }

  if (persistenceCount >= 4 && targetedSupportRoleCount === 0) {
    return {
      status: 'insufficient',
      confidence: 0.38,
      evidenceFor,
      evidenceAgainst: dedupe([
        ...evidenceAgainst,
        relatedDisagreement?.question ?? '',
      ]),
    };
  }

  if (maxRounds <= round.roundNumber) {
    return {
      status:
        Object.keys(supportsByRole).length > 0
          ? 'supported'
          : contradictions.length > 0 && peerSupportRoleCount === 0
            ? 'refuted'
            : 'insufficient',
      confidence: peerSupportRoleCount > 0 ? 0.42 : 0.5,
      evidenceFor,
      evidenceAgainst,
    };
  }

  return {
    status:
      weakSupports.length > 0 ||
      peerSupportRoleCount > 0 ||
      persistenceCount > 0
        ? 'insufficient'
        : 'open',
    confidence:
      weakSupports.length > 0 || peerSupportRoleCount > 0 ? 0.28 : 0.14,
    evidenceFor,
    evidenceAgainst,
  };
}

function buildAlternativeHypothesis(
  parent: HypothesisRecord,
  disagreement: RoundDisagreement,
): HypothesisRecord {
  const topicKey = `${parent.topicKey}>${disagreement.fingerprint}`;
  return {
    id: `H-alt-${slugify(topicKey)}`,
    statement: disagreement.question,
    kind: 'alternative-mechanism',
    status: 'open',
    topicKey,
    parentId: parent.id,
    childIds: [],
    depth: parent.depth + 1,
    frontier: true,
    dependencyMode: 'any',
    targetedRoles: roleForBranchTopic(parent.topicKey),
    requiredChecks: dedupe([
      disagreement.question,
      ...parent.requiredChecks.slice(0, 2),
    ]),
    evidenceFor: [],
    evidenceAgainst: [],
    confidence: 0.18,
    createdRound: disagreement.roundNumber,
    lastUpdatedRound: disagreement.roundNumber,
    derivedFromId: parent.id,
    revisionReason: disagreement.rationale,
  };
}

function findFrontierNodeForBranch(
  hypotheses: HypothesisRecord[],
  branchTopic: string,
): HypothesisRecord | undefined {
  return hypotheses
    .filter(
      (hypothesis) =>
        hypothesis.frontier &&
        (hypothesis.topicKey?.startsWith(branchTopic) ?? false),
    )
    .sort((left, right) => right.depth - left.depth)[0];
}

function expandFrontier(
  hypotheses: HypothesisRecord[],
  round: SampleRoundRecord,
): HypothesisRecord[] {
  const next = hypotheses.map((hypothesis) => ({
    ...hypothesis,
    childIds: [...hypothesis.childIds],
  }));
  const byId = getHypothesisMap(next);

  for (const disagreement of round.disagreements) {
    if (disagreement.persistenceCount < 2) {
      continue;
    }
    const branchTopic = baseBranchTopic(disagreement);
    const frontierNode = findFrontierNodeForBranch(next, branchTopic);
    if (!frontierNode || !frontierNode.frontier) {
      continue;
    }

    const childTopic = `${frontierNode.topicKey}>${disagreement.fingerprint}`;
    const hasExistingChild = frontierNode.childIds
      .map((childId) => byId.get(childId))
      .some((child) => child?.topicKey === childTopic);
    if (hasExistingChild) {
      continue;
    }

    const child = buildAlternativeHypothesis(frontierNode, disagreement);
    frontierNode.childIds.push(child.id);
    frontierNode.frontier = false;
    next.push(child);
    byId.set(child.id, child);
  }

  return next;
}

function aggregateFromChildren(
  hypothesis: HypothesisRecord,
  children: HypothesisRecord[],
  roundNumber: number,
  maxRounds: number,
): Pick<
  HypothesisRecord,
  'status' | 'confidence' | 'evidenceFor' | 'evidenceAgainst'
> {
  const supportedChildren = children.filter(
    (child) => child.status === 'supported',
  );
  const refutedChildren = children.filter(
    (child) => child.status === 'refuted',
  );
  const unresolvedChildren = children.filter(
    (child) => child.status === 'open' || child.status === 'insufficient',
  );
  const evidenceFor = dedupe(children.flatMap((child) => child.evidenceFor));
  const evidenceAgainst = dedupe(
    children.flatMap((child) => child.evidenceAgainst),
  );

  if (hypothesis.kind === 'positive') {
    const childrenByTopic = new Map(
      children.map((child) => [child.topicKey ?? child.id, child]),
    );
    const essentialTopics = [
      'criterion.drug-target',
      'criterion.protein-disease',
      'criterion.disease-target',
    ];
    const essentialChildren = essentialTopics
      .map((topic) => childrenByTopic.get(topic))
      .filter((child): child is HypothesisRecord => Boolean(child));
    const essentialSupported = essentialChildren.filter(
      (child) => child.status === 'supported',
    ).length;
    const essentialRefuted = essentialChildren.filter(
      (child) => child.status === 'refuted',
    ).length;
    const graphSupported =
      childrenByTopic.get('criterion.graph-specificity')?.status ===
      'supported';
    const graphRefuted =
      childrenByTopic.get('criterion.graph-specificity')?.status === 'refuted';
    const strongNegativeConsensus =
      essentialRefuted >= 2 || (graphRefuted && essentialRefuted >= 1);
    const coherentPositiveStory = essentialSupported >= 2 && graphSupported;

    if (strongNegativeConsensus) {
      return {
        status: 'refuted',
        confidence: 0.76,
        evidenceFor,
        evidenceAgainst,
      };
    }

    if (essentialSupported === essentialChildren.length && graphSupported) {
      return {
        status: 'supported',
        confidence: 0.82,
        evidenceFor,
        evidenceAgainst,
      };
    }

    if (
      coherentPositiveStory &&
      essentialRefuted === 0 &&
      roundNumber >= maxRounds
    ) {
      return {
        status: 'supported',
        confidence: 0.72,
        evidenceFor,
        evidenceAgainst,
      };
    }

    if (roundNumber >= maxRounds) {
      if (essentialRefuted >= 2 && essentialSupported === 0) {
        return {
          status: 'refuted',
          confidence: 0.6,
          evidenceFor,
          evidenceAgainst,
        };
      }
      return {
        status: coherentPositiveStory ? 'supported' : 'insufficient',
        confidence: coherentPositiveStory ? 0.68 : 0.5,
        evidenceFor,
        evidenceAgainst,
      };
    }

    return {
      status:
        unresolvedChildren.length > 0 || coherentPositiveStory
          ? 'insufficient'
          : 'open',
      confidence: 0.32 + essentialSupported * 0.08,
      evidenceFor,
      evidenceAgainst,
    };
  }

  if (hypothesis.kind === 'negative') {
    return {
      status: 'open',
      confidence: 0,
      evidenceFor,
      evidenceAgainst,
    };
  }

  if (supportedChildren.length > 0 && refutedChildren.length === 0) {
    return {
      status: 'supported',
      confidence: 0.64,
      evidenceFor,
      evidenceAgainst,
    };
  }
  if (refutedChildren.length > 0 && supportedChildren.length === 0) {
    return {
      status: 'refuted',
      confidence: 0.64,
      evidenceFor,
      evidenceAgainst,
    };
  }
  if (roundNumber >= maxRounds) {
    return {
      status: localVoteStatus(supportedChildren.length, refutedChildren.length),
      confidence: 0.52,
      evidenceFor,
      evidenceAgainst,
    };
  }
  return {
    status: 'insufficient',
    confidence: 0.28,
    evidenceFor,
    evidenceAgainst,
  };
}

function propagateStatuses(
  hypotheses: HypothesisRecord[],
  round: SampleRoundRecord,
  maxRounds: number,
): HypothesisRecord[] {
  const next = hypotheses.map((hypothesis) => ({
    ...hypothesis,
    childIds: [...hypothesis.childIds],
  }));
  const byId = getHypothesisMap(next);
  const ordered = [...next].sort((left, right) => right.depth - left.depth);

  for (const hypothesis of ordered) {
    const current = byId.get(hypothesis.id);
    if (!current) {
      continue;
    }

    const update = isLeaf(current)
      ? evaluateFrontierHypothesis(current, round, maxRounds)
      : aggregateFromChildren(
          current,
          current.childIds
            .map((childId) => byId.get(childId))
            .filter((child): child is HypothesisRecord => Boolean(child)),
          round.roundNumber,
          maxRounds,
        );

    current.status = update.status;
    current.confidence = update.confidence;
    current.evidenceFor = dedupe([
      ...current.evidenceFor,
      ...update.evidenceFor,
    ]);
    current.evidenceAgainst = dedupe([
      ...current.evidenceAgainst,
      ...update.evidenceAgainst,
    ]);
    current.lastUpdatedRound = round.roundNumber;
  }

  const positiveRoot = next.find(
    (hypothesis) => hypothesis.kind === 'positive',
  );
  const negativeRoot = next.find(
    (hypothesis) => hypothesis.kind === 'negative',
  );
  if (positiveRoot && negativeRoot) {
    negativeRoot.status =
      positiveRoot.status === 'supported'
        ? 'refuted'
        : positiveRoot.status === 'refuted'
          ? 'supported'
          : 'insufficient';
    negativeRoot.confidence =
      negativeRoot.status === 'supported'
        ? 0.72
        : negativeRoot.status === 'refuted'
          ? 0.72
          : 0.36;
    negativeRoot.evidenceFor = dedupe([...positiveRoot.evidenceAgainst]);
    negativeRoot.evidenceAgainst = dedupe([...positiveRoot.evidenceFor]);
    negativeRoot.lastUpdatedRound = round.roundNumber;
  }

  for (const hypothesis of next) {
    hypothesis.frontier = isLeaf(hypothesis)
      ? hypothesis.kind !== 'negative' &&
        (hypothesis.status === 'open' || hypothesis.status === 'insufficient')
      : false;
  }

  return next;
}

function resolveDisagreements(
  hypotheses: HypothesisRecord[],
  disagreements: RoundDisagreement[],
): RoundDisagreement[] {
  return disagreements
    .map((disagreement) => {
      const branchTopic = baseBranchTopic(disagreement);
      const branchOpen = hypotheses.some(
        (hypothesis) =>
          (hypothesis.topicKey?.startsWith(branchTopic) ?? false) &&
          (hypothesis.status === 'open' ||
            hypothesis.status === 'insufficient' ||
            hypothesis.frontier),
      );
      return {
        ...disagreement,
        status: branchOpen ? disagreement.status : 'resolved',
      };
    })
    .filter((disagreement) => disagreement.status !== 'resolved');
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
  maxRounds: number,
): HypothesisState {
  const expandedHypotheses = expandFrontier(state.hypotheses, round);
  const revisedHypotheses = propagateStatuses(
    expandedHypotheses,
    round,
    maxRounds,
  );
  const unresolvedDisagreements = resolveDisagreements(
    revisedHypotheses,
    round.disagreements,
  );

  return {
    hypotheses: revisedHypotheses,
    rounds: [
      ...state.rounds,
      {
        ...round,
        disagreements: unresolvedDisagreements,
        hypothesisSnapshot: revisedHypotheses.map((item) => ({ ...item })),
      },
    ],
    unresolvedDisagreements,
  };
}
