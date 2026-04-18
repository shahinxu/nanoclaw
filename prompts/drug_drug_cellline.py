"""
Prompt config for drug_drug_cell-line (药物组合-细胞系 协同性二分类).

Label semantics (binary):
   1 = synergy — the drug combination acts synergistically on this cell line.
   0 = non-synergy — no synergistic effect (includes antagonism, additive, or
       no meaningful interaction).
"""

PROMPT_CONFIG = {
    'is_multiclass': False,

    # -- Graph Reasoner --
    'graph_hyperedge_label': (
        'drug-drug-cell-line synergy edge '
        '(decide whether this drug combination is synergistic on this '
        'cell line. Label 1 means the drugs act synergistically. '
        'Label 0 means no synergy — the interaction is antagonistic, '
        'merely additive, or there is no meaningful interaction.)'
    ),

    # -- Biomedical Expert Reasoner & Autonomous Researcher --
    'expert_hyperedge_label': (
        'drug-drug-cell-line synergy edge '
        '(Label 1: the drug combination is synergistic on this cell line. '
        'Label 0: no synergy — the combination is antagonistic, additive, '
        'or has no meaningful interaction.)'
    ),

    # -- Label description / schema --
    'label_desc': (
        '1 (synergy — the drug combination acts synergistically on this '
        'cell line) or 0 (non-synergy — antagonism, additive, or no '
        'meaningful interaction)'
    ),
    'label_schema': '0 or 1',

    # -- Vote instruction (biomedical expert) --
    'vote_instruction': (
        'Decide whether this drug combination is synergistic on this cell '
        'line. Return one vote: 1 = synergy, 0 = non-synergy, '
        'and one concise claim only.'
    ),

    # -- Autonomous Researcher --
    'researcher_label_instruction': (
        'You are investigating whether the queried drug combination acts '
        'synergistically on the queried cell line.\n'
        '- Label 1 (synergy): the drugs enhance each other\'s effect '
        'beyond simple additivity.\n'
        '- Label 0 (non-synergy): the interaction is antagonistic, '
        'merely additive, or there is no meaningful interaction.'
    ),
    'researcher_final_answer_schema': (
        'FINAL_ANSWER: {"recommended_label": 0 or 1, '
        '"stance": "supports" or "contradicts", '
        '"strength": "strong" or "moderate" or "weak", '
        '"claim": "your concise first-person expert statement"}'
    ),
    'researcher_task_line': (
        '## Task\n'
        'Classify the queried drug-drug-cell-line combination:\n'
        '- 1 = synergy (the drugs act synergistically)\n'
        '- 0 = non-synergy (antagonism, additive, or no interaction)'
    ),
}
