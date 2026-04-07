export const BIOMED_ROLES = [
  'drug',
  'protein',
  'disease',
  'sideeffect',
  'cellline',
] as const;
export const ALL_AGENT_ROLES = [
  'drug',
  'protein',
  'disease',
  'sideeffect',
  'cellline',
  'graph',
] as const;

export const SOURCE_BY_ROLE: Record<(typeof ALL_AGENT_ROLES)[number], string> =
  {
    drug: 'drug_agent',
    protein: 'protein_agent',
    disease: 'disease_agent',
    sideeffect: 'sideeffect_agent',
    cellline: 'cellline_agent',
    graph: 'graph_agent',
  };
