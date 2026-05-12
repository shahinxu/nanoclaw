import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_BIOMED_CONFIG } from './config.js';
import { BiomedWorkflowRunner } from './runner.js';
import type { AgentAssessment, BiomedTaskSample, EvidenceItem, WorkflowResult } from './types.js';

interface CliOptions {
  top50Path: string;
  inputJsonl: string;
  outputPath: string;
  dataDir: string;
  graphDataDir: string;
  workspaceRoot: string;
  pythonExecutable: string;
  openRouterApiKeyPath: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  maxRounds: number;
  concurrency: number;
}

interface Top50Row {
  rank: number;
  drugId: string;
  confidence: number;
  diseaseId: string;
  status: string;
  decisionMode: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    top50Path: path.resolve('../logs_agentic/ad_top50_high_confidence_drugs.csv'),
    inputJsonl: '',
    outputPath: path.resolve('../logs_agentic/ad_top50_with_claims.jsonl'),
    dataDir: DEFAULT_BIOMED_CONFIG.dataDir,
    graphDataDir: DEFAULT_BIOMED_CONFIG.graphDataDir,
    workspaceRoot: DEFAULT_BIOMED_CONFIG.workspaceRoot,
    pythonExecutable: DEFAULT_BIOMED_CONFIG.pythonExecutable,
    openRouterApiKeyPath: DEFAULT_BIOMED_CONFIG.openRouterApiKeyPath,
    openRouterBaseUrl: DEFAULT_BIOMED_CONFIG.openRouterBaseUrl,
    openRouterModel: DEFAULT_BIOMED_CONFIG.openRouterModel,
    maxRounds: DEFAULT_BIOMED_CONFIG.maxRounds,
    concurrency: 2,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--top50Path' && next) {
      options.top50Path = next;
      index += 1;
    } else if (arg === '--inputJsonl' && next) {
      options.inputJsonl = next;
      index += 1;
    } else if (arg === '--outputPath' && next) {
      options.outputPath = next;
      index += 1;
    } else if (arg === '--dataDir' && next) {
      options.dataDir = next;
      index += 1;
    } else if (arg === '--graphDataDir' && next) {
      options.graphDataDir = next;
      index += 1;
    } else if (arg === '--workspaceRoot' && next) {
      options.workspaceRoot = next;
      index += 1;
    } else if (arg === '--pythonExecutable' && next) {
      options.pythonExecutable = next;
      index += 1;
    } else if (arg === '--openRouterApiKeyPath' && next) {
      options.openRouterApiKeyPath = next;
      index += 1;
    } else if (arg === '--openRouterBaseUrl' && next) {
      options.openRouterBaseUrl = next;
      index += 1;
    } else if (arg === '--openRouterModel' && next) {
      options.openRouterModel = next;
      index += 1;
    } else if (arg === '--maxRounds' && next) {
      options.maxRounds = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--concurrency' && next) {
      options.concurrency = Number.parseInt(next, 10);
      index += 1;
    }
  }

  return options;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  values.push(current);
  return values;
}

function readTop50Rows(filePath: string): Top50Row[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length <= 1) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const rows: Top50Row[] = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    rows.push({
      rank: Number.parseInt(row.rank, 10),
      drugId: row.drugId,
      confidence: Number.parseFloat(row.confidence),
      diseaseId: row.diseaseId,
      status: row.status,
      decisionMode: row.decisionMode,
    });
  }

  return rows.sort((left, right) => left.rank - right.rank);
}

function readRowsFromJsonl(filePath: string): Top50Row[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  const rows: Top50Row[] = [];

  lines.forEach((line, index) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const predicted = parsed.predictedLabel;
    if (predicted !== undefined && Number(predicted) !== 1) {
      return;
    }

    const drugId = String(parsed.drugId ?? '');
    const diseaseId = String(parsed.diseaseId ?? '');
    if (!drugId || !diseaseId) {
      return;
    }

    rows.push({
      rank: index + 1,
      drugId,
      confidence: Number(parsed.confidence ?? 0),
      diseaseId,
      status: String(parsed.status ?? ''),
      decisionMode: String(parsed.decisionMode ?? ''),
    });
  });

  return rows;
}

function serializeEvidenceItems(items: EvidenceItem[]): string {
  return JSON.stringify(
    items.map((item) => ({
      toolName: item.toolName,
      stance: item.stance,
      strength: item.strength,
      claim: item.claim,
    })),
  );
}

function strongestClaim(items: EvidenceItem[]): string {
  if (items.length === 0) {
    return '';
  }
  const score = (item: EvidenceItem): number => {
    if (item.strength === 'strong') {
      return 3;
    }
    if (item.strength === 'moderate') {
      return 2;
    }
    return 1;
  };
  return [...items].sort((left, right) => score(right) - score(left))[0].claim;
}

