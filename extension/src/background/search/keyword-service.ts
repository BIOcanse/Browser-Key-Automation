import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { createTextArtifact } from "../artifact-service.js";
import { exact, integer, text } from "../browser-feature-model.js";
import type { DebuggerDispatch } from "../debugger-service.js";
import { isTabRefShape } from "../tab-service.js";
import { readSearchSources, searchLimit } from "./sources.js";

export function parseTabSearchParams(params: Record<string, unknown>): boolean {
  return exact(params, ["tabRefs", "query", "includeFrames", "caseSensitive", "limit"]) &&
    Array.isArray(params.tabRefs) && params.tabRefs.length > 0 && params.tabRefs.length <= searchLimit("maximum_tabs") &&
    params.tabRefs.every(isTabRefShape) && new Set(params.tabRefs).size === params.tabRefs.length &&
    text(params.query, searchLimit("maximum_query_bytes")) && typeof params.includeFrames === "boolean" && typeof params.caseSensitive === "boolean" &&
    integer(params.limit, 1, searchLimit("maximum_results"));
}
export function keywordSnippet(source: string, query: string, caseSensitive: boolean, contextCharacters: number) {
  // Escaping makes the query a literal phrase. Unicode regexp indices address the original UTF-16 text,
  // avoiding offsets corrupted by length-changing lowercase mappings such as dotted I.
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), caseSensitive ? "u" : "iu");
  const match = expression.exec(source);
  if (!match) return null;
  const before = Array.from(source.slice(0, match.index)).slice(-contextCharacters).join("");
  const after = Array.from(source.slice(match.index + match[0].length)).slice(0, contextCharacters).join("");
  return { text: before + match[0] + after, matchStart: before.length, matchEnd: before.length + match[0].length,
    sourceStart: match.index, offsetUnit: "utf16_code_unit" };
}
export async function searchTabs(keyId: string, params: Record<string, unknown>, dispatch: DebuggerDispatch) {
  const snapshot = await readSearchSources({ tabRefs: params.tabRefs as string[], includeFrames: params.includeFrames as boolean }, dispatch);
  const items = [];
  let matchingDocuments = 0;
  for (const source of snapshot.sources) {
    const snippet = keywordSnippet(source.text, params.query as string, params.caseSensitive as boolean, searchLimit("snippet_context_characters"));
    if (!snippet) continue;
    matchingDocuments++;
    if (items.length >= Number(params.limit)) continue;
    const { text: _text, ...metadata } = source;
    items.push({ ...metadata, snippet });
  }
  const result = { items, matchingDocuments, resultsTruncated: matchingDocuments > items.length, coverage: snapshot.coverage,
    mode: "keyword", matching: "literal_phrase_first_occurrence_per_document", artifact: null };
  const body = JSON.stringify(result);
  // Publish only under current authorization, including after long reads that outlive a Key change.
  return dispatch(async () => {
    if (new TextEncoder().encode(body).byteLength <= COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"] / 2) return result;
    const artifact = await createTextArtifact(keyId, "application/json", body);
    return { items: null, matchingDocuments, resultsTruncated: result.resultsTruncated, coverage: null, mode: result.mode,
      matching: result.matching, artifact };
  });
}
