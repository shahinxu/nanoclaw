export interface BiomedWorkflowConfig {
  workspaceRoot: string;
  dataDir: string;
  pythonExecutable: string;
  openRouterApiKeyPath: string;
  openRouterBaseUrl: string;
  expertJudgeModel: string;
  enableExpertJudge: boolean;
  relationshipType: string;
  maxRounds: number;
  writeTrace: boolean;
}

export const DEFAULT_BIOMED_CONFIG: BiomedWorkflowConfig = {
  workspaceRoot: '/home/zhx/drug_agent',
  dataDir: '/home/zhx/drug_agent/data_edge_test',
  pythonExecutable: '/home/zhx/miniconda3/envs/drug_agent/bin/python',
  openRouterApiKeyPath: '/home/zhx/drug_agent/openrouter_api_key.txt',
  openRouterBaseUrl: 'https://openrouter.ai/api/v1',
  expertJudgeModel: 'openai/gpt-4o-mini',
  enableExpertJudge: true,
  relationshipType: 'drug_protein_disease',
  maxRounds: 5,
  writeTrace: true,
};