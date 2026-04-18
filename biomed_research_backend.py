from __future__ import annotations

import csv
import html
import json
import os
import re
import time
from pathlib import Path
from functools import lru_cache
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests


DEFAULT_OPENROUTER_MODEL = os.getenv(
    'BIOMED_OPENROUTER_MODEL',
    os.getenv('OPENROUTER_MODEL', 'models/Llama-3.1-8B-Instruct'),
)


def _normalize_review_context(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return value


def _non_empty_strings(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    return [str(value).strip() for value in values if str(value).strip()]


def _dedupe_preserve_order(values: List[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for value in values:
        cleaned = str(value or '').strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(cleaned)
    return ordered


def _node_context_row(
    workspace_root: Optional[str],
    entity_type: str,
    entity_id: Optional[str],
) -> Optional[Dict[str, str]]:
    root_text = str(workspace_root or '').strip()
    lookup_id = str(entity_id or '').strip()
    if not root_text or not lookup_id:
        return None
    node_specs = {
        'drug': ('data_node/node_drug_smiles.csv', 'drugbank_id'),
        'protein': ('data_node/node_protein_sequence.csv', 'gene_symbol'),
        'disease': ('data_node/node_disease_def.csv', 'mondo_id'),
        'cellline': ('data_node/node_cell_line_descriptions.csv', 'cvcl_id'),
        'sideeffect': ('data_node/node_side_effect_description.csv', 'CUI'),
    }
    spec = node_specs.get(entity_type)
    if spec is None:
        return None
    relative_path, key_field = spec
    rows = _load_node_context_rows(str(Path(root_text) / relative_path), key_field)
    return rows.get(lookup_id)


def _normalize_keyword_variants(value: str) -> List[str]:
    cleaned = _clean_node_text(value).lower()
    if not cleaned:
        return []
    variants = [cleaned]
    if '-' in cleaned:
        variants.append(cleaned.replace('-', ' '))
    if 'sodium chloride' in cleaned and 'na cl' not in cleaned:
        variants.append(cleaned.replace('sodium chloride', 'na cl'))
        variants.append(cleaned.replace('sodium chloride', 'na-cl'))
    if 'thiazide-sensitive sodium-chloride cotransporter' in cleaned:
        variants.extend([
            'thiazide sensitive sodium chloride cotransporter',
            'na-cl cotransporter',
            'ncc',
        ])
    return _dedupe_preserve_order(variants)


def _extract_protein_alias_keywords(node_name: str, description: str) -> List[str]:
    candidates: List[str] = []
    for source in [node_name, description]:
        cleaned = _clean_node_text(source)
        if not cleaned:
            continue
        candidates.extend(_normalize_keyword_variants(cleaned))
        for match in re.finditer(
            r'([A-Za-z0-9/-]+(?:\s+[A-Za-z0-9/-]+){0,6}\s+(?:receptor|channel|transporter|cotransporter|symporter|antiporter|kinase|phosphatase|enzyme|protein))',
            cleaned,
            flags=re.IGNORECASE,
        ):
            candidates.extend(_normalize_keyword_variants(match.group(1)))
        for match in re.finditer(r'\(([A-Za-z0-9-]{2,10})\)', cleaned):
            alias = match.group(1).strip()
            if len(alias) >= 2:
                candidates.append(alias.lower())
    return _dedupe_preserve_order(candidates)


def _protein_focus_keywords(
    protein_id: Optional[str],
    workspace_root: Optional[str] = None,
) -> List[str]:
    protein = (protein_id or '').strip().upper()
    if not protein:
        return []
    keywords: List[str] = [protein.lower()]
    if protein.startswith('CACN'):
        keywords.extend(['calcium channel', 'voltage gated calcium channel', 'l type calcium channel'])
    if protein.startswith('ADRB'):
        keywords.extend(['adrenergic receptor', 'beta adrenergic receptor', 'adrenoceptor'])
    if protein.startswith('ADRA'):
        keywords.extend(['adrenergic receptor', 'alpha adrenergic receptor', 'adrenoceptor'])
    if protein.startswith('AGTR'):
        keywords.append('angiotensin receptor')
    if protein == 'EGFR':
        keywords.append('epidermal growth factor receptor')
    if protein == 'MTOR':
        keywords.append('mechanistic target of rapamycin')
    if protein == 'DHFR':
        keywords.append('dihydrofolate reductase')

    row = _node_context_row(workspace_root, 'protein', protein)
    if row:
        keywords.extend(
            _extract_protein_alias_keywords(
                str(row.get('node_name') or ''),
                str(row.get('description') or ''),
            )
        )
    return _dedupe_preserve_order(keywords)


def _disease_focus_keywords(disease_id: Optional[str]) -> List[str]:
    disease = (disease_id or '').strip().upper()
    if disease == 'MONDO:0005044':
        return ['hypertension', 'hypertensive', 'blood pressure', 'arterial blood pressure']
    if disease == 'MONDO:0005045':
        return ['cardiac', 'heart', 'hypertrophic cardiomyopathy', 'myocard']
    return []


def _text_contains_any(text: str, keywords: List[str]) -> List[str]:
    searchable = text.lower()
    return [keyword for keyword in keywords if keyword.lower() in searchable]


def _list_text(values: List[str], empty: str = 'none') -> str:
    cleaned = [value for value in values if str(value).strip()]
    return ', '.join(cleaned) if cleaned else empty


def _expert_role_label(role: str) -> str:
    cleaned = str(role or '').strip().lower()
    if cleaned in {'drug', 'protein', 'disease', 'graph'}:
        return cleaned
    return 'biomedical'


def _default_first_person_claim(role: str, label: int) -> str:
    role_label = _expert_role_label(role)
    if label == 1:
        return f'I currently vote 1 because the {role_label}-side evidence and biological reasoning still support the queried triplet.'
    return f'I currently vote {label} because the {role_label}-side evidence and biological reasoning do not convincingly support the queried triplet.'


# Valid labels for multi-class relationship types (e.g. drug_drug_cell-line)
_MULTICLASS_VALID_LABELS = {-1, 0, 1, 2}

# Maps text synonyms to integer labels
_LABEL_SYNONYMS: Dict[str, int] = {
    '-1': -1, 'negative': -1, 'no_relation': -1, 'none': -1,
    '0': 0, 'antagonism': 0, 'antagonistic': 0, 'contraindication': 0,
    '1': 1, 'additive': 1, 'yes': 1, 'true': 1, 'positive': 1, 'support': 1, 'supports': 1, 'indication': 1,
    '2': 2, 'synergy': 2, 'synergistic': 2,
}


def _parse_label(raw_value: Any, relationship_type: str = '') -> int:
    """Parse a label value, supporting multi-class (-1,0,1,2) for drug_drug_cell-line
    and binary (0,1) for other relationship types."""
    is_multiclass = 'cell-line' in relationship_type or 'cell_line' in relationship_type

    # Try integer parse first
    try:
        iv = int(raw_value)
        if is_multiclass and iv in _MULTICLASS_VALID_LABELS:
            return iv
        # For binary types, clamp to 0/1
        return 1 if iv == 1 else 0
    except (TypeError, ValueError):
        pass

    # Fall back to text synonym lookup
    lv = str(raw_value or '').strip().lower()
    if lv in _LABEL_SYNONYMS:
        candidate = _LABEL_SYNONYMS[lv]
        if is_multiclass:
            return candidate
        return 1 if candidate >= 1 else 0

    # Default
    return 0


def _label_to_stance(label: int) -> str:
    """Map a label to stance. For multi-class: 1,2 → supports; -1,0 → contradicts."""
    return 'supports' if label >= 1 else 'contradicts'


def _ensure_first_person_claim(claim: Any, role: str, label: int) -> str:
    cleaned = str(claim or '').strip()
    if not cleaned:
        return _default_first_person_claim(role, label)
    if re.match(r'(?i)^i\b', cleaned):
        return cleaned
    return f"I currently vote {label} because {cleaned}"


def _build_targeted_review_summary(review_context: Dict[str, Any], notes: List[str]) -> str:
    if not review_context:
        return ''
    segments: List[str] = []
    local_priority = str(review_context.get('localEvidencePriority') or '').strip()
    local_node_summary = str(review_context.get('localNodeSummary') or '').strip()
    if local_priority == 'primary':
        segments.append('Local node context was designated as the primary grounding source for this review.')
    if local_node_summary:
        segments.append(f'Primary local node grounding: {local_node_summary}')
    focus_mode = str(review_context.get('focusMode') or '').strip()
    focal_question = str(review_context.get('focalQuestion') or '').strip()
    round_objective = review_context.get('roundObjective')
    objective_title = ''
    objective_directive = ''
    objective_requirement = ''
    objective_question = ''
    if isinstance(round_objective, dict):
        objective_title = str(round_objective.get('title') or '').strip()
        objective_directive = str(round_objective.get('directive') or '').strip()
        objective_requirement = str(round_objective.get('responseRequirement') or '').strip()
        objective_question = str(round_objective.get('sharedDebateQuestion') or '').strip()
    if focus_mode:
        segments.append(f'Targeted review mode: {focus_mode}.')
    if objective_title:
        segments.append(f'Current debate objective: {objective_title}.')
    if objective_directive:
        segments.append(f'Debate directive: {objective_directive}')
    if objective_requirement:
        segments.append(f'Expected response style: {objective_requirement}')
    if objective_question:
        segments.append(f'Shared dispute question: {objective_question}')
    if focal_question:
        segments.append(f'Focused question: {focal_question}')
    focus = _non_empty_strings(review_context.get('focus'))
    if focus:
        segments.append('Round focus: ' + ' | '.join(focus[:3]) + '.')
    peer_findings = _non_empty_strings(review_context.get('peerFindings'))
    if peer_findings:
        segments.append('Other experts said: ' + ' | '.join(peer_findings[:2]))
    hypothesis_focus = _non_empty_strings(review_context.get('hypothesisFocus'))
    if hypothesis_focus:
        segments.append('Background hypotheses still being tracked: ' + ' | '.join(hypothesis_focus[:2]))
    if notes:
        segments.extend([note for note in notes if note])
    return ' '.join(segment for segment in segments if segment)


def _http_get(
    url: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    timeout: int = 10,
) -> requests.Response:
    start = time.monotonic()
    timeout_value: Any = timeout
    if timeout > 1:
        connect_timeout = min(3.0, max(0.5, float(timeout) * 0.3))
        read_timeout = max(0.5, float(timeout) - connect_timeout)
        timeout_value = (connect_timeout, read_timeout)
    try:
        return requests.get(url, params=params, timeout=timeout_value)
    except requests.exceptions.RequestException as exc:
        elapsed = time.monotonic() - start
        host = urlparse(url).netloc or url
        if isinstance(exc, requests.exceptions.ConnectTimeout):
            kind = 'connect_timeout'
        elif isinstance(exc, requests.exceptions.ReadTimeout):
            kind = 'read_timeout'
        elif isinstance(exc, requests.exceptions.ConnectionError):
            kind = 'connection_error'
        else:
            kind = exc.__class__.__name__.lower()
        raise RuntimeError(
            f'[HTTP GET] {kind} host={host} elapsed={elapsed:.2f}s timeout={timeout}s error={exc}'
        ) from exc


def _http_post(
    url: str,
    *,
    json_payload: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 10,
) -> requests.Response:
    start = time.monotonic()
    timeout_value: Any = timeout
    if timeout > 1:
        connect_timeout = min(3.0, max(0.5, float(timeout) * 0.3))
        read_timeout = max(0.5, float(timeout) - connect_timeout)
        timeout_value = (connect_timeout, read_timeout)
    try:
        return requests.post(
            url,
            json=json_payload,
            headers=headers,
            timeout=timeout_value,
        )
    except requests.exceptions.RequestException as exc:
        elapsed = time.monotonic() - start
        host = urlparse(url).netloc or url
        if isinstance(exc, requests.exceptions.ConnectTimeout):
            kind = 'connect_timeout'
        elif isinstance(exc, requests.exceptions.ReadTimeout):
            kind = 'read_timeout'
        elif isinstance(exc, requests.exceptions.ConnectionError):
            kind = 'connection_error'
        else:
            kind = exc.__class__.__name__.lower()
        raise RuntimeError(
            f'[HTTP POST] {kind} host={host} elapsed={elapsed:.2f}s timeout={timeout}s error={exc}'
        ) from exc


def _read_text_file(path_value: Any) -> str:
    path_text = str(path_value or '').strip()
    if not path_text:
        return ''
    path = Path(path_text)
    if not path.exists():
        return ''
    try:
        return path.read_text(encoding='utf-8').strip()
    except Exception:
        return ''


def _clean_node_text(value: str) -> str:
    text = html.unescape(str(value or '').strip())
    if not text:
        return ''
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'"xrefs"\s*:\s*\[[^\]]*\]\s*\}?', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text)
    return text.strip(' .,;')


@lru_cache(maxsize=32)
def _load_node_context_rows(csv_path: str, key_field: str) -> Dict[str, Dict[str, str]]:
    path = Path(csv_path)
    if not path.exists():
        return {}
    rows: Dict[str, Dict[str, str]] = {}
    try:
        with path.open('r', encoding='utf-8', newline='') as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if not isinstance(row, dict):
                    continue
                key = str(row.get(key_field) or '').strip()
                if not key:
                    continue
                rows[key] = {str(k): str(v or '') for k, v in row.items()}
    except Exception:
        return {}
    return rows


def _node_context(arguments: Dict[str, Any]) -> Dict[str, Any]:
    workspace_root = Path(str(arguments.get('workspace_root') or '').strip())
    entity_type = str(arguments.get('entity_type') or '').strip().lower()
    entity_id = str(arguments.get('entity_id') or '').strip()

    node_specs = {
        'drug': ('data_node/node_drug_smiles.csv', 'drugbank_id'),
        'protein': ('data_node/node_protein_sequence.csv', 'gene_symbol'),
        'disease': ('data_node/node_disease_def.csv', 'mondo_id'),
        'cellline': ('data_node/node_cell_line_descriptions.csv', 'cvcl_id'),
        'sideeffect': ('data_node/node_side_effect_description.csv', 'CUI'),
    }

    if entity_type not in node_specs or not entity_id or not workspace_root:
        return {
            'text_summary': '[node_context] Missing entity type, entity id, or workspace root; local node context was unavailable.',
            'structured': {
                'entity_type': entity_type or None,
                'entity_id': entity_id or None,
                'node_found': False,
            },
        }

    relative_path, key_field = node_specs[entity_type]
    csv_path = workspace_root / relative_path
    rows = _load_node_context_rows(str(csv_path), key_field)
    row = rows.get(entity_id)
    if row is None:
        return {
            'text_summary': f'[node_context] No local node context entry was found for {entity_type} {entity_id}.',
            'structured': {
                'entity_type': entity_type,
                'entity_id': entity_id,
                'node_found': False,
                'csv_path': str(csv_path),
            },
        }

    node_name = _clean_node_text(str(row.get('node_name') or ''))
    description = _clean_node_text(str(row.get('description') or ''))
    sequence = _clean_node_text(str(row.get('sequence') or ''))
    smiles = _clean_node_text(str(row.get('smiles') or ''))

    summary_parts = [f'Local node context for {entity_type} {entity_id}.']
    if node_name:
        summary_parts.append(f'Name: {node_name}.')
    if description:
        summary_parts.append(f'Description: {description}')
    if smiles:
        summary_parts.append(f'SMILES: {smiles}')
    if sequence:
        preview = sequence[:80] + ('...' if len(sequence) > 80 else '')
        summary_parts.append(f'Sequence preview: {preview}')

    return {
        'text_summary': ' '.join(summary_parts),
        'structured': {
            'entity_type': entity_type,
            'entity_id': entity_id,
            'node_found': True,
            'node_name': node_name or None,
            'description': description or None,
            'sequence': sequence or None,
            'smiles': smiles or None,
            'csv_path': str(csv_path),
        },
    }


def _parse_json_object(text: str) -> Optional[Dict[str, Any]]:
    candidate = text.strip()
    if not candidate:
        return None
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass
    start = candidate.find('{')
    end = candidate.rfind('}')
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(candidate[start:end + 1])
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _graph_reasoner(arguments: Dict[str, Any]) -> Dict[str, Any]:
    review = _normalize_review_context(arguments.get('review_context'))
    api_key = _read_text_file(arguments.get('openrouter_api_key_path'))
    base_url = str(arguments.get('openrouter_base_url') or 'http://localhost:8000/v1').rstrip('/')
    model = str(arguments.get('openrouter_model') or DEFAULT_OPENROUTER_MODEL).strip()
    if not api_key:
        api_key = 'local'
    graph_summary = str(arguments.get('graph_summary') or '').strip()
    graph_structured = arguments.get('graph_structured')
    relationship_type = str(arguments.get('relationship_type') or '').strip()

    from prompts import get_prompt_config
    from prompts.common import GRAPH_REASONER_SYSTEM, GRAPH_REASONER_INSTRUCTIONS
    pcfg = get_prompt_config(relationship_type)

    is_multiclass = pcfg['is_multiclass']
    hyperedge_label = pcfg['graph_hyperedge_label']
    label_desc = pcfg['label_desc']
    label_schema = pcfg['label_schema']

    instructions = [i.format(hyperedge_label=hyperedge_label, label_desc=label_desc)
                    for i in GRAPH_REASONER_INSTRUCTIONS]
    instructions.extend(pcfg.get('extra_instructions', []))

    prompt_payload = {
        'task': f'Act as the graph-side expert in the current debate and decide your vote for the queried {hyperedge_label}.',
        'decision_space': {
            'recommended_label': label_desc,
            'stance': ['supports', 'contradicts'],
            'strength': ['strong', 'moderate', 'weak'],
        },
        'instructions': instructions,
        'review_context': review,
        'graph_summary': graph_summary,
        'graph_structured': graph_structured,
        'response_schema': {
            'recommended_label': label_schema,
            'stance': 'supports or contradicts',
            'strength': 'strong, moderate, or weak',
            'claim': 'a concise first-person expert statement; if debate context exists, explicitly support or challenge another expert by role',
        },
    }

    response = _http_post(
        f'{base_url}/chat/completions',
        json_payload={
            'model': model,
            'temperature': 0,
            'response_format': {'type': 'json_object'},
            'messages': [
                {
                    'role': 'system',
                    'content': GRAPH_REASONER_SYSTEM,
                },
                {
                    'role': 'user',
                    'content': json.dumps(prompt_payload, ensure_ascii=False),
                },
            ],
        },
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
        timeout=45,
    )

    if not response.ok:
        raise ValueError(
            f'graph_reasoner OpenRouter call failed with status {response.status_code}.'
        )

    try:
        payload = response.json()
    except Exception:
        payload = None

    content = ''
    if isinstance(payload, dict):
        choices = payload.get('choices') or []
        if isinstance(choices, list) and choices:
            message = choices[0].get('message') if isinstance(choices[0], dict) else None
            if isinstance(message, dict):
                content = str(message.get('content') or '')

    parsed = _parse_json_object(content)
    if not parsed:
        raise ValueError('graph_reasoner returned unreadable JSON content.')

    label = _parse_label(parsed.get('recommended_label'), relationship_type)
    stance = parsed.get('stance')
    if stance not in ('supports', 'contradicts'):
        stance = _label_to_stance(label)
    strength = parsed.get('strength')
    if strength not in ('strong', 'moderate', 'weak'):
        strength = 'moderate' if label >= 1 else 'weak'
    claim = _ensure_first_person_claim(parsed.get('claim'), 'graph', label)

    return {
        'text_summary': f'[graph_reasoner] Graph-side expert vote {label}: {claim}',
        'structured': {
            'recommended_label': label,
            'stance': stance,
            'strength': strength,
            'claim': claim,
            'model': model,
        },
    }


def _biomedical_expert_reasoner(arguments: Dict[str, Any]) -> Dict[str, Any]:
    review = _normalize_review_context(arguments.get('review_context'))
    api_key = _read_text_file(arguments.get('openrouter_api_key_path'))
    base_url = str(arguments.get('openrouter_base_url') or 'http://localhost:8000/v1').rstrip('/')
    model = str(arguments.get('openrouter_model') or DEFAULT_OPENROUTER_MODEL).strip()
    if not api_key:
        api_key = 'local'
    role = str(arguments.get('role') or 'biomedical').strip().lower() or 'biomedical'
    evidence_summary = str(arguments.get('evidence_summary') or '').strip()
    evidence_structured = arguments.get('evidence_structured')
    entity_context = arguments.get('entity_context')

    relationship_type = ''
    if isinstance(entity_context, dict):
        relationship_type = str(entity_context.get('relationshipType') or '').strip()

    # Resolve prompt config — role-based override for sideeffect / cellline agents
    from prompts import get_prompt_config
    from prompts.common import BIOMEDICAL_EXPERT_SYSTEM, BIOMEDICAL_EXPERT_INSTRUCTIONS
    if role == 'sideeffect' and not relationship_type:
        pcfg = get_prompt_config('drug_drug_sideeffect')
    elif role == 'cellline' and not relationship_type:
        pcfg = get_prompt_config('drug_drug_cell-line')
    else:
        pcfg = get_prompt_config(relationship_type)

    is_multiclass = pcfg['is_multiclass']
    hyperedge_label = pcfg['expert_hyperedge_label']
    hyperedge_short = hyperedge_label.split('(')[0].strip()
    label_desc = pcfg['label_desc']
    label_schema = pcfg['label_schema']
    vote_instruction = pcfg['vote_instruction']

    instructions = [i.format(hyperedge_short=hyperedge_short, label_desc=label_desc,
                             vote_instruction=vote_instruction)
                    for i in BIOMEDICAL_EXPERT_INSTRUCTIONS]
    instructions.extend(pcfg.get('extra_instructions', []))

    prompt_payload = {
        'task': f'Act as the {role}-side expert in the current debate and decide your vote on the queried {hyperedge_label}.',
        'decision_space': {
            'recommended_label': label_desc,
            'stance': ['supports', 'contradicts'],
            'strength': ['strong', 'moderate', 'weak'],
        },
        'instructions': instructions,
        'review_context': review,
        'entity_context': entity_context,
        'evidence_summary': evidence_summary,
        'evidence_structured': evidence_structured,
        'response_schema': {
            'recommended_label': label_schema,
            'stance': 'supports or contradicts',
            'strength': 'strong, moderate, or weak',
            'claim': 'a concise first-person expert statement integrating retrieved evidence and biomedical reasoning; if debate context exists, explicitly support or challenge another expert by role',
            'retrieved_evidence_basis': ['short bullets naming the concrete retrieved facts actually used'],
            'knowledge_based_inference': 'short note describing the model-based biomedical inference used, or empty string',
        },
    }

    response = _http_post(
        f'{base_url}/chat/completions',
        json_payload={
            'model': model,
            'temperature': 0,
            'response_format': {'type': 'json_object'},
            'messages': [
                {
                    'role': 'system',
                    'content': BIOMEDICAL_EXPERT_SYSTEM,
                },
                {
                    'role': 'user',
                    'content': json.dumps(prompt_payload, ensure_ascii=False),
                },
            ],
        },
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
        timeout=45,
    )

    if not response.ok:
        raise ValueError(
            f'biomedical_expert_reasoner OpenRouter call failed with status {response.status_code}.'
        )

    try:
        payload = response.json()
    except Exception:
        payload = None

    content = ''
    if isinstance(payload, dict):
        choices = payload.get('choices') or []
        if isinstance(choices, list) and choices:
            message = choices[0].get('message') if isinstance(choices[0], dict) else None
            if isinstance(message, dict):
                content = str(message.get('content') or '')

    parsed = _parse_json_object(content)
    if not parsed:
        raise ValueError('biomedical_expert_reasoner returned unreadable JSON content.')

    label = _parse_label(parsed.get('recommended_label'), relationship_type)
    stance = parsed.get('stance')
    if stance not in ('supports', 'contradicts'):
        stance = _label_to_stance(label)
    strength = parsed.get('strength')
    if strength not in ('strong', 'moderate', 'weak'):
        strength = 'moderate' if label >= 1 else 'weak'
    claim = _ensure_first_person_claim(parsed.get('claim'), role, label)
    retrieved_basis = parsed.get('retrieved_evidence_basis')
    if not isinstance(retrieved_basis, list):
        retrieved_basis = []
    retrieved_basis = [
        str(value).strip() for value in retrieved_basis if str(value).strip()
    ][:5]
    knowledge_based_inference = str(parsed.get('knowledge_based_inference') or '').strip()

    return {
        'text_summary': f'[biomedical_expert_reasoner] {role.capitalize()}-side expert vote {label}: {claim}',
        'structured': {
            'recommended_label': label,
            'stance': stance,
            'strength': strength,
            'claim': claim,
            'retrieved_evidence_basis': retrieved_basis,
            'knowledge_based_inference': knowledge_based_inference,
            'model': model,
            'role': role,
        },
    }


def _hypothesis_generator(arguments: Dict[str, Any]) -> Dict[str, Any]:
    api_key = _read_text_file(arguments.get('openrouter_api_key_path'))
    if not api_key:
        api_key = 'local'

    base_url = str(arguments.get('openrouter_base_url') or 'http://localhost:8000/v1').rstrip('/')
    model = str(arguments.get('openrouter_model') or DEFAULT_OPENROUTER_MODEL).strip()
    sample = arguments.get('sample')
    if not isinstance(sample, dict):
        raise ValueError('hypothesis_generator requires a valid sample object.')

    relationship_type = str(sample.get('relationshipType') or '').strip() or 'unknown'
    entity_dict = sample.get('entityDict')
    if not isinstance(entity_dict, dict):
        raise ValueError('hypothesis_generator requires sample.entityDict as an object.')

    prompt_payload = {
        'task': 'Generate the initial hypothesis set for a biomedical hyperedge debate. Use relationship-agnostic structure and avoid task-specific assumptions (for example, do not force protein-centric checks).',
        'instructions': [
            'Return strict JSON only.',
            'Model the entire queried hyperedge first, then propose criteria hypotheses for different expert roles.',
            'Do not assume a fixed triplet schema; use only provided relationshipType and entities.',
            'Keep each statement concise and testable.',
            'targeted_roles entries must be chosen from: drug, protein, disease, sideeffect, cellline, graph.',
            'Provide at least 3 criteria items.',
        ],
        'sample': {
            'relationshipType': relationship_type,
            'entityDict': entity_dict,
        },
        'response_schema': {
            'positive_root_statement': 'string',
            'negative_root_statement': 'string',
            'criteria': [
                {
                    'statement': 'string',
                    'topic_key': 'string such as criterion.drug-mechanism',
                    'targeted_roles': ['array of role strings'],
                    'required_checks': ['array of short checks'],
                }
            ],
        },
    }

    response = _http_post(
        f'{base_url}/chat/completions',
        json_payload={
            'model': model,
            'temperature': 0,
            'response_format': {'type': 'json_object'},
            'messages': [
                {
                    'role': 'system',
                    'content': 'You are a biomedical hypothesis planner. Output valid JSON only and follow the requested schema exactly.',
                },
                {
                    'role': 'user',
                    'content': json.dumps(prompt_payload, ensure_ascii=False),
                },
            ],
        },
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
        timeout=45,
    )

    if not response.ok:
        raise ValueError(
            f'hypothesis_generator OpenRouter call failed with status {response.status_code}.'
        )

    payload = response.json()
    content = ''
    if isinstance(payload, dict):
        choices = payload.get('choices') or []
        if isinstance(choices, list) and choices:
            message = choices[0].get('message') if isinstance(choices[0], dict) else None
            if isinstance(message, dict):
                content = str(message.get('content') or '')

    parsed = _parse_json_object(content)
    if not parsed:
        raise ValueError('hypothesis_generator returned unreadable JSON content.')

    return {
        'text_summary': '[hypothesis_generator] LLM produced initial hypothesis plan.',
        'structured': {
            'positive_root_statement': parsed.get('positive_root_statement'),
            'negative_root_statement': parsed.get('negative_root_statement'),
            'criteria': parsed.get('criteria'),
            'model': model,
            'relationship_type': relationship_type,
        },
    }


def _round_objective_planner(arguments: Dict[str, Any]) -> Dict[str, Any]:
    api_key = _read_text_file(arguments.get('openrouter_api_key_path'))
    if not api_key:
        api_key = 'local'

    base_url = str(arguments.get('openrouter_base_url') or 'http://localhost:8000/v1').rstrip('/')
    model = str(arguments.get('openrouter_model') or DEFAULT_OPENROUTER_MODEL).strip()
    round_number = int(arguments.get('round_number') or 1)
    relationship_type = str(arguments.get('relationship_type') or '').strip() or 'unknown'
    all_roles = arguments.get('all_roles')
    shared_evidence_board = arguments.get('shared_evidence_board')
    previous_round = arguments.get('previous_round')

    if not isinstance(all_roles, list) or not all_roles:
        raise ValueError('round_objective_planner requires non-empty all_roles list.')
    if not isinstance(shared_evidence_board, dict):
        raise ValueError('round_objective_planner requires shared_evidence_board object.')

    prompt_payload = {
        'task': 'Generate the next-round debate objective for a multi-agent biomedical hyperedge discussion.',
        'instructions': [
            'Use previous-round vote conflicts, disagreements, and evidence board as primary signal.',
            'Focus on one decisive unresolved question instead of broad restatement.',
            'Keep outputs concise and action-oriented for immediate next-round use.',
            'Return strict JSON only.',
            'target_roles must be selected from the provided all_roles.',
        ],
        'input': {
            'round_number': round_number,
            'relationship_type': relationship_type,
            'all_roles': all_roles,
            'shared_evidence_board': shared_evidence_board,
            'previous_round': previous_round,
        },
        'response_schema': {
            'title': 'string',
            'directive': 'string',
            'response_requirement': 'string',
            'shared_debate_question': 'string or empty',
            'target_roles': ['array of role strings'],
        },
    }

    response = _http_post(
        f'{base_url}/chat/completions',
        json_payload={
            'model': model,
            'temperature': 0,
            'response_format': {'type': 'json_object'},
            'messages': [
                {
                    'role': 'system',
                    'content': 'You are a debate-round planner for biomedical multi-agent reasoning. Output valid JSON only and follow the schema exactly.',
                },
                {
                    'role': 'user',
                    'content': json.dumps(prompt_payload, ensure_ascii=False),
                },
            ],
        },
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
        timeout=45,
    )

    if not response.ok:
        raise ValueError(
            f'round_objective_planner OpenRouter call failed with status {response.status_code}.'
        )

    payload = response.json()
    content = ''
    if isinstance(payload, dict):
        choices = payload.get('choices') or []
        if isinstance(choices, list) and choices:
            message = choices[0].get('message') if isinstance(choices[0], dict) else None
            if isinstance(message, dict):
                content = str(message.get('content') or '')

    parsed = _parse_json_object(content)
    if not parsed:
        raise ValueError('round_objective_planner returned unreadable JSON content.')

    return {
        'text_summary': '[round_objective_planner] LLM produced round objective.',
        'structured': {
            'title': parsed.get('title'),
            'directive': parsed.get('directive'),
            'response_requirement': parsed.get('response_requirement'),
            'shared_debate_question': parsed.get('shared_debate_question'),
            'target_roles': parsed.get('target_roles'),
            'model': model,
            'round_number': round_number,
            'relationship_type': relationship_type,
        },
    }


def _drug_researcher(
    drugbank_id: Optional[str],
    review_context: Optional[Dict[str, Any]] = None,
    workspace_root: Optional[str] = None,
) -> Dict[str, Any]:
    did = (drugbank_id or '').strip()
    review = _normalize_review_context(review_context)
    if not did:
        return {
            'text_summary': '[drug_researcher] No DrugBank ID provided; unable to look up a drug profile.',
            'structured': {
                'drugbank_id': None,
                'review_context': review,
                'name': None,
                'mechanism_of_action': None,
                'max_clinical_phase': None,
                'approved_indications': [],
                'safety_flags': [],
                'sources': [],
            },
        }

    chembl_molecule = _fetch_chembl_molecule_from_drugbank(did)
    if not isinstance(chembl_molecule, dict):
        return {
            'text_summary': f'[drug_researcher] {did} was not found in ChEMBL; no drug profile was produced.',
            'structured': {
                'drugbank_id': did,
                'review_context': review,
                'name': None,
                'mechanism_of_action': None,
                'max_clinical_phase': None,
                'approved_indications': [],
                'safety_flags': [],
                'sources': [
                    {
                        'type': 'chembl_api',
                        'base_url': 'https://www.ebi.ac.uk/chembl/api/data',
                        'drugbank_id': did,
                        'molecule_chembl_id': None,
                    }
                ],
            },
        }

    chembl_id = str(chembl_molecule.get('molecule_chembl_id') or '') or None
    if not chembl_id:
        return {
            'text_summary': f'[drug_researcher] ChEMBL returned no molecule_chembl_id for {did}; no drug profile was produced.',
            'structured': {
                'drugbank_id': did,
                'review_context': review,
                'name': None,
                'mechanism_of_action': None,
                'max_clinical_phase': None,
                'approved_indications': [],
                'safety_flags': [],
                'sources': [
                    {
                        'type': 'chembl_api',
                        'base_url': 'https://www.ebi.ac.uk/chembl/api/data',
                        'drugbank_id': did,
                        'molecule_chembl_id': None,
                    }
                ],
            },
        }

    name = chembl_molecule.get('pref_name')
    max_phase = chembl_molecule.get('max_phase')
    mechanisms = _fetch_chembl_mechanisms(chembl_id)
    indications = _fetch_chembl_indications(chembl_id)
    target_protein = str(review.get('targetProteinId') or '').strip() or None
    local_protein_row = _node_context_row(workspace_root, 'protein', target_protein)
    local_protein_context = None
    if local_protein_row:
        local_protein_context = {
            'gene_symbol': target_protein,
            'node_name': _clean_node_text(str(local_protein_row.get('node_name') or '')) or None,
            'description': _clean_node_text(str(local_protein_row.get('description') or '')) or None,
        }
    protein_focus_keywords = _protein_focus_keywords(target_protein, workspace_root)
    protein_keyword_hits: List[str] = []
    direct_mechanism_matches: List[Dict[str, Any]] = []
    if target_protein:
        for mechanism in mechanisms:
            if not isinstance(mechanism, dict):
                continue
            mechanism_text = ' '.join([
                str(mechanism.get('mechanism_of_action') or ''),
                str(mechanism.get('action_type') or ''),
            ]).strip()
            matched = _text_contains_any(mechanism_text, protein_focus_keywords)
            if matched:
                protein_keyword_hits.extend([
                    keyword for keyword in matched if keyword not in protein_keyword_hits
                ])
                direct_mechanism_matches.append({
                    'mechanism_of_action': mechanism.get('mechanism_of_action'),
                    'action_type': mechanism.get('action_type'),
                    'target_chembl_id': mechanism.get('target_chembl_id'),
                    'matched_keywords': matched,
                })

    summary_parts: List[str] = [f'Drug profile for {did}.']
    if name and str(name) != 'nan':
        summary_parts.append(f'Name: {name}.')

    moa_texts: List[str] = []
    for mechanism in mechanisms:
        moa = mechanism.get('mechanism_of_action')
        if isinstance(moa, str) and moa.strip() and moa.strip() not in moa_texts:
            moa_texts.append(moa.strip())
    if moa_texts:
        summary_parts.append(
            'Mechanism-of-action hints (from ChEMBL; not task labels): '
            + '; '.join(moa_texts[:3])
            + '.'
        )
    if local_protein_context and local_protein_context.get('node_name'):
        summary_parts.append(
            f'Local protein grounding for {target_protein}: {local_protein_context.get("node_name")}. '
            'External mechanism text was interpreted against this local alias context first.'
        )
    if direct_mechanism_matches:
        summary_parts.append(
            f'Targeted mechanism review for {target_protein} found keyword-aligned mechanism evidence: '
            + '; '.join([
                str(item.get('mechanism_of_action') or '')
                for item in direct_mechanism_matches[:3]
                if str(item.get('mechanism_of_action') or '').strip()
            ])
            + '.'
        )
    elif target_protein and str(review.get('focusMode') or '') == 'mechanism_only':
        summary_parts.append(
            f'Targeted mechanism review for {target_protein} did not find an explicit mechanism string aligned to the locally grounded protein aliases in the returned ChEMBL mechanism fields.'
        )

    indication_terms: List[str] = []
    for indication in indications:
        term = indication.get('mesh_heading') or indication.get('efo_term')
        if isinstance(term, str) and term.strip() and term.strip() not in indication_terms:
            indication_terms.append(term.strip())
    target_disease = str(review.get('targetDiseaseId') or '').strip() or None
    disease_indication_hits = _text_contains_any(
        ' '.join(indication_terms),
        _disease_focus_keywords(target_disease),
    ) if target_disease else []
    if indication_terms and str(review.get('focusMode') or '') != 'mechanism_only':
        summary_parts.append(
            'Reported clinical indications (from ChEMBL drug_indication; not task labels) include: '
            + ', '.join(indication_terms[:5])
            + '.'
        )
    if target_disease and disease_indication_hits:
        summary_parts.append(
            f'Task-shaped review for disease {target_disease} found indication overlap: '
            + ', '.join(disease_indication_hits[:5])
            + '.'
        )

    targeted_review = _build_targeted_review_summary(
        review,
        [
            f'Protein grounding aliases: {", ".join(protein_focus_keywords[:8])}.' if protein_focus_keywords else '',
            f'Protein keyword hits in mechanism fields: {", ".join(protein_keyword_hits[:5])}.' if protein_keyword_hits else '',
            f'Disease indication hits: {", ".join(disease_indication_hits[:5])}.' if disease_indication_hits else '',
            'Non-mechanism indication context was intentionally de-emphasized for this round.'
            if str(review.get('focusMode') or '') == 'mechanism_only' else '',
        ],
    )
    if targeted_review:
        summary_parts.append(targeted_review)

    if len(summary_parts) == 1:
        summary_parts.append(
            'No additional mechanism-of-action or indication data is available from external API sources.'
        )

    return {
        'text_summary': ' '.join(summary_parts),
        'structured': {
            'drugbank_id': did,
            'review_context': review,
            'name': name,
            'mechanism_of_action': [
                {
                    'description': mechanism.get('mechanism_of_action'),
                    'action_type': mechanism.get('action_type'),
                    'molecular_mechanism': mechanism.get('molecular_mechanism'),
                    'target_chembl_id': mechanism.get('target_chembl_id'),
                }
                for mechanism in mechanisms
                if isinstance(mechanism, dict) and mechanism.get('mechanism_of_action')
            ] or None,
            'max_clinical_phase': max_phase,
            'approved_indications': [
                {
                    'efo_id': indication.get('efo_id'),
                    'efo_term': indication.get('efo_term'),
                    'mesh_id': indication.get('mesh_id'),
                    'mesh_heading': indication.get('mesh_heading'),
                    'max_phase_for_ind': indication.get('max_phase_for_ind'),
                }
                for indication in indications
                if isinstance(indication, dict)
            ],
            'safety_flags': _extract_chembl_safety_flags(chembl_molecule),
            'targeted_review': {
                'focus_mode': review.get('focusMode'),
                'focal_question': review.get('focalQuestion'),
                'target_protein_id': target_protein,
                'target_disease_id': target_disease,
                'protein_focus_keywords': protein_focus_keywords,
                'local_protein_context': local_protein_context,
                'direct_mechanism_matches': direct_mechanism_matches,
                'protein_keyword_hits': protein_keyword_hits,
                'peer_findings': _non_empty_strings(review.get('peerFindings')),
            },
            'task_relevance': {
                'target_protein_id': target_protein,
                'target_disease_id': target_disease,
                'direct_target_match': bool(direct_mechanism_matches),
                'target_alignment_state': (
                    'matched'
                    if direct_mechanism_matches else
                    'local-grounded-unresolved'
                    if target_protein and protein_focus_keywords else
                    'unresolved'
                ),
                'protein_keyword_hits': protein_keyword_hits,
                'disease_indication_hits': disease_indication_hits,
                'mechanism_record_count': len(mechanisms),
                'evidence_summary': (
                    f'direct mechanism match to {target_protein}; disease indication overlap: {_list_text(disease_indication_hits)}'
                    if direct_mechanism_matches else
                    f'mechanism alignment unresolved for locally grounded target {target_protein}; disease indication overlap: {_list_text(disease_indication_hits)}'
                ),
            },
            'sources': [
                {
                    'type': 'chembl_api',
                    'base_url': 'https://www.ebi.ac.uk/chembl/api/data',
                    'drugbank_id': did,
                    'molecule_chembl_id': chembl_id,
                }
            ],
        },
    }


def _protein_researcher(
    gene_symbol: Optional[str],
    review_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    gene = (gene_symbol or '').strip()
    review = _normalize_review_context(review_context)
    if not gene:
        return {
            'text_summary': '[protein_researcher] No gene symbol provided; unable to look up a protein profile.',
            'structured': {
                'gene_symbol': None,
                'review_context': review,
                'protein_name': None,
                'uniprot_accession': None,
                'organism': None,
                'function_description': None,
                'biological_processes': [],
                'subcellular_localization': [],
                'reactome_pathways': [],
                'sources': [],
            },
        }

    entry = _fetch_uniprot_entry_by_gene(gene)
    if not isinstance(entry, dict):
        return {
            'text_summary': f'[protein_researcher] UniProt lookup failed for {gene}; no protein profile was produced.',
            'structured': {
                'gene_symbol': gene,
                'review_context': review,
                'protein_name': None,
                'uniprot_accession': None,
                'organism': None,
                'function_description': None,
                'biological_processes': [],
                'subcellular_localization': [],
                'reactome_pathways': [],
                'sources': [
                    {
                        'type': 'uniprot_api',
                        'base_url': 'https://rest.uniprot.org/uniprotkb/search',
                        'gene_symbol': gene,
                    }
                ],
            },
        }

    accession = entry.get('primaryAccession')
    protein_name = _extract_uniprot_protein_name(entry)
    organism = ((entry.get('organism') or {}) if isinstance(entry.get('organism'), dict) else {}).get('scientificName')
    function_texts = _extract_uniprot_comment_texts(entry, 'FUNCTION')
    function_description = function_texts[0] if function_texts else None
    biological_processes = _extract_uniprot_go_terms(entry, namespace_prefix='P')

    subcellular_localization = _extract_uniprot_comment_texts(entry, 'SUBCELLULAR LOCATION')
    if not subcellular_localization:
        subcellular_localization = _extract_uniprot_go_terms(entry, namespace_prefix='C')

    reactome_pathways: List[Dict[str, Any]] = []
    if isinstance(accession, str) and accession.strip():
        reactome_pathways = _fetch_reactome_pathways(accession.strip())
    if not reactome_pathways:
        reactome_pathways = _extract_reactome_xrefs_from_uniprot(entry)
    target_disease = str(review.get('targetDiseaseId') or '').strip() or None
    disease_keyword_hits = _text_contains_any(
        ' '.join([
            function_description or '',
            ' '.join(biological_processes),
            ' '.join([
                str(pathway.get('pathway_name') or pathway.get('display_name') or '')
                for pathway in reactome_pathways
                if isinstance(pathway, dict)
            ]),
        ]),
        _disease_focus_keywords(target_disease),
    ) if target_disease else []

    summary_parts: List[str] = [f'Protein profile for {gene}.']
    if protein_name:
        summary_parts.append(f'Protein: {protein_name}.')
    if organism:
        summary_parts.append(f'Organism: {organism}.')
    if function_description:
        summary_parts.append('Function description (from UniProt): ' + function_description)
    if biological_processes:
        summary_parts.append(
            'Key biological processes (from UniProt GO annotations) include: '
            + ', '.join(biological_processes[:5])
            + '.'
        )
    if subcellular_localization:
        summary_parts.append(
            'Reported subcellular localization includes: '
            + '; '.join(subcellular_localization[:4])
            + '.'
        )
    if reactome_pathways:
        summary_parts.append(
            'Reactome pathways include: '
            + ', '.join([
                str(pathway.get('pathway_name') or pathway.get('display_name') or pathway.get('stId') or '')
                for pathway in reactome_pathways[:5]
                if isinstance(pathway, dict)
            ])
            + '.'
        )
    if target_disease and str(review.get('focusMode') or '') == 'disease_alignment':
        if disease_keyword_hits:
            summary_parts.append(
                f'Targeted disease-alignment review for {target_disease} found matching disease-related terms in protein annotations: '
                + ', '.join(disease_keyword_hits[:5])
                + '.'
            )
        else:
            summary_parts.append(
                f'Targeted disease-alignment review for {target_disease} did not find clear disease-specific terms in the available UniProt or Reactome annotations.'
            )
    targeted_review = _build_targeted_review_summary(
        review,
        [
            f'Disease keyword hits in protein annotations: {", ".join(disease_keyword_hits[:5])}.' if disease_keyword_hits else '',
            'This round emphasized disease-alignment evidence over generic localization detail.'
            if str(review.get('focusMode') or '') == 'disease_alignment' else '',
        ],
    )
    if targeted_review:
        summary_parts.append(targeted_review)
    matched_biological_processes = [
        process for process in biological_processes
        if _text_contains_any(process, _disease_focus_keywords(target_disease))
    ] if target_disease else []
    matched_reactome_pathways = [
        str(pathway.get('pathway_name') or pathway.get('display_name') or '')
        for pathway in reactome_pathways
        if isinstance(pathway, dict)
        and _text_contains_any(
            str(pathway.get('pathway_name') or pathway.get('display_name') or ''),
            _disease_focus_keywords(target_disease),
        )
    ] if target_disease else []
    if len(summary_parts) == 1:
        summary_parts.append('No additional UniProt or Reactome annotations were available.')

    return {
        'text_summary': ' '.join(summary_parts),
        'structured': {
            'gene_symbol': gene,
            'review_context': review,
            'protein_name': protein_name,
            'uniprot_accession': accession,
            'organism': organism,
            'function_description': function_description,
            'biological_processes': biological_processes,
            'subcellular_localization': subcellular_localization,
            'reactome_pathways': reactome_pathways,
            'targeted_review': {
                'focus_mode': review.get('focusMode'),
                'focal_question': review.get('focalQuestion'),
                'target_disease_id': target_disease,
                'disease_keyword_hits': disease_keyword_hits,
                'peer_findings': _non_empty_strings(review.get('peerFindings')),
            },
            'task_relevance': {
                'target_disease_id': target_disease,
                'disease_keyword_hits': disease_keyword_hits,
                'matched_biological_processes': matched_biological_processes,
                'matched_reactome_pathways': matched_reactome_pathways,
                'evidence_summary': (
                    f'disease keyword hits: {_list_text(disease_keyword_hits)}; matched processes: {_list_text(matched_biological_processes)}; matched pathways: {_list_text(matched_reactome_pathways)}'
                ),
            },
            'sources': [
                {
                    'type': 'uniprot_api',
                    'base_url': 'https://rest.uniprot.org/uniprotkb/search',
                    'gene_symbol': gene,
                    'uniprot_accession': accession,
                },
                {
                    'type': 'reactome_api',
                    'base_url': 'https://reactome.org/ContentService/data/mapping/UniProt',
                    'uniprot_accession': accession,
                },
            ],
        },
    }


def _disease_researcher(
    mondo_id: Optional[str],
    review_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    disease_id = _normalize_mondo_id(mondo_id)
    review = _normalize_review_context(review_context)
    if not disease_id:
        return {
            'text_summary': '[disease_researcher] No MONDO ID provided; unable to look up a disease profile.',
            'structured': {
                'mondo_id': None,
                'review_context': review,
                'name': None,
                'definition': None,
                'classification': [],
                'associated_targets': [],
                'standard_treatments': [],
                'db_xrefs': [],
                'sources': [],
            },
        }

    open_targets = _fetch_open_targets_disease_profile(disease_id)

    name = None
    definition = None
    classification: List[Dict[str, Any]] = []
    associated_targets: List[Dict[str, Any]] = []
    standard_treatments: List[Dict[str, Any]] = []
    db_xrefs: List[str] = []

    if isinstance(open_targets, dict):
        name = open_targets.get('name') or name
        definition = open_targets.get('description') or definition
        db_xrefs = [str(value) for value in open_targets.get('dbXRefs', []) if str(value).strip()]
        classification = [
            {'id': row.get('id'), 'name': row.get('name'), 'source': 'therapeutic_area'}
            for row in open_targets.get('therapeuticAreas', [])
            if isinstance(row, dict)
        ]
        classification.extend([
            {'id': row.get('id'), 'name': row.get('name'), 'source': 'parent_disease'}
            for row in open_targets.get('parents', [])
            if isinstance(row, dict)
        ])
        associated_targets = [
            {
                'id': ((row.get('target') or {}) if isinstance(row.get('target'), dict) else {}).get('id'),
                'approved_symbol': ((row.get('target') or {}) if isinstance(row.get('target'), dict) else {}).get('approvedSymbol'),
                'approved_name': ((row.get('target') or {}) if isinstance(row.get('target'), dict) else {}).get('approvedName'),
                'score': row.get('score'),
            }
            for row in ((open_targets.get('associatedTargets') or {}).get('rows', []) if isinstance(open_targets.get('associatedTargets'), dict) else [])
            if isinstance(row, dict)
        ]
        standard_treatments = _deduplicate_known_drugs([
            row
            for row in ((open_targets.get('knownDrugs') or {}).get('rows', []) if isinstance(open_targets.get('knownDrugs'), dict) else [])
            if isinstance(row, dict)
        ])

    target_protein = str(review.get('targetProteinId') or '').strip() or None
    matched_targets = [
        row
        for row in associated_targets
        if isinstance(row, dict)
        and str(row.get('approved_symbol') or '').strip().upper() == str(target_protein or '').upper()
    ]
    matched_treatment_targets = [
        str(row.get('approved_symbol') or '').strip()
        for row in standard_treatments
        if isinstance(row, dict)
        and str(row.get('approved_symbol') or '').strip().upper() == str(target_protein or '').upper()
    ]
    protein_keyword_hits = _text_contains_any(
        ' '.join([
            str(name or ''),
            str(definition or ''),
            ' '.join([
                str(item.get('name') or item.get('id') or '')
                for item in classification
                if isinstance(item, dict)
            ]),
        ]),
        _protein_focus_keywords(target_protein),
    ) if target_protein else []

    if not name and not definition and not associated_targets and not standard_treatments:
        return {
            'text_summary': f'[disease_researcher] No disease profile was produced for {disease_id} from Open Targets APIs.',
            'structured': {
                'mondo_id': disease_id,
                'review_context': review,
                'name': None,
                'definition': None,
                'classification': [],
                'associated_targets': [],
                'standard_treatments': [],
                'db_xrefs': [],
                'sources': [
                    {
                        'type': 'open_targets_api',
                        'base_url': 'https://api.platform.opentargets.org/api/v4/graphql',
                        'mondo_id': disease_id,
                    }
                ],
            },
        }

    summary_parts: List[str] = [f'Disease profile for {disease_id}.']
    if name:
        summary_parts.append(f'Name: {name}.')
    if definition:
        summary_parts.append(f'Definition: {definition}')
    if classification:
        summary_parts.append(
            'Classification context includes: '
            + ', '.join([
                str(item.get('name') or item.get('id') or '')
                for item in classification[:5]
                if isinstance(item, dict)
            ])
            + '.'
        )
    if associated_targets:
        summary_parts.append(
            'Core associated targets (from Open Targets) include: '
            + ', '.join([
                f"{item.get('approved_symbol') or item.get('id')} (score {float(item.get('score')):.2f})"
                for item in associated_targets[:5]
                if isinstance(item, dict) and item.get('score') is not None
            ])
            + '.'
        )
    if target_protein and str(review.get('focusMode') or '') == 'target_alignment':
        if matched_targets:
            summary_parts.append(
                f'Targeted target-alignment review found {target_protein} explicitly listed among disease-associated targets.'
            )
        else:
            summary_parts.append(
                f'Targeted target-alignment review did not find {target_protein} in the returned disease-associated target list.'
            )
    if standard_treatments:
        summary_parts.append(
            'Known treatment signals include: '
            + ', '.join([
                f"{item.get('pref_name')} (phase {item.get('phase')})"
                for item in standard_treatments[:5]
                if isinstance(item, dict) and item.get('pref_name')
            ])
            + '.'
        )
    if matched_treatment_targets:
        summary_parts.append(
            f'Task-shaped review found treatment rows that reuse queried protein {target_protein} as a named target.'
        )

    targeted_review = _build_targeted_review_summary(
        review,
        [
            f'Explicit associated-target match for queried protein: {target_protein}.'
            if matched_targets and target_protein else '',
            f'Known treatment rows also reference queried protein {target_protein}.'
            if matched_treatment_targets and target_protein else '',
            f'Queried protein {target_protein} was absent from the returned associated-target list.'
            if target_protein and not matched_targets and str(review.get('focusMode') or '') == 'target_alignment' else '',
        ],
    )
    if targeted_review:
        summary_parts.append(targeted_review)

    return {
        'text_summary': ' '.join(summary_parts),
        'structured': {
            'mondo_id': disease_id,
            'review_context': review,
            'name': name,
            'definition': definition,
            'classification': classification,
            'associated_targets': associated_targets,
            'matched_associated_targets': matched_targets,
            'standard_treatments': standard_treatments,
            'db_xrefs': db_xrefs,
            'orphanet_xrefs': [xref for xref in db_xrefs if str(xref).startswith('Orphanet')],
            'sources': [
                {
                    'type': 'open_targets_api',
                    'base_url': 'https://api.platform.opentargets.org/api/v4/graphql',
                    'mondo_id': disease_id,
                },
                {
                    'type': 'source_note',
                    'note': 'MalaCards does not provide a stable public unauthenticated API endpoint, so it is not queried directly.',
                },
            ],
            'targeted_review': {
                'focus_mode': review.get('focusMode'),
                'focal_question': review.get('focalQuestion'),
                'target_protein_id': target_protein,
                'matched_associated_targets': matched_targets,
                'peer_findings': _non_empty_strings(review.get('peerFindings')),
            },
            'task_relevance': {
                'target_protein_id': target_protein,
                'matched_associated_targets': matched_targets,
                'matched_treatment_targets': matched_treatment_targets,
                'protein_keyword_hits': protein_keyword_hits,
                'evidence_summary': (
                    f'associated-target match count: {len(matched_targets)}; treatment-target matches: {_list_text(matched_treatment_targets)}; protein keyword hits: {_list_text(protein_keyword_hits)}'
                ),
            },
        },
    }


@lru_cache(maxsize=4096)
def _fetch_uniprot_entry_by_gene(gene_symbol: str) -> Optional[Dict[str, Any]]:
    params = {
        'query': f'(gene_exact:{gene_symbol}) AND (reviewed:true)',
        'fields': 'accession,protein_name,cc_function,go_p,cc_subcellular_location,xref_reactome,organism_name',
        'format': 'json',
        'size': 5,
    }
    response = _http_get('https://rest.uniprot.org/uniprotkb/search', params=params, timeout=10)
    if not response.ok:
        raise RuntimeError(
            f'UniProt search API returned HTTP {response.status_code} for gene {gene_symbol!r}.'
        )
    try:
        payload = response.json()
    except Exception:
        raise RuntimeError(
            f'UniProt search API returned unreadable JSON for gene {gene_symbol!r}.'
        )
    results = payload.get('results') or []
    if not results:
        return None
    human_results = [
        row
        for row in results
        if isinstance(row, dict)
        and ((row.get('organism') or {}) if isinstance(row.get('organism'), dict) else {}).get('taxonId') == 9606
    ]
    chosen = human_results[0] if human_results else results[0]
    return chosen if isinstance(chosen, dict) else None


@lru_cache(maxsize=4096)
def _fetch_reactome_pathways(uniprot_accession: str) -> List[Dict[str, Any]]:
    response = _http_get(
        f'https://reactome.org/ContentService/data/mapping/UniProt/{uniprot_accession}/pathways',
        timeout=10,
    )
    if not response.ok:
        raise RuntimeError(
            f'Reactome pathways API returned HTTP {response.status_code} for {uniprot_accession!r}.'
        )
    try:
        payload = response.json()
    except Exception:
        raise RuntimeError(
            f'Reactome pathways API returned unreadable JSON for {uniprot_accession!r}.'
        )
    if not isinstance(payload, list):
        return []
    pathways: List[Dict[str, Any]] = []
    for item in payload[:10]:
        if not isinstance(item, dict):
            continue
        pathways.append({
            'reactome_id': item.get('stId'),
            'pathway_name': item.get('displayName'),
            'species_name': item.get('speciesName'),
            'is_in_disease': item.get('isInDisease'),
        })
    return pathways


@lru_cache(maxsize=4096)
def _fetch_open_targets_disease_profile(mondo_id: str) -> Optional[Dict[str, Any]]:
    ot_id = mondo_id.replace(':', '_')
    query = '''
    query DiseaseProfile($id: String!) {
      disease(efoId: $id) {
        id
        name
        description
        dbXRefs
        therapeuticAreas { id name }
        parents { id name }
        associatedTargets(page: {index: 0, size: 5}) {
          count
          rows {
            score
            target { id approvedSymbol approvedName }
          }
        }
        knownDrugs(size: 8) {
          count
          rows {
            phase
            status
            mechanismOfAction
            prefName
            approvedSymbol
            approvedName
            drugType
          }
        }
      }
    }
    '''
    response = _http_post(
        'https://api.platform.opentargets.org/api/v4/graphql',
        json_payload={'query': query, 'variables': {'id': ot_id}},
        timeout=15,
    )
    if not response.ok:
        raise RuntimeError(
            f'Open Targets GraphQL API returned HTTP {response.status_code} for disease {mondo_id!r}.'
        )
    try:
        payload = response.json()
    except Exception:
        raise RuntimeError(
            f'Open Targets GraphQL API returned unreadable JSON for disease {mondo_id!r}.'
        )
    data = payload.get('data') if isinstance(payload, dict) else None
    disease = data.get('disease') if isinstance(data, dict) else None
    return disease if isinstance(disease, dict) else None


def _extract_uniprot_protein_name(entry: Dict[str, Any]) -> Optional[str]:
    protein_description = entry.get('proteinDescription')
    if not isinstance(protein_description, dict):
        return None
    recommended = protein_description.get('recommendedName')
    if isinstance(recommended, dict):
        full_name = recommended.get('fullName')
        if isinstance(full_name, dict):
            value = full_name.get('value')
            if isinstance(value, str) and value.strip():
                return value.strip()
    for name in protein_description.get('submissionNames') or []:
        if not isinstance(name, dict):
            continue
        full_name = name.get('fullName')
        if isinstance(full_name, dict):
            value = full_name.get('value')
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _extract_uniprot_comment_texts(entry: Dict[str, Any], comment_type: str) -> List[str]:
    values: List[str] = []
    for comment in entry.get('comments') or []:
        if not isinstance(comment, dict):
            continue
        if str(comment.get('commentType') or '') != comment_type:
            continue
        for text in comment.get('texts') or []:
            if not isinstance(text, dict):
                continue
            value = text.get('value')
            if isinstance(value, str) and value.strip() and value.strip() not in values:
                values.append(value.strip())
    return values


def _extract_uniprot_go_terms(entry: Dict[str, Any], namespace_prefix: str) -> List[str]:
    terms: List[str] = []
    for xref in entry.get('uniProtKBCrossReferences') or []:
        if not isinstance(xref, dict):
            continue
        if xref.get('database') != 'GO':
            continue
        for prop in xref.get('properties') or []:
            if not isinstance(prop, dict):
                continue
            if prop.get('key') != 'GoTerm':
                continue
            value = prop.get('value')
            if not isinstance(value, str):
                continue
            prefix = f'{namespace_prefix}:'
            if value.startswith(prefix):
                term = value.split(':', 1)[1].strip()
                if term and term not in terms:
                    terms.append(term)
    return terms


def _extract_reactome_xrefs_from_uniprot(entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    pathways: List[Dict[str, Any]] = []
    for xref in entry.get('uniProtKBCrossReferences') or []:
        if not isinstance(xref, dict):
            continue
        if xref.get('database') != 'Reactome':
            continue
        pathway_name = None
        for prop in xref.get('properties') or []:
            if not isinstance(prop, dict):
                continue
            if prop.get('key') == 'PathwayName':
                value = prop.get('value')
                if isinstance(value, str) and value.strip():
                    pathway_name = value.strip()
                    break
        pathways.append({
            'reactome_id': xref.get('id'),
            'pathway_name': pathway_name,
        })
    return pathways[:10]


def _normalize_mondo_id(mondo_id: Optional[str]) -> Optional[str]:
    value = (mondo_id or '').strip()
    if not value:
        return None
    if value.startswith('MONDO:'):
        return value
    if value.startswith('MONDO_'):
        return 'MONDO:' + value.split('MONDO_', 1)[1]
    return value


def _deduplicate_known_drugs(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    deduped: List[Dict[str, Any]] = []
    seen: set[tuple[str, Any]] = set()
    for row in rows:
        pref_name = str(row.get('prefName') or '').strip()
        phase = row.get('phase')
        key = (pref_name, phase)
        if not pref_name or key in seen:
            continue
        seen.add(key)
        deduped.append({
            'pref_name': pref_name,
            'phase': phase,
            'status': row.get('status'),
            'mechanism_of_action': row.get('mechanismOfAction'),
            'approved_symbol': row.get('approvedSymbol'),
            'approved_name': row.get('approvedName'),
            'drug_type': row.get('drugType'),
        })
    return deduped


def _fetch_chembl_molecule_from_drugbank(drugbank_id: str) -> Optional[Dict[str, Any]]:
    chembl_id = _fetch_chembl_id_from_drugbank(drugbank_id)
    if not chembl_id:
        return None
    return _fetch_chembl_molecule_by_id(chembl_id)


@lru_cache(maxsize=4096)
def _fetch_chembl_id_from_drugbank(drugbank_id: str) -> Optional[str]:
    payload = {'compound': drugbank_id, 'type': 'sourceID', 'sourceID': 2}
    try:
        response = _http_post(
            'https://www.ebi.ac.uk/unichem/api/v1/compounds',
            json_payload=payload,
            timeout=10,
        )
    except Exception:
        return None
    if not response.ok:
        return None
    try:
        response_payload = response.json()
    except Exception:
        return None
    compounds = response_payload.get('compounds') or []
    for compound in compounds:
        if not isinstance(compound, dict):
            continue
        for source in compound.get('sources') or []:
            if not isinstance(source, dict):
                continue
            if int(source.get('id', -1)) != 1:
                continue
            chembl_id = source.get('compoundId')
            if isinstance(chembl_id, str) and chembl_id.strip():
                return chembl_id.strip()
    return None


@lru_cache(maxsize=4096)
def _fetch_chembl_molecule_by_id(chembl_id: str) -> Optional[Dict[str, Any]]:
    try:
        response = _http_get(
            f'https://www.ebi.ac.uk/chembl/api/data/molecule/{chembl_id}',
            params={'format': 'json'},
            timeout=10,
        )
    except Exception:
        return None
    if not response.ok:
        return None
    try:
        payload = response.json()
    except Exception:
        return None
    if isinstance(payload, dict) and payload.get('molecule_chembl_id'):
        return payload
    return None


def _fetch_chembl_mechanisms(chembl_id: str) -> List[Dict[str, Any]]:
    try:
        response = _http_get(
            'https://www.ebi.ac.uk/chembl/api/data/mechanism',
            params={'molecule_chembl_id': chembl_id, 'format': 'json'},
            timeout=10,
        )
    except Exception:
        return []
    if not response.ok:
        return []
    try:
        payload = response.json()
    except Exception:
        return []
    mechanisms = payload.get('mechanisms') or []
    return [item for item in mechanisms if isinstance(item, dict)]


def _fetch_chembl_indications(chembl_id: str) -> List[Dict[str, Any]]:
    try:
        response = _http_get(
            'https://www.ebi.ac.uk/chembl/api/data/drug_indication',
            params={'molecule_chembl_id': chembl_id, 'format': 'json', 'limit': 200},
            timeout=10,
        )
    except Exception:
        return []
    if not response.ok:
        return []
    try:
        payload = response.json()
    except Exception:
        return []
    indications = payload.get('drug_indications') or []
    return [item for item in indications if isinstance(item, dict)]


def _extract_chembl_safety_flags(chembl_molecule: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(chembl_molecule, dict):
        return []
    flags: List[str] = []
    try:
        if chembl_molecule.get('black_box_warning'):
            flags.append('black_box_warning')
        if chembl_molecule.get('withdrawn_flag'):
            flags.append('withdrawn')
    except Exception:
        return flags
    return flags


def _fetch_openfda_ae_drugs(term: str) -> List[Dict[str, Any]]:
    """Query openFDA drug adverse events API for top drugs reporting a given MedDRA PT term."""
    try:
        response = _http_get(
            'https://api.fda.gov/drug/event.json',
            params={
                'search': f'patient.reaction.reactionmeddrapt.exact:"{term}"',
                'count': 'patient.drug.openfda.generic_name.exact',
                'limit': 10,
            },
            timeout=10,
        )
        if not response.ok:
            return []
        payload = response.json()
        results = payload.get('results') or []
        return [
            {'term': str(item.get('term') or ''), 'count': int(item.get('count') or 0)}
            for item in results
            if isinstance(item, dict) and item.get('term')
        ]
    except Exception:
        return []


def _sideeffect_researcher(
    cui: Optional[str],
    drug_ids: Optional[List[str]] = None,
    review_context: Optional[Dict[str, Any]] = None,
    workspace_root: Optional[str] = None,
) -> Dict[str, Any]:
    cid = (cui or '').strip()
    queried_drug_ids = [d.strip() for d in (drug_ids or []) if str(d or '').strip()]
    review = _normalize_review_context(review_context)

    if not cid:
        return {
            'text_summary': '[sideeffect_researcher] No CUI provided; unable to look up a side-effect profile.',
            'structured': {
                'cui': None,
                'review_context': review,
                'name': None,
                'description': None,
                'top_reporting_drugs': [],
                'sources': [],
            },
        }

    local_row = _node_context_row(workspace_root, 'sideeffect', cid)
    name = _clean_node_text(str(local_row.get('node_name') or '')) if local_row else None
    description = _clean_node_text(str(local_row.get('description') or '')) if local_row else None

    # Try openFDA adverse events count by MedDRA PT term.
    # Try full node_name first; if it has a semicolon, also try the first segment.
    top_reporting_drugs: List[Dict[str, Any]] = []
    openfda_term_used: Optional[str] = None
    if name:
        search_terms = [name]
        if ';' in name:
            search_terms.append(name.split(';')[0].strip())
        for term in search_terms:
            result = _fetch_openfda_ae_drugs(term)
            if result:
                top_reporting_drugs = result
                openfda_term_used = term
                break

    summary_parts: List[str] = [f'Side-effect profile for {cid}.']
    if name:
        summary_parts.append(f'Name: {name}.')
    if description:
        summary_parts.append(f'Description: {description}')
    if top_reporting_drugs:
        drug_terms = ', '.join([str(item.get('term') or '') for item in top_reporting_drugs[:8]])
        summary_parts.append(
            f'Top drugs in openFDA adverse event reports associated with this side effect'
            f' (searched as "{openfda_term_used}"): {drug_terms}.'
        )
    else:
        summary_parts.append(
            'No openFDA adverse event drug list was retrieved for this side effect term.'
        )
    if not name and not description and not top_reporting_drugs:
        summary_parts.append('No local or external side-effect profile was produced.')

    targeted_review = _build_targeted_review_summary(
        review,
        [
            f'Queried drugs: {", ".join(queried_drug_ids)}.' if queried_drug_ids else '',
            f'Top reporting drugs from openFDA: {", ".join([str(d.get("term") or "") for d in top_reporting_drugs[:5]])}.'
            if top_reporting_drugs else '',
        ],
    )
    if targeted_review:
        summary_parts.append(targeted_review)

    return {
        'text_summary': ' '.join(summary_parts),
        'structured': {
            'cui': cid,
            'review_context': review,
            'name': name,
            'description': description,
            'top_reporting_drugs': top_reporting_drugs,
            'openfda_term_used': openfda_term_used,
            'queried_drug_ids': queried_drug_ids,
            'sources': [
                {
                    'type': 'local_node',
                    'csv': 'data_node/node_side_effect_description.csv',
                    'key': 'CUI',
                    'found': local_row is not None,
                },
                {
                    'type': 'openfda_ae_api',
                    'base_url': 'https://api.fda.gov/drug/event.json',
                    'term_used': openfda_term_used,
                },
            ],
        },
    }


# ---------------------------------------------------------------------------
# Autonomous Researcher — ReAct-style agentic loop
# ---------------------------------------------------------------------------

_TOOL_SCHEMAS: Dict[str, Dict[str, Any]] = {
    'drug_researcher': {
        'description': 'Look up a drug by DrugBank ID. Returns mechanism of action, approved indications, clinical phase, and safety flags from ChEMBL.',
        'parameters': {
            'drugbank_id': 'A DrugBank accession such as DB00001.',
        },
    },
    'protein_researcher': {
        'description': 'Look up a protein by gene symbol. Returns function description, GO biological processes, subcellular localisation, and Reactome pathways from UniProt.',
        'parameters': {
            'gene_symbol': 'An NCBI gene symbol such as EGFR or TP53.',
        },
    },
    'disease_researcher': {
        'description': 'Look up a disease by MONDO ID. Returns disease name, definition, associated targets with scores, and known drugs from Open Targets.',
        'parameters': {
            'mondo_id': 'A MONDO identifier such as MONDO:0005044.',
        },
    },
    'sideeffect_researcher': {
        'description': 'Look up a side effect by UMLS CUI. Returns side-effect name, description, and top reporting drugs from OpenFDA.',
        'parameters': {
            'cui': 'A UMLS Concept Unique Identifier such as C0020538.',
        },
    },
}


def _execute_tool_for_react(
    tool_name: str,
    tool_args: Dict[str, Any],
    workspace_root: Optional[str],
) -> str:
    """Execute a researcher tool and return a text summary for the ReAct loop."""
    try:
        if tool_name == 'drug_researcher':
            result = _drug_researcher(tool_args.get('drugbank_id'), None, workspace_root)
        elif tool_name == 'protein_researcher':
            result = _protein_researcher(tool_args.get('gene_symbol'), None)
        elif tool_name == 'disease_researcher':
            result = _disease_researcher(tool_args.get('mondo_id'), None)
        elif tool_name == 'sideeffect_researcher':
            result = _sideeffect_researcher(
                tool_args.get('cui'), tool_args.get('drug_ids'), None, workspace_root,
            )
        else:
            return f'Error: unknown tool "{tool_name}".'

        summary = str(result.get('text_summary') or '').strip()
        structured = result.get('structured')
        if structured and isinstance(structured, dict):
            # Build a compact but rich text representation the LLM can reason over
            compact = json.dumps(structured, ensure_ascii=False, indent=1, default=str)
            # Truncate very large outputs to stay within context window
            if len(compact) > 6000:
                compact = compact[:6000] + '\n... (truncated)'
            return f'{summary}\n\nStructured data:\n{compact}'
        return summary or '(tool returned no data)'
    except Exception as exc:
        return f'Error calling {tool_name}: {exc}'


def _autonomous_researcher(arguments: Dict[str, Any]) -> Dict[str, Any]:
    """ReAct-style autonomous researcher: the LLM decides which tools to call."""
    api_key = _read_text_file(arguments.get('openrouter_api_key_path'))
    base_url = str(arguments.get('openrouter_base_url') or 'http://localhost:8000/v1').rstrip('/')
    model = str(arguments.get('openrouter_model') or DEFAULT_OPENROUTER_MODEL).strip()
    if not api_key:
        api_key = 'local'
    role = str(arguments.get('role') or 'biomedical').strip().lower() or 'biomedical'
    available_tools = arguments.get('available_tools') or []
    if not isinstance(available_tools, list):
        available_tools = [str(available_tools)]
    entity_context = arguments.get('entity_context') or {}
    shared_node_context = arguments.get('shared_node_context') or ''
    review_context = _normalize_review_context(arguments.get('review_context'))
    workspace_root = arguments.get('workspace_root')

    relationship_type = ''
    if isinstance(entity_context, dict):
        relationship_type = str(entity_context.get('relationshipType') or '').strip()

    # Resolve prompt config — role-based override for sideeffect / cellline agents
    from prompts import get_prompt_config
    from prompts.common import AUTONOMOUS_RESEARCHER_SYSTEM
    if role == 'sideeffect' and not relationship_type:
        pcfg = get_prompt_config('drug_drug_sideeffect')
    elif role == 'cellline' and not relationship_type:
        pcfg = get_prompt_config('drug_drug_cell-line')
    else:
        pcfg = get_prompt_config(relationship_type)

    is_multiclass = pcfg['is_multiclass']
    hyperedge_label = pcfg['expert_hyperedge_label']
    label_instruction = pcfg['researcher_label_instruction']
    extra = pcfg.get('extra_instructions', [])
    if extra:
        label_instruction = label_instruction + '\n' + '\n'.join(f'- {e}' for e in extra)
    final_answer_schema = pcfg['researcher_final_answer_schema']
    task_line = pcfg['researcher_task_line']

    # Build tool descriptions for the prompt
    tool_desc_lines = []
    for t_name in available_tools:
        schema = _TOOL_SCHEMAS.get(t_name)
        if schema:
            params = ', '.join(f'{k}: {v}' for k, v in schema['parameters'].items())
            tool_desc_lines.append(f'  - {t_name}({params}): {schema["description"]}')

    tool_block = '\n'.join(tool_desc_lines) if tool_desc_lines else '  (no external tools available)'

    system_prompt = AUTONOMOUS_RESEARCHER_SYSTEM.format(
        role=role,
        label_instruction=label_instruction,
        tool_block=tool_block,
        final_answer_schema=final_answer_schema,
    )

    # Build the initial user message
    user_parts = []
    user_parts.append(task_line)
    if entity_context:
        user_parts.append(f'\n## Entity context\n{json.dumps(entity_context, ensure_ascii=False, indent=1, default=str)}')
    if shared_node_context:
        if isinstance(shared_node_context, dict):
            user_parts.append(f'\n## Shared node descriptions\n{json.dumps(shared_node_context, ensure_ascii=False, indent=1, default=str)}')
        else:
            user_parts.append(f'\n## Shared node descriptions\n{shared_node_context}')
    if review_context:
        user_parts.append(f'\n## Debate context\n{json.dumps(review_context, ensure_ascii=False, indent=1, default=str)}')
    user_parts.append('\nBegin your investigation. Start with THINK, then decide whether to call a tool or give your FINAL_ANSWER.')

    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': '\n'.join(user_parts)},
    ]

    max_steps = 6  # 5 tool calls + 1 final answer
    all_observations: List[Dict[str, Any]] = []

    for step in range(max_steps):
        response = _http_post(
            f'{base_url}/chat/completions',
            json_payload={
                'model': model,
                'temperature': 0,
                'max_tokens': 2048,
                'messages': messages,
            },
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            timeout=60,
        )

        if not response.ok:
            raise ValueError(
                f'autonomous_researcher LLM call failed with status {response.status_code} at step {step}.'
            )

        try:
            payload = response.json()
        except Exception:
            raise ValueError('autonomous_researcher LLM returned non-JSON response.')

        content = ''
        if isinstance(payload, dict):
            choices = payload.get('choices') or []
            if isinstance(choices, list) and choices:
                message = choices[0].get('message') if isinstance(choices[0], dict) else None
                if isinstance(message, dict):
                    content = str(message.get('content') or '')

        if not content.strip():
            raise ValueError(f'autonomous_researcher LLM returned empty content at step {step}.')

        messages.append({'role': 'assistant', 'content': content})

        # Check for FINAL_ANSWER
        final_match = re.search(r'FINAL_ANSWER\s*:\s*(\{.*\})', content, re.DOTALL)
        if final_match:
            parsed = _parse_json_object(final_match.group(1))
            if parsed:
                return _format_researcher_result(parsed, role, model, all_observations, relationship_type)
            # Try parsing the whole content
            parsed = _parse_json_object(content)
            if parsed and 'recommended_label' in parsed:
                return _format_researcher_result(parsed, role, model, all_observations, relationship_type)
            raise ValueError('autonomous_researcher FINAL_ANSWER contained invalid JSON.')

        # Check for ACTION
        action_match = re.search(r'ACTION\s*:\s*(\w+)\s*\(\s*(\{.*?\})\s*\)', content, re.DOTALL)
        if action_match:
            tool_name = action_match.group(1).strip()
            try:
                tool_args = json.loads(action_match.group(2))
            except json.JSONDecodeError:
                tool_args = {}

            if tool_name not in available_tools:
                observation = f'Error: tool "{tool_name}" is not available. Available tools: {", ".join(available_tools)}'
            else:
                observation = _execute_tool_for_react(tool_name, tool_args, workspace_root)

            all_observations.append({
                'step': step,
                'tool': tool_name,
                'args': tool_args,
                'observation_length': len(observation),
            })
            messages.append({'role': 'user', 'content': f'OBSERVATION:\n{observation}\n\nContinue your investigation. THINK about what this tells you, then call another tool or give your FINAL_ANSWER.'})
            continue

        # No ACTION and no FINAL_ANSWER — try to extract JSON from the text
        parsed = _parse_json_object(content)
        if parsed and 'recommended_label' in parsed:
            return _format_researcher_result(parsed, role, model, all_observations, relationship_type)

        # Nudge the model to produce a final answer
        messages.append({'role': 'user', 'content': 'You must now give your FINAL_ANSWER as JSON. No more tool calls.'})

    # Exhausted all steps — force parse last response
    last_content = messages[-1].get('content', '') if messages else ''
    parsed = _parse_json_object(last_content)
    if parsed and 'recommended_label' in parsed:
        return _format_researcher_result(parsed, role, model, all_observations, relationship_type)

    raise ValueError('autonomous_researcher exhausted all steps without producing a valid FINAL_ANSWER.')


def _format_researcher_result(
    parsed: Dict[str, Any],
    role: str,
    model: str,
    observations: List[Dict[str, Any]],
    relationship_type: str = '',
) -> Dict[str, Any]:
    """Format the final parsed JSON into the standard result structure."""
    label = _parse_label(parsed.get('recommended_label'), relationship_type)

    stance = parsed.get('stance')
    if stance not in ('supports', 'contradicts'):
        stance = _label_to_stance(label)
    strength = parsed.get('strength')
    if strength not in ('strong', 'moderate', 'weak'):
        strength = 'moderate' if label >= 1 else 'weak'
    claim = _ensure_first_person_claim(parsed.get('claim'), role, label)

    return {
        'text_summary': f'[autonomous_researcher] {role.capitalize()}-side expert vote {label}: {claim}',
        'structured': {
            'recommended_label': label,
            'stance': stance,
            'strength': strength,
            'claim': claim,
            'model': model,
            'role': role,
            'tool_calls': observations,
        },
    }


def call_research_tool(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    review_context = arguments.get('review_context')
    if name == 'drug_researcher':
        return _drug_researcher(
            arguments.get('drugbank_id'),
            review_context,
            arguments.get('workspace_root'),
        )
    if name == 'protein_researcher':
        return _protein_researcher(arguments.get('gene_symbol'), review_context)
    if name == 'disease_researcher':
        return _disease_researcher(arguments.get('mondo_id'), review_context)
    if name == 'sideeffect_researcher':
        return _sideeffect_researcher(
            arguments.get('cui'),
            arguments.get('drug_ids'),
            review_context,
            arguments.get('workspace_root'),
        )
    if name == 'node_context':
        return _node_context(arguments)
    if name == 'biomedical_expert_reasoner':
        return _biomedical_expert_reasoner(arguments)
    if name == 'hypothesis_generator':
        return _hypothesis_generator(arguments)
    if name == 'round_objective_planner':
        return _round_objective_planner(arguments)
    if name == 'graph_reasoner':
        return _graph_reasoner(arguments)
    if name == 'autonomous_researcher':
        return _autonomous_researcher(arguments)
    raise ValueError(f'Unsupported research tool: {name}')