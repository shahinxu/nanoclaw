"""
Prompt config for drug_drug_sideeffect (药物组合-副作用).

Label semantics:
  1 = supported — the queried drug set, considered jointly, supports the
      queried adverse effect / side effect.
  0 = not supported.
"""

PROMPT_CONFIG = {
    'is_multiclass': False,

    # -- Graph Reasoner --
    'graph_hyperedge_label': 'drug-drug-sideeffect hyperedge',

    # -- Biomedical Expert Reasoner & Autonomous Researcher --
    'expert_hyperedge_label': (
        'drug-set-sideeffect hyperedge '
        '(does the queried drug set, considered jointly, support the queried '
        'adverse effect / side effect?)'
    ),

    # -- Label description / schema --
    'label_desc': '0 or 1 only',
    'label_schema': '0 or 1',

    # -- Vote instruction (biomedical expert) --
    'vote_instruction': 'Return one binary vote and one concise claim only.',

    # -- Autonomous Researcher --
    'researcher_label_instruction': (
        'You are investigating whether a queried drug-set-sideeffect hyperedge '
        'should be labelled 1 (supported) or 0 (not supported).'
    ),
    'researcher_final_answer_schema': (
        'FINAL_ANSWER: {"recommended_label": 0 or 1, '
        '"stance": "supports" or "contradicts", '
        '"strength": "strong" or "moderate" or "weak", '
        '"claim": "your concise first-person expert statement"}'
    ),
    'researcher_task_line': (
        '## Task\n'
        'Decide whether the queried drug-set-sideeffect hyperedge should be '
        'labelled 1 or 0.'
    ),
}
