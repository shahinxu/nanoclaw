from __future__ import annotations

import csv
import html
import json
import re
from pathlib import Path
from functools import lru_cache
from typing import Any, Dict, List, Optional

import requests


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
        'drug': ('data_node/node_drug_SMILES.csv', 'drugbank_id'),
        'protein': ('data_node/node_protein_sequence.csv', 'gene_symbol'),
        'disease': ('data_node/node_disease_def.csv', 'mondo_id'),
        'cellline': ('data_node/node_cell-line_descriptions.csv', 'cvcl_id'),
        'sideeffect': ('data_node/node_side-effect_description.csv', 'CUI'),
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
    if focus_mode:
        segments.append(f'Targeted review mode: {focus_mode}.')
    if focal_question:
        segments.append(f'Focused question: {focal_question}')
    focus = _non_empty_strings(review_context.get('focus'))
    if focus:
        segments.append('Round focus: ' + ' | '.join(focus[:3]) + '.')
    peer_findings = _non_empty_strings(review_context.get('peerFindings'))
    if peer_findings:
        segments.append('Peer concerns carried into this review: ' + ' | '.join(peer_findings[:2]))
    hypothesis_focus = _non_empty_strings(review_context.get('hypothesisFocus'))
    if hypothesis_focus:
        segments.append('Active hypotheses for this round: ' + ' | '.join(hypothesis_focus[:2]))
    if notes:
        segments.extend([note for note in notes if note])
    return ' '.join(segment for segment in segments if segment)


def _http_get(
    url: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    timeout: int = 10,
) -> requests.Response:
    return requests.get(url, params=params, timeout=timeout)


