import fs from 'node:fs';
import path from 'node:path';

export interface BiomedWorkflowConfig {
  workspaceRoot: string;
  dataDir: string;
  graphDataDir: string;
  pythonExecutable: string;
  openRouterApiKeyPath: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  relationshipType: string;
  maxRounds: number;
  writeTrace: boolean;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveWorkspaceRoot(): string {
  const explicit = process.env.BIOMED_WORKSPACE_ROOT?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const cwd = process.cwd();
  const cwdHasData = fs.existsSync(path.join(cwd, 'data_edge_test'));
  if (cwdHasData) {
    return cwd;
  }

  const parent = path.resolve(cwd, '..');
  const parentHasData = fs.existsSync(path.join(parent, 'data_edge_test'));
  if (parentHasData) {
    return parent;
  }

  return cwd;
}

const workspaceRoot = resolveWorkspaceRoot();
const defaultDataDir = path.join(workspaceRoot, 'data_edge_test');
const defaultGraphDataDir = path.join(workspaceRoot, 'data_edge_train');
const defaultApiKeyPath = path.join(workspaceRoot, 'openrouter_api_key.txt');

export const DEFAULT_BIOMED_CONFIG: BiomedWorkflowConfig = {
  workspaceRoot,
  dataDir: path.resolve(process.env.BIOMED_DATA_DIR ?? defaultDataDir),
  graphDataDir: path.resolve(
    process.env.BIOMED_GRAPH_DATA_DIR ?? defaultGraphDataDir,
  ),
  pythonExecutable: process.env.BIOMED_PYTHON_EXECUTABLE ?? 'python',
  openRouterApiKeyPath: path.resolve(
    process.env.BIOMED_OPENROUTER_API_KEY_PATH ?? defaultApiKeyPath,
  ),
  openRouterBaseUrl:
    process.env.BIOMED_OPENROUTER_BASE_URL ??
    process.env.OPENROUTER_BASE_URL ??
    'http://localhost:8000/v1',
  openRouterModel:
    process.env.BIOMED_OPENROUTER_MODEL ??
    process.env.OPENROUTER_MODEL ??
    'models/Llama-3.1-8B-Instruct',
  relationshipType:
    process.env.BIOMED_RELATIONSHIP_TYPE ?? 'drug_protein_disease',
  maxRounds: toInteger(process.env.BIOMED_MAX_ROUNDS, 5),
  writeTrace: toBoolean(process.env.BIOMED_WRITE_TRACE, true),
};
