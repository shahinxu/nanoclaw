"""
Prompt config for drug_protein_disease (药物-蛋白质-疾病 三元组).

Label semantics:
  1 = supported — the drug acts on the protein, the protein is relevant to
      the disease, AND the drug is therapeutically relevant to the disease
      (all three pairwise associations hold).
  0 = not supported — at least one pairwise link is absent or unconvincing.
"""

PROMPT_CONFIG = {
    'is_multiclass': False,

    # -- Graph Reasoner --
    'graph_hyperedge_label': (
        'drug-protein-disease triplet '
        '(label 1 means the triplet is supported, i.e. the drug acts on the protein '
        'AND the protein is relevant to the disease AND the drug is therapeutically '
        'relevant to the disease \u2014 all three pairwise associations hold; '
        'label 0 means not supported)'
    ),

    # -- Biomedical Expert Reasoner & Autonomous Researcher --
    'expert_hyperedge_label': (
        'drug-protein-disease triplet '
        '(label 1 means the triplet is supported: the drug acts on the protein, '
        'the protein is relevant to the disease, and the drug is therapeutically '
        'relevant to the disease \u2014 all three pairwise associations hold; '
        'label 0 means at least one pairwise link is absent or unconvincing)'
    ),

    # -- Label description / schema --
    'label_desc': (
        '1 (supported \u2014 all three pairwise associations drug-protein, '
        'protein-disease, drug-disease hold) or '
        '0 (not supported \u2014 at least one pairwise link is absent or unconvincing)'
    ),
    'label_schema': '0 or 1',

    # -- Vote instruction (biomedical expert) --
    'vote_instruction': (
        'Return one vote: 1 = triplet supported (all pairwise links hold), '
        '0 = not supported, and one concise claim only.'
    ),

    # -- Autonomous Researcher --
    'researcher_label_instruction': (
        'You are investigating a queried drug-protein-disease triplet.\n'
        'Label 1 (supported) means all three pairwise associations hold: '
        'the drug acts on the protein, the protein is relevant to the disease, '
        'and the drug is therapeutically relevant to the disease.\n'
        'Label 0 (not supported) means at least one of these pairwise links '
        'is absent or unconvincing.'
    ),
    'researcher_final_answer_schema': (
        'FINAL_ANSWER: {"recommended_label": 0 or 1, '
        '"stance": "supports" or "contradicts", '
        '"strength": "strong" or "moderate" or "weak", '
        '"claim": "your concise first-person expert statement"}'
    ),
    'researcher_task_line': (
        '## Task\n'
        'Decide whether the queried drug-protein-disease triplet should be '
        'labelled 1 or 0.\n'
        'Label 1 = supported (all three pairwise associations drug-protein, '
        'protein-disease, drug-disease hold).\n'
        'Label 0 = not supported (at least one pairwise link is absent or '
        'unconvincing).'
    ),
}