def _http_post(
    url: str,
    *,
    json_payload: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 10,
) -> requests.Response:
    return requests.post(url, json=json_payload, headers=headers, timeout=timeout)


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
        'drug': ('data_node/node_drug_SMILES.csv', 'drugbank_id'),
        'protein': ('data_node/node_protein_sequence.csv', 'gene_symbol'),
        'disease': ('data_node/node_disease_def.csv', 'mondo_id'),
        'cellline': ('data_node/node_cell-line_descriptions.csv', 'cvcl_id'),
        'sideeffect': ('data_node/node_side-effect_description.csv', 'CUI'),
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
    base_url = str(arguments.get('openrouter_base_url') or 'https://openrouter.ai/api/v1').rstrip('/')
    model = str(arguments.get('openrouter_model') or 'openai/gpt-4.1-mini').strip()
    graph_summary = str(arguments.get('graph_summary') or '').strip()
    graph_structured = arguments.get('graph_structured')

    if not api_key:
        return {
            'text_summary': '[graph_reasoner] OpenRouter API key is missing, so graph-side model judgment could not be produced.',
            'structured': {
                'recommended_label': 0,
                'stance': 'contradicts',
                'strength': 'weak',
                'claim': 'Graph-side model judgment was unavailable because the OpenRouter API key could not be read.',
                'model': model,
            },
        }

    prompt_payload = {
        'task': 'Decide whether the graph evidence supports or contradicts the queried drug-protein-disease triplet.',
        'decision_space': {
            'recommended_label': '0 or 1 only',
            'stance': ['supports', 'contradicts'],
            'strength': ['strong', 'moderate', 'weak'],
        },
        'instructions': [
            'Use the graph evidence, the shared evidence board, and your biological intuition about what the neighborhood implies for the queried triplet.',
            'You are allowed to use broad, indirect, or suggestive graph structure if it forms a biologically coherent story for the query.',
            'Absence of explicit local closure or exact triplet recovery is informative but not an automatic reason to vote 0.',
            'Use the shared evidence board and round objective as real debate context.',
            'Do not hedge. Return one binary vote and one concise claim.',
        ],
        'review_context': review,
        'graph_summary': graph_summary,
        'graph_structured': graph_structured,
        'response_schema': {
            'recommended_label': '0 or 1',
            'stance': 'supports or contradicts',
            'strength': 'strong, moderate, or weak',
            'claim': 'short explanation grounded in the graph evidence and the shared board',
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
                    'content': 'You are a biomedical graph debate agent. Use graph structure flexibly and intelligently rather than as a rigid rule system. Output valid JSON only.',
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
        return {
            'text_summary': f'[graph_reasoner] OpenRouter call failed with status {response.status_code}.',
            'structured': {
                'recommended_label': 0,
                'stance': 'contradicts',
                'strength': 'weak',
                'claim': 'Graph-side model judgment failed, so no positive graph conclusion could be trusted.',
                'model': model,
                'status_code': response.status_code,
            },
        }

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
        return {
            'text_summary': '[graph_reasoner] The model returned an unreadable response, so graph-side judgment fell back to a negative default.',
            'structured': {
                'recommended_label': 0,
                'stance': 'contradicts',
                'strength': 'weak',
                'claim': 'Graph-side model judgment was unreadable and could not justify a positive vote.',
                'model': model,
                'raw_content': content,
            },
        }

    label_value = parsed.get('recommended_label')
    try:
        label = 1 if int(label_value) == 1 else 0
    except Exception:
        label = 0
    stance = parsed.get('stance')
    if stance not in ('supports', 'contradicts'):
        stance = 'supports' if label == 1 else 'contradicts'
    strength = parsed.get('strength')
    if strength not in ('strong', 'moderate', 'weak'):
        strength = 'moderate' if label == 1 else 'weak'
    claim = str(parsed.get('claim') or '').strip() or (
        'The graph-side model judged the graph evidence as supportive.'
        if label == 1
        else 'The graph-side model judged the graph evidence as insufficient or contradictory.'
    )

    return {
        'text_summary': f'[graph_reasoner] The model voted {label} based on graph evidence and the shared evidence board.',
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
    base_url = str(arguments.get('openrouter_base_url') or 'https://openrouter.ai/api/v1').rstrip('/')
    model = str(arguments.get('openrouter_model') or 'openai/gpt-4.1-mini').strip()
    role = str(arguments.get('role') or 'biomedical').strip().lower() or 'biomedical'
    evidence_summary = str(arguments.get('evidence_summary') or '').strip()
    evidence_structured = arguments.get('evidence_structured')
    entity_context = arguments.get('entity_context')

    if not api_key:
        return {
            'text_summary': f'[biomedical_expert_reasoner] OpenRouter API key is missing, so {role}-side model judgment could not be produced.',
            'structured': {
                'recommended_label': 0,
                'stance': 'contradicts',
                'strength': 'weak',
                'claim': f'{role.capitalize()}-side model judgment was unavailable because the OpenRouter API key could not be read.',
                'retrieved_evidence_basis': [],
                'knowledge_based_inference': '',
                'model': model,
                'role': role,
            },
        }

    prompt_payload = {
        'task': f'Decide whether the {role}-side expert should vote 1 or 0 on the queried drug-protein-disease triplet.',
        'decision_space': {
            'recommended_label': '0 or 1 only',
            'stance': ['supports', 'contradicts'],
            'strength': ['strong', 'moderate', 'weak'],
        },
        'instructions': [
            'Start from the local node context when it is available. Treat it as the primary grounding source for entity identity, aliases, and baseline biology before weighing external API evidence.',
            'Use your biomedical knowledge and reasoning as fully as possible, together with the retrieved evidence.',
            'There is no requirement that supporting evidence be direct, explicit, non-generic, or fully complete before you can vote 1.',
            'Broad physiology, pharmacology, disease mechanism, target-class knowledge, alias resolution, and mechanistic analogy are all valid forms of support if they make biological sense for the queried triplet.',
            'Absence of an exact string match or an explicitly named direct interaction is not by itself a reason to vote 0.',
            'Weigh retrieved evidence, shared debate context, and your own biological judgment together, then decide which side is more convincing overall.',
            'Only vote 0 when the total biological story is genuinely unconvincing, contradictory, or better explained by another mechanism.',
            'Separate retrieved evidence from your knowledge-based inference in the JSON fields so the reasoning remains auditable.',
            'Return one binary vote and one concise claim only.',
        ],
        'review_context': review,
        'entity_context': entity_context,
        'evidence_summary': evidence_summary,
        'evidence_structured': evidence_structured,
        'response_schema': {
            'recommended_label': '0 or 1',
            'stance': 'supports or contradicts',
            'strength': 'strong, moderate, or weak',
            'claim': 'short explanation integrating retrieved evidence and biomedical reasoning',
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
                    'content': 'You are a biomedical expert debate agent. Your job is to reason like a strong biologist or pharmacologist, not like a rigid rule checker. Use retrieved evidence plus your own biological knowledge freely, while distinguishing explicit evidence from your own inference. Output valid JSON only.',
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
        return {
            'text_summary': f'[biomedical_expert_reasoner] OpenRouter call failed with status {response.status_code}.',
            'structured': {
                'recommended_label': 0,
                'stance': 'contradicts',
                'strength': 'weak',
                'claim': f'{role.capitalize()}-side model judgment failed, so no positive expert conclusion could be trusted.',
                'retrieved_evidence_basis': [],
                'knowledge_based_inference': '',
                'model': model,
                'role': role,
                'status_code': response.status_code,
            },
        }

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
        return {
            'text_summary': '[biomedical_expert_reasoner] The model returned an unreadable response, so expert-side judgment fell back to a negative default.',
            'structured': {
                'recommended_label': 0,
                'stance': 'contradicts',
                'strength': 'weak',
                'claim': f'{role.capitalize()}-side model judgment was unreadable and could not justify a positive vote.',
                'retrieved_evidence_basis': [],
                'knowledge_based_inference': '',
                'model': model,
                'role': role,
                'raw_content': content,
            },
        }

    label_value = parsed.get('recommended_label')
    try:
        label = 1 if int(label_value) == 1 else 0
    except Exception:
        label = 0
    stance = parsed.get('stance')
    if stance not in ('supports', 'contradicts'):
        stance = 'supports' if label == 1 else 'contradicts'
    strength = parsed.get('strength')
    if strength not in ('strong', 'moderate', 'weak'):
        strength = 'moderate' if label == 1 else 'weak'
    claim = str(parsed.get('claim') or '').strip() or (
        f'The {role}-side model judged the biomedical evidence and reasoning as supportive.'
        if label == 1
        else f'The {role}-side model judged the biomedical evidence and reasoning as insufficient or contradictory.'
    )
    retrieved_basis = parsed.get('retrieved_evidence_basis')
    if not isinstance(retrieved_basis, list):
        retrieved_basis = []
    retrieved_basis = [
        str(value).strip() for value in retrieved_basis if str(value).strip()
    ][:5]
    knowledge_based_inference = str(parsed.get('knowledge_based_inference') or '').strip()

    return {
        'text_summary': f'[biomedical_expert_reasoner] The {role}-side model voted {label} using retrieved evidence plus biomedical reasoning.',
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
            'text_summary': f'[drug_researcher] ChEMBL API lookup failed for {did}; no drug profile was produced.',
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
        return None
    try:
        payload = response.json()
    except Exception:
        return None
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
        return []
    try:
        payload = response.json()
    except Exception:
        return []
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
        return None
    try:
        payload = response.json()
    except Exception:
        return None
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
    response = _http_post(
        'https://www.ebi.ac.uk/unichem/api/v1/compounds',
        json_payload=payload,
        timeout=10,
    )
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
    response = _http_get(
        f'https://www.ebi.ac.uk/chembl/api/data/molecule/{chembl_id}',
        params={'format': 'json'},
        timeout=10,
    )
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
    response = _http_get(
        'https://www.ebi.ac.uk/chembl/api/data/mechanism',
        params={'molecule_chembl_id': chembl_id, 'format': 'json'},
        timeout=10,
    )
    if not response.ok:
        return []
    try:
        payload = response.json()
    except Exception:
        return []
    mechanisms = payload.get('mechanisms') or []
    return [item for item in mechanisms if isinstance(item, dict)]


def _fetch_chembl_indications(chembl_id: str) -> List[Dict[str, Any]]:
    response = _http_get(
        'https://www.ebi.ac.uk/chembl/api/data/drug_indication',
        params={'molecule_chembl_id': chembl_id, 'format': 'json', 'limit': 200},
        timeout=10,
    )
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
    if name == 'node_context':
        return _node_context(arguments)
    if name == 'biomedical_expert_reasoner':
        return _biomedical_expert_reasoner(arguments)
    if name == 'graph_reasoner':
        return _graph_reasoner(arguments)
    raise ValueError(f'Unsupported research tool: {name}')