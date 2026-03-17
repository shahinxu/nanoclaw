import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { BiomedWorkflowConfig } from '../config.js';
import { ResearchToolAdapter, ResearchToolResult } from '../types.js';

const execFileAsync = promisify(execFile);

const PYTHON_TOOL_BRIDGE = `
import json
import sys

from nanoclaw.biomed_research_backend import call_research_tool

tool_name = sys.argv[1]
arguments = json.loads(sys.argv[2])

try:
  result = call_research_tool(tool_name, arguments)
  print(json.dumps({"status": "ok", "result": result}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
`;

export class PythonResearchToolAdapter implements ResearchToolAdapter {
  constructor(private readonly config: BiomedWorkflowConfig) {}

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ResearchToolResult> {
    try {
      const { stdout } = await execFileAsync(
        this.config.pythonExecutable,
        ['-c', PYTHON_TOOL_BRIDGE, toolName, JSON.stringify(args)],
        {
          cwd: this.config.workspaceRoot,
          env: {
            ...process.env,
            PYTHONPATH: this.config.workspaceRoot,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const parsed = JSON.parse(stdout.trim()) as {
        status: 'ok' | 'error';
        result?: {
          text_summary?: unknown;
          structured?: unknown;
        };
        error?: string;
      };

      if (parsed.status === 'error') {
        return {
          toolName,
          status: 'error',
          textSummary: '',
          structured: null,
          error: parsed.error ?? 'Unknown researcher tool error.',
        };
      }

      return {
        toolName,
        status: 'ok',
        textSummary:
          typeof parsed.result?.text_summary === 'string'
            ? parsed.result.text_summary
            : '',
        structured:
          parsed.result?.structured &&
          typeof parsed.result.structured === 'object' &&
          !Array.isArray(parsed.result.structured)
            ? (parsed.result.structured as Record<string, unknown>)
            : null,
      };
    } catch (error) {
      return {
        toolName,
        status: 'error',
        textSummary: '',
        structured: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}