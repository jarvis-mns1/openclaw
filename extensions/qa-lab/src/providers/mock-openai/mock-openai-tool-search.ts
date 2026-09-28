import {
  QA_TOOL_SEARCH_PROMPT_RE,
  QA_TOOL_SEARCH_FAILURE_PROMPT_RE,
} from "./mock-openai-contracts.js";
import {
  findNamedToolDefinition,
  hasDeclaredTool,
  isQaToolSearchFixture,
} from "./mock-openai-directives.js";
import { parseToolOutputJson } from "./mock-openai-input.js";
import type { readScenarioCompletedToolName } from "./mock-openai-tool-routing.js";
import {
  buildQaToolSearchArgs,
  extractToolSearchTarget,
  toolSearchOutputHasCandidate,
} from "./mock-openai-tooling.js";

export function resolveMockToolSearchCall(params: {
  body: Record<string, unknown>;
  toolDeclarationBody: Record<string, unknown>;
  allInputText: string;
  hasCompletedToolOutput: boolean;
  completedToolName: ReturnType<typeof readScenarioCompletedToolName>;
  toolOutput: string;
}): { name: string; args: Record<string, unknown> } | null {
  const {
    body,
    toolDeclarationBody,
    allInputText,
    hasCompletedToolOutput,
    completedToolName,
    toolOutput,
  } = params;
  if (
    !QA_TOOL_SEARCH_PROMPT_RE.test(allInputText) &&
    !QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText)
  ) {
    return null;
  }
  const targetTool = extractToolSearchTarget(allInputText);
  const plannedArgs = targetTool
    ? buildQaToolSearchArgs(
        targetTool,
        QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText),
        allInputText,
      )
    : {};
  if (
    targetTool &&
    hasCompletedToolOutput &&
    (completedToolName === "tool_search" || completedToolName === "tool_search_batch") &&
    !toolOutput.includes("FAKE_PLUGIN_OK") &&
    toolSearchOutputHasCandidate(parseToolOutputJson(toolOutput), targetTool) &&
    hasDeclaredTool(body, "tool_call")
  ) {
    if (
      completedToolName === "tool_search" &&
      allInputText.includes("scalar-and-batch") &&
      hasDeclaredTool(body, "tool_search_batch")
    ) {
      return {
        name: "tool_search_batch",
        args: {
          queries: [
            { query: targetTool, limit: 1 },
            { query: "fake plugin tool", limit: 2 },
          ],
        },
      };
    }
    return { name: "tool_call", args: { id: targetTool, args: plannedArgs } };
  }
  if (
    !hasCompletedToolOutput &&
    targetTool &&
    findNamedToolDefinition(toolDeclarationBody, targetTool)?.type === "custom" &&
    typeof plannedArgs.input === "string"
  ) {
    return { name: targetTool, args: plannedArgs };
  }
  if (!hasCompletedToolOutput && targetTool && hasDeclaredTool(body, "tool_search_code")) {
    return {
      name: "tool_search_code",
      args: {
        code: [
          `const hits = await openclaw.tools.search(${JSON.stringify(targetTool)}, { limit: 1 });`,
          "const match = hits.find((tool) => tool.name === " + JSON.stringify(targetTool) + ");",
          "if (!match) throw new Error('target tool not found');",
          `return await openclaw.tools.call(match.id, ${JSON.stringify(plannedArgs)});`,
        ].join("\n"),
      },
    };
  }
  if (
    !hasCompletedToolOutput &&
    targetTool &&
    !hasDeclaredTool(body, targetTool) &&
    hasDeclaredTool(body, "tool_search")
  ) {
    return { name: "tool_search", args: { query: targetTool, limit: 1 } };
  }
  if (
    !hasCompletedToolOutput &&
    targetTool &&
    (hasDeclaredTool(body, targetTool) || isQaToolSearchFixture(allInputText))
  ) {
    return { name: targetTool, args: plannedArgs };
  }
  return null;
}
