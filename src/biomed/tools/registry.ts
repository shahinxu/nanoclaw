export interface RegisteredBiomedTool {
  name: string;
  description: string;
}

export const BIOMED_TOOL_REGISTRY: RegisteredBiomedTool[] = [
  {
    name: 'drug_researcher',
    description: 'Fetches API-sourced drug profile and mechanism metadata.',
  },
  {
    name: 'protein_researcher',
    description: 'Fetches API-sourced protein function and pathway metadata.',
  },
  {
    name: 'disease_researcher',
    description: 'Fetches API-sourced disease profile and treatment metadata.',
  },
];