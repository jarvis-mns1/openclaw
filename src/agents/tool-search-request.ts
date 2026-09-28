import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Guard } from "typebox/guard";
import {
  MAX_TOOL_SEARCH_BATCH_QUERIES,
  MAX_TOOL_SEARCH_BATCH_QUERY_BYTES,
  MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  MAX_TOOL_SEARCH_RESULTS,
  type ToolSearchCatalogSession,
  type ToolSearchConfig,
} from "./tool-search-types.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

const TOOL_SEARCH_SELECTOR_KEYS = ["id", "toolId", "name"] as const;

function readToolSearchSelector(params: Record<string, unknown>): string | undefined {
  const value = params.id ?? params.toolId ?? params.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readToolSearchId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const value = readToolSearchSelector(params);
  if (value === undefined) {
    throw new ToolInputError("id must be a non-empty string.");
  }
  return value.trim();
}

export function readToolSearchCallArgs(
  args: unknown,
  catalog?: ToolSearchCatalogSession,
): { id: string; input: unknown } {
  const params = asToolParamsRecord(args);
  const dottedInput = Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key.startsWith("args.") && key.length > 5)
      .map(([key, value]) => [key.slice(5), value]),
  );
  const nestedInput = params.args ?? params.input;
  // Some local models emit an empty args/input wrapper while flattening the real
  // arguments to the top level. Treat an empty wrapper as absent so the fallback
  // below preserves those parameters instead of returning {}.
  const nestedInputIsEmpty = isRecord(nestedInput) && Object.keys(nestedInput).length === 0;
  if (nestedInput != null && !nestedInputIsEmpty) {
    return {
      id: readToolSearchId(params),
      input: isRecord(nestedInput) ? { ...dottedInput, ...nestedInput } : nestedInput,
    };
  }

  const matchingSelectors = catalog
    ? TOOL_SEARCH_SELECTOR_KEYS.flatMap((key) => {
        const value = params[key];
        if (typeof value !== "string") {
          return [];
        }
        const matches = catalog.entries.filter(
          (entry) => entry.id === value || entry.name === value,
        );
        return matches.length > 0 ? [{ key, matches }] : [];
      })
    : [];
  const matchedToolIds = new Set(
    matchingSelectors.flatMap(({ matches }) => matches.map((entry) => entry.id)),
  );
  if (matchedToolIds.size > 1) {
    throw new ToolInputError(
      "Ambiguous tool selectors: pass the target tool id and nest target arguments under args.",
    );
  }
  const matchingSelector = matchingSelectors[0]?.key;
  const selector = matchingSelector ?? TOOL_SEARCH_SELECTOR_KEYS.find((key) => params[key] != null);
  const id = readToolSearchId(selector ? { [selector]: params[selector] } : params);

  // Remove every alias that actually identifies the selected catalog tool;
  // unmatched id/name fields can still be required arguments of that tool.
  const wrapperKeys = new Set<string>([
    "args",
    "input",
    ...matchingSelectors.map(({ key }) => key),
    ...(matchingSelector ? [] : [selector ?? "id"]),
  ]);
  const targetInputEntries = Object.entries(params).filter(([key]) => !wrapperKeys.has(key));
  const flattenedInput = Object.fromEntries(
    targetInputEntries.filter(([key]) => !(key.startsWith("args.") && key.length > 5)),
  );
  return { id, input: { ...dottedInput, ...flattenedInput } };
}

export function prepareToolSearchDispatcherArguments(args: unknown): unknown {
  if (!isRecord(args) || TOOL_SEARCH_SELECTOR_KEYS.some((key) => Object.hasOwn(args, key))) {
    return args;
  }
  const nestedInput = args.args ?? args.input;
  if (!isRecord(nestedInput)) {
    return args;
  }
  const selectorValue = readToolSearchSelector(nestedInput);
  if (selectorValue === undefined) {
    return args;
  }
  const { args: _wrappedArgs, input: _wrappedInput, ...outerRest } = args;
  return { ...outerRest, ...nestedInput, id: selectorValue };
}

export function readToolSearchLimit(value: unknown, config: ToolSearchConfig): number {
  if (value === undefined) {
    return config.searchDefaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError("limit must be a positive integer.");
  }
  return Math.min(value, config.maxSearchLimit);
}

function readBatchToolSearchQuery(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${field} must be a non-empty string.`);
  }
  const query = value.trim();
  if (!Guard.IsMaxLength(query, MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES)) {
    throw new ToolInputError(
      `${field} must not exceed ${MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES} characters.`,
    );
  }
  return query;
}

export function readToolSearchBatchRequest(
  args: unknown,
  config: ToolSearchConfig,
): Array<{ query: string; limit: number }> {
  const params = asToolParamsRecord(args);
  if (
    params.query !== undefined &&
    params.query !== null &&
    !(typeof params.query === "string" && !params.query.trim())
  ) {
    throw new ToolInputError(
      "tool_search_batch accepts queries only. Put every search in queries, or use tool_search for one query.",
    );
  }
  if (
    params.limit != null ||
    (params.options != null &&
      (!isRecord(params.options) || Object.keys(params.options).length > 0))
  ) {
    throw new ToolInputError("set limit on each batch query, not on the batch request.");
  }
  if (!Array.isArray(params.queries) || params.queries.length === 0) {
    throw new ToolInputError("queries must be a non-empty array.");
  }
  if (params.queries.length > MAX_TOOL_SEARCH_BATCH_QUERIES) {
    throw new ToolInputError(
      `queries may contain at most ${MAX_TOOL_SEARCH_BATCH_QUERIES} entries.`,
    );
  }
  const searches = params.queries.map((value, index) => {
    if (!isRecord(value)) {
      throw new ToolInputError(`queries[${index}] must be an object.`);
    }
    if (
      value.options != null &&
      (!isRecord(value.options) || Object.keys(value.options).length > 0)
    ) {
      throw new ToolInputError(`set queries[${index}].limit directly, not inside options.`);
    }
    const query = readBatchToolSearchQuery(value.query, `queries[${index}].query`);
    try {
      return { query, limit: readToolSearchLimit(value.limit, config) };
    } catch (error) {
      if (error instanceof ToolInputError) {
        throw new ToolInputError(`queries[${index}].${error.message}`);
      }
      throw error;
    }
  });
  const requestedResults = searches.reduce((total, search) => total + search.limit, 0);
  if (requestedResults > MAX_TOOL_SEARCH_RESULTS) {
    throw new ToolInputError(
      `batch queries resolve to ${requestedResults} results, but may request at most ${MAX_TOOL_SEARCH_RESULTS} in total. An omitted limit counts as ${config.searchDefaultLimit}; set smaller per-query limits and retry.`,
    );
  }
  const serializedQueries = JSON.stringify(searches.map((search) => search.query));
  const serializedQueryBytes = new TextEncoder().encode(serializedQueries).byteLength;
  if (serializedQueryBytes > MAX_TOOL_SEARCH_BATCH_QUERY_BYTES) {
    throw new ToolInputError(
      `serialized batch query text may use at most ${MAX_TOOL_SEARCH_BATCH_QUERY_BYTES} UTF-8 bytes.`,
    );
  }
  return searches;
}