function toAgentColumns(assessment: AgentAssessment): {
  label: number;
  summary: string;
  topClaim: string;
  allClaims: string;
} {
  const evidenceItems = [...assessment.evidenceItems];
  return {
    label: assessment.recommendedLabel,
    summary: assessment.summary,
    topClaim: strongestClaim(evidenceItems),
    allClaims: serializeEvidenceItems(evidenceItems),
  };
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const cap = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<U>(values.length);
  let nextIndex = 0;

  async function run(): Promise<void> {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= values.length) {
        return;
      }
      results[idx] = await worker(values[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => run()));
  return results;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function renderProgress(
  completed: number,
  total: number,
  succeeded: number,
  failed: number,
  startedAt: number,
): void {
  const ratio = total > 0 ? completed / total : 1;
  const percent = (ratio * 100).toFixed(1);
  const elapsedMs = Date.now() - startedAt;
  const avgMs = completed > 0 ? elapsedMs / completed : 0;
  const etaMs = Math.max(0, Math.round(avgMs * (total - completed)));
  process.stdout.write(
    `\rProgress ${completed}/${total} (${percent}%) ok=${succeeded} fail=${failed} elapsed=${formatDuration(elapsedMs)} eta=${formatDuration(etaMs)}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const inputRows = options.inputJsonl
    ? readRowsFromJsonl(path.resolve(options.inputJsonl))
    : readTop50Rows(path.resolve(options.top50Path));
  const total = inputRows.length;

  if (total === 0) {
    if (options.inputJsonl) {
      throw new Error(`No usable rows found in JSONL: ${options.inputJsonl}`);
    }
    throw new Error(`No rows found in top50 CSV: ${options.top50Path}`);
  }

  const selected = inputRows.map((row) => {
    const sample: BiomedTaskSample = {
      sampleIndex: row.rank,
      relationshipType: 'drug_disease',
      entityDict: {
        drug: row.drugId,
        disease: row.diseaseId,
      },
    };
    return { row, sample };
  });

  const runner = new BiomedWorkflowRunner({
    workspaceRoot: options.workspaceRoot,
    relationshipType: 'drug_disease',
    dataDir: options.dataDir,
    graphDataDir: options.graphDataDir,
    pythonExecutable: options.pythonExecutable,
    openRouterApiKeyPath: options.openRouterApiKeyPath,
    openRouterBaseUrl: options.openRouterBaseUrl,
    openRouterModel: options.openRouterModel,
    maxRounds: options.maxRounds,
    writeTrace: false,
  });

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, '', 'utf8');

  const appendRecord = (record: Record<string, unknown>): void => {
    fs.appendFileSync(options.outputPath, `${JSON.stringify(record)}\n`, 'utf8');
  };

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const text = args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');
    if (
      text.includes('round_objective_planner returned invalid structured payload') ||
      text.includes('OpenRouter call failed')
    ) {
      return;
    }
    // Keep runtime output minimal: suppress non-critical warnings.
  };

  const startedAt = Date.now();
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  renderProgress(completed, total, succeeded, failed, startedAt);

  await mapWithConcurrency(
    selected,
    options.concurrency,
    async ({ row, sample }) => {
      try {
        const result: WorkflowResult = await runner.runSample(sample);
        const assessments = new Map(result.trace.assessments.map((item) => [item.agentId, item]));
        const drug = toAgentColumns(assessments.get('drug_agent') as AgentAssessment);
        const disease = toAgentColumns(assessments.get('disease_agent') as AgentAssessment);
        const graph = toAgentColumns(assessments.get('graph_agent') as AgentAssessment);
        const arbiter = assessments.get('arbiter_agent') as AgentAssessment | undefined;

        succeeded += 1;
        appendRecord({
          rank: row.rank,
          drugId: row.drugId,
          confidence: row.confidence,
          diseaseId: row.diseaseId,
          status: row.status,
          decisionMode: row.decisionMode,
          predictedLabel: result.decision.label,
          rationale: result.decision.rationale,
          drug_agent_label: drug.label,
          drug_agent_summary: drug.summary,
          drug_agent_top_claim: drug.topClaim,
          drug_agent_all_claims: drug.allClaims,
          disease_agent_label: disease.label,
          disease_agent_summary: disease.summary,
          disease_agent_top_claim: disease.topClaim,
          disease_agent_all_claims: disease.allClaims,
          graph_agent_label: graph.label,
          graph_agent_summary: graph.summary,
          graph_agent_top_claim: graph.topClaim,
          graph_agent_all_claims: graph.allClaims,
          arbiter_label: arbiter?.recommendedLabel ?? '',
          arbiter_summary: arbiter?.summary ?? '',
        });
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        appendRecord({
          rank: row.rank,
          drugId: row.drugId,
          confidence: row.confidence,
          diseaseId: row.diseaseId,
          status: row.status,
          decisionMode: row.decisionMode,
          predictedLabel: '',
          rationale: `ERROR: ${message}`,
          drug_agent_label: '',
          drug_agent_summary: '',
          drug_agent_top_claim: '',
          drug_agent_all_claims: '',
          disease_agent_label: '',
          disease_agent_summary: '',
          disease_agent_top_claim: '',
          disease_agent_all_claims: '',
          graph_agent_label: '',
          graph_agent_summary: '',
          graph_agent_top_claim: '',
          graph_agent_all_claims: '',
          arbiter_label: '',
          arbiter_summary: '',
          error: message,
        });
      } finally {
        completed += 1;
        renderProgress(completed, total, succeeded, failed, startedAt);
      }
    },
  );

  console.warn = originalWarn;
  const elapsedMs = Date.now() - startedAt;
  process.stdout.write('\n');
  console.log(`Done: total=${total}, ok=${succeeded}, fail=${failed}, elapsed=${formatDuration(elapsedMs)} -> ${options.outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});