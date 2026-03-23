import { LocalGraphTool } from './tools/local-graph-tool.js';
import {
  BiomedTaskSample,
  PlannerAction,
  ResearchToolAdapter,
  ResearchToolResult,
} from './types.js';

export interface PlanExecutorDependencies {
  researchToolAdapter?: ResearchToolAdapter;
  localGraphTool?: LocalGraphTool;
  sample?: BiomedTaskSample;
}

export async function executePlannerAction(
  action: PlannerAction,
  deps: PlanExecutorDependencies,
): Promise<ResearchToolResult[]> {
  const results: ResearchToolResult[] = [];

  for (const toolCall of action.toolCalls) {
    if (toolCall.tool === 'local_graph_tool') {
      if (!deps.localGraphTool || !deps.sample) {
        throw new Error(
          'local_graph_tool execution requires both localGraphTool and sample.',
        );
      }
      results.push(
        deps.localGraphTool.inspectSample(deps.sample, toolCall.arguments),
      );
      continue;
    }

    if (!deps.researchToolAdapter) {
      throw new Error(
        `Tool ${toolCall.tool} requires a researchToolAdapter but none was provided.`,
      );
    }

    results.push(
      await deps.researchToolAdapter.callTool(
        toolCall.tool,
        toolCall.arguments,
      ),
    );
  }

  return results;
}
