import { ResearchToolResult } from './types.js';

function hasStructuredContent(
  structured: Record<string, unknown> | null,
): boolean {
  return structured !== null && Object.keys(structured).length > 0;
}

function isAbsenceOnlySummary(summary: string): boolean {
  return (
    /\bno (?:drug|protein|disease) profile was produced\b/i.test(summary) ||
    /\breturned no molecule_chembl_id\b/i.test(summary)
  );
}

export function isInformativeToolResult(
  result: Pick<
    ResearchToolResult,
    'toolName' | 'status' | 'textSummary' | 'structured'
  >,
): boolean {
  if (result.status !== 'ok') {
    return false;
  }

  const summary = result.textSummary.trim();

  if (result.toolName === 'node_context') {
    return result.structured?.node_found === true && summary !== '';
  }

  if (summary !== '' && isAbsenceOnlySummary(summary)) {
    return false;
  }

  return summary !== '' || hasStructuredContent(result.structured);
}

export function getInformativeToolSummary(
  result: Pick<
    ResearchToolResult,
    'toolName' | 'status' | 'textSummary' | 'structured'
  >,
): string {
  return isInformativeToolResult(result) ? result.textSummary.trim() : '';
}

export function getInformativeToolStructured(
  result: Pick<
    ResearchToolResult,
    'toolName' | 'status' | 'textSummary' | 'structured'
  >,
): Record<string, unknown> | null {
  return isInformativeToolResult(result) ? result.structured : null;
}
