export const BIOMED_ROLES = ['drug', 'protein', 'disease'] as const;
export const ALL_AGENT_ROLES = ['drug', 'protein', 'disease', 'graph'] as const;

export const SOURCE_BY_ROLE: Record<(typeof ALL_AGENT_ROLES)[number], string> = {
  drug: 'drug_agent',
  protein: 'protein_agent',
  disease: 'disease_agent',
  graph: 'graph_agent',
};