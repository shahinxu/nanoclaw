"""
Prompt config for drug_disease (药物-疾病 indication 判定).

Label semantics (after data correction):
  1 = indication — the drug is a recognized treatment for the disease.
  0 = no indication — the drug is NOT a recognized treatment; the pair
      has no established therapeutic relationship.
"""

PROMPT_CONFIG = {
    'is_multiclass': False,

    # -- Graph Reasoner --
    'graph_hyperedge_label': (
        'drug-disease edge '
        '(decide whether this drug is an established treatment for the '
        'disease. Label 1 means the drug is therapeutically used to treat '
        'the disease. Label 0 means there is no recognized therapeutic '
        'relationship between this drug and this disease.)'
    ),

    # -- Biomedical Expert Reasoner & Autonomous Researcher --
    'expert_hyperedge_label': (
        'drug-disease indication edge '
        '(Label 1: the drug is a recognized or plausible treatment for '
        'the disease. Label 0: there is no established therapeutic '
        'relationship — the drug is not used to treat this disease.)'
    ),

    # -- Label description / schema --
    'label_desc': (
        '1 (indication — the drug treats or is therapeutically appropriate '
        'for the disease) or 0 (no indication — the drug is not a recognized '
        'treatment for this disease)'
    ),
    'label_schema': '0 or 1',

    # -- Vote instruction (biomedical expert) --
    'vote_instruction': (
        'Decide whether this drug is a recognized treatment for the disease. '
        'Label 1 = indication (the drug is used to treat or manage the '
        'disease). Label 0 = no indication (the drug has no established '
        'therapeutic role for this disease). '
        'Return one vote: 1 = indication, 0 = no indication, '
        'and one concise claim only.'
    ),

    # -- Autonomous Researcher --
    'researcher_label_instruction': (
        'You are investigating the queried drug-disease pair and must decide: '
        'Is this drug a recognized treatment for this disease?\n'
        '- Label 1 (indication): the drug is used to treat or manage the disease.\n'
        '- Label 0 (no indication): there is no established therapeutic '
        'relationship between this drug and this disease.'
    ),
    'researcher_final_answer_schema': (
        'FINAL_ANSWER: {"recommended_label": 0 or 1, '
        '"stance": "supports" or "contradicts", '
        '"strength": "strong" or "moderate" or "weak", '
        '"claim": "your concise first-person expert statement"}'
    ),
    'researcher_task_line': (
        '## Task\n'
        'Classify this drug-disease pair:\n'
        '- 1 = indication (the drug treats the disease)\n'
        '- 0 = no indication (no therapeutic relationship)'
    ),
}
