import fs from 'node:fs';

import { BiomedWorkflowConfig } from '../config.js';
import {
  ExpertJudge,
  ExpertJudgeInput,
  ExpertJudgeResult,
  EvidenceStance,
  EvidenceStrength,
} from '../types.js';

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PromptExample {
  user: string;
  assistant: ExpertJudgeResult;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseJudgeResponse(text: string): ExpertJudgeResult {
  const parsed = JSON.parse(text) as Partial<ExpertJudgeResult>;
  const stance = parsed.stance;
  const strength = parsed.strength;
  const claim = parsed.claim;

  if (
    (stance !== 'supports' && stance !== 'contradicts' && stance !== 'insufficient') ||
    (strength !== 'strong' && strength !== 'moderate' && strength !== 'weak') ||
    typeof claim !== 'string' ||
    claim.trim() === ''
  ) {
    throw new Error('Invalid expert judge JSON response.');
  }

  return {
    stance: stance as EvidenceStance,
    strength: strength as EvidenceStrength,
    claim: claim.trim(),
    rawResponse: text,
  };
}

function sharedSystemPrompt(): string {
  return [
    'You are a biomedical expert judge.',
    'Your job is not to decide the final label. Your job is to judge whether ONE expert tool output supports, contradicts, or is insufficient for that expert role.',
    'Treat the tool output conservatively but do not ignore clear structured evidence.',
    'Use only the provided sample, hypothesis, tool output, and structured result.',
    'Return JSON only with keys: stance, strength, claim.',
    'Valid stance values: supports, contradicts, insufficient.',
    'Valid strength values: strong, moderate, weak.',
    'The claim must be one concise sentence.',
    'Do not mention that you are an AI model.',
  ].join('\n');
}

function roleGuidance(role: ExpertJudgeInput['agentRole']): string {
  if (role === 'drug') {
    return [
      'Drug expert guidance:',
      '- Supports when the drug output provides direct target or mechanism evidence aligned with the queried protein.',
      '- If the mechanism names the protein, a known synonym, transporter family, receptor family, or highly specific target class matching the queried protein, supports is appropriate.',
      '- Drug indications alone are not enough.',
      '- General pharmacology without a target link is insufficient.',
    ].join('\n');
  }

  if (role === 'protein') {
    return [
      'Protein expert guidance:',
      '- Supports when the protein output gives disease-relevant biology that clearly aligns with the queried disease.',
      '- General protein function without disease alignment is insufficient.',
      '- Protein-disease relevance does not imply drug involvement.',
    ].join('\n');
  }

  return [
    'Disease expert guidance:',
    '- Supports when the disease output lists the queried protein as an associated target or gives disease context clearly aligned with that protein.',
    '- Generic disease background without protein alignment is insufficient.',
    '- Disease context does not imply drug-target validity.',
  ].join('\n');
}

function promptExamples(role: ExpertJudgeInput['agentRole']): PromptExample[] {
  if (role === 'drug') {
    return [
      {
        user: stringifyJson({
          sample: { drug: 'DBX', protein: 'SLC12A3', disease: 'MONDO:0005044' },
          toolSummary:
            'Mechanism-of-action hints: Thiazide-sensitive sodium-chloride cotransporter inhibitor. Indications include hypertension.',
          structured: {
            mechanism_of_action: [
              { description: 'Thiazide-sensitive sodium-chloride cotransporter inhibitor' },
            ],
          },
        }),
        assistant: {
          stance: 'supports',
          strength: 'strong',
          claim:
            'The drug researcher reports a sodium-chloride cotransporter inhibition mechanism that directly aligns with protein SLC12A3.',
        },
      },
      {
        user: stringifyJson({
          sample: { drug: 'DBY', protein: 'AGTR1', disease: 'MONDO:0005044' },
          toolSummary: 'Indications include hypertension. No mechanism-of-action data available.',
          structured: { mechanism_of_action: null, approved_indications: [{ mesh_heading: 'Hypertension' }] },
        }),
        assistant: {
          stance: 'insufficient',
          strength: 'weak',
          claim:
            'The drug researcher reports disease indication context but no direct mechanism or target evidence linking the drug to AGTR1.',
        },
      },
    ];
  }

  if (role === 'protein') {
    return [
      {
        user: stringifyJson({
          sample: { drug: 'DBX', protein: 'AGTR1', disease: 'MONDO:0005044' },
          toolSummary: 'Function: angiotensin II receptor. Biological processes include blood pressure regulation.',
          structured: { biological_processes: ['blood pressure regulation'] },
        }),
        assistant: {
          stance: 'supports',
          strength: 'moderate',
          claim:
            'The protein researcher links AGTR1 to blood pressure regulation, which is directly relevant to hypertensive disorder.',
        },
      },
      {
        user: stringifyJson({
          sample: { drug: 'DBX', protein: 'SLC12A3', disease: 'MONDO:0005044' },
          toolSummary: 'Function: sodium and chloride transport in kidney tubules.',
          structured: { biological_processes: ['sodium ion transport', 'chloride ion transport'] },
        }),
        assistant: {
          stance: 'insufficient',
          strength: 'weak',
          claim:
            'The protein researcher provides general transporter biology for SLC12A3 but does not directly connect it to hypertensive disorder.',
        },
      },
    ];
  }

  return [
    {
      user: stringifyJson({
        sample: { drug: 'DBX', protein: 'AGTR1', disease: 'MONDO:0005044' },
        toolSummary: 'Associated targets include AGTR1 with a high score. Known treatments include angiotensin receptor antagonists.',
        structured: { associated_targets: [{ approved_symbol: 'AGTR1', score: 0.71 }] },
      }),
      assistant: {
        stance: 'supports',
        strength: 'strong',
        claim:
          'The disease researcher identifies AGTR1 as an associated target for hypertensive disorder, which supports disease-protein alignment.',
      },
    },
    {
      user: stringifyJson({
        sample: { drug: 'DBX', protein: 'SLC12A3', disease: 'MONDO:0005044' },
        toolSummary: 'Associated targets include AGTR1, AGT, CACNA1D, ADRB1, and ACE.',
        structured: { associated_targets: [{ approved_symbol: 'AGTR1' }, { approved_symbol: 'ACE' }] },
      }),
      assistant: {
        stance: 'insufficient',
        strength: 'weak',
        claim:
          'The disease researcher describes hypertensive disorder targets, but the queried protein SLC12A3 is not directly supported by this output.',
      },
    },
  ];
}

function buildMessages(input: ExpertJudgeInput): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [
    {
      role: 'system',
      content: `${sharedSystemPrompt()}\n\n${roleGuidance(input.agentRole)}`,
    },
  ];

  for (const example of promptExamples(input.agentRole)) {
    messages.push({ role: 'user', content: example.user });
    messages.push({ role: 'assistant', content: stringifyJson(example.assistant) });
  }

  messages.push({
    role: 'user',
    content: stringifyJson({
      role: input.agentRole,
      sample: input.sample.entityDict,
      hypothesis: input.hypothesis?.statement ?? null,
      toolName: input.toolName,
      toolArguments: input.toolArguments,
      toolStatus: input.toolResult.status,
      toolSummary: input.toolResult.textSummary,
      structured: input.toolResult.structured,
    }),
  });

  return messages;
}

export class OpenRouterExpertJudge implements ExpertJudge {
  private readonly apiKey: string;

  constructor(private readonly config: BiomedWorkflowConfig) {
    this.apiKey = fs.readFileSync(this.config.openRouterApiKeyPath, 'utf-8').trim();
  }

  async judge(input: ExpertJudgeInput): Promise<ExpertJudgeResult> {
    const response = await fetch(`${this.config.openRouterBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.expertJudgeModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: buildMessages(input),
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter judge request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('OpenRouter judge returned empty content.');
    }

    return parseJudgeResponse(content.trim());
  }
}