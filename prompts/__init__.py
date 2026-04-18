"""
Prompt configuration registry for each relationship-type pipeline.

Each pipeline file exports a PROMPT_CONFIG dict with the following keys:

    graph_hyperedge_label     – short label used in the graph reasoner
    expert_hyperedge_label    – descriptive label used in biomedical-expert & autonomous researcher
    label_desc                – human-readable label description (shown in decision_space)
    label_schema              – compact label schema (shown in response_schema)
    vote_instruction          – one-line instruction for the biomedical expert reasoner
    is_multiclass             – bool; True only for 4-class tasks (e.g. drug_drug_cell-line)
    researcher_label_instruction – paragraph injected into autonomous-researcher system prompt
    researcher_final_answer_schema – FINAL_ANSWER format string for autonomous researcher
    researcher_task_line      – ## Task block for autonomous researcher
"""

from typing import Any, Dict

from prompts.drug_protein_disease import PROMPT_CONFIG as _dpd
from prompts.drug_drug_sideeffect import PROMPT_CONFIG as _dds
from prompts.drug_disease import PROMPT_CONFIG as _dd
from prompts.drug_drug_cellline import PROMPT_CONFIG as _ddc
from prompts.drug_drug_disease import PROMPT_CONFIG as _ddd

_REGISTRY: Dict[str, Dict[str, Any]] = {
    'drug_protein_disease': _dpd,
    '': _dpd,                       # default fallback
    'drug_drug_sideeffect': _dds,
    'drug_disease': _dd,
    'drug_drug_cell-line': _ddc,
    'drug_drug_disease': _ddd,
}


def get_prompt_config(relationship_type: str) -> Dict[str, Any]:
    """Return the prompt config dict for the given relationship type.

    Falls back to the generic 'drug_protein_disease' config when the
    relationship type has no dedicated entry.
    """
    return _REGISTRY.get(relationship_type, _dpd)
