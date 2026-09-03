import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { createArtifact } from "../artifact-service.js";
import { assertScriptingTargetAvailable } from "../browser-service.js";
import { captureVisibleScreenshotBlob } from "../capture-service.js";
import { DomServiceError, resolveNodeRefTarget, type NodeRefTarget } from "../dom-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "../tab-service.js";
import { collectDocumentGeometry } from "./document-geometry.js";
import { ElementScreenshotError, type CaptureGeometry, type CaptureRect } from "./geometry-model.js";
import { composeElementScreenshot } from "./mask-image.js";

export interface ElementScreenshotRequest {
  readonly nodeRef: string;
  readonly width: number;
  readonly height: number;
  readonly region?: CaptureRect;
}

async function geometryFor(target: NodeRefTarget): Promise<CaptureGeometry> {
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof collectDocumentGeometry>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] }, world: "ISOLATED", func: collectDocumentGeometry,
      args: [target.nodeRef, COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_nodes"],
        COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_depth"], COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_bytes"]],
    });
  } catch { throw new DomServiceError("TARGET_REF_STALE", "Screenshot NodeRef no longer resolves to its document"); }
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.documentId !== target.documentId || !entry.result) throw new DomServiceError("TARGET_REF_STALE", "Screenshot document changed");
  const result = entry.result;
  if (result.ok) return result.geometry;
  if (result.reason === "stale") throw new DomServiceError("TARGET_REF_STALE", "Screenshot NodeRef is stale");
  throw new ElementScreenshotError(result.reason === "limit" ? "LIMIT_EXCEEDED" : result.reason === "empty" ? "EMPTY_REGION" : "GEOMETRY_UNSUPPORTED", result.feature);
}

export async function captureElementScreenshot(ownerKeyId: string, request: ElementScreenshotRequest) {
  const { width, height, nodeRef } = request;
  const maximumDimension = COMMAND_CATALOG.limits["command.page.screenshot.maximum_dimension"];
  const maximumPixels = COMMAND_CATALOG.limits["command.page.screenshot.maximum_pixels"];
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= maximumDimension) || width * height > maximumPixels) {
    throw new ElementScreenshotError("LIMIT_EXCEEDED", "output-pixels");
  }
  const node = resolveNodeRefTarget(nodeRef);
  const tab = await resolveTabTarget(node.tabRef);
  await assertScriptingTargetAvailable(tab);
  const before = await geometryFor(node);
  assertResolvedTabTarget(tab);
  const blob = await captureVisibleScreenshotBlob(node.tabRef, "png", COMMAND_CATALOG.limits["command.page.screenshot.default_quality"]);
  const after = await geometryFor(node);
  assertResolvedTabTarget(tab);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new ElementScreenshotError("GEOMETRY_CHANGED", "layout-or-viewport");
  const source = await createImageBitmap(blob);
  try {
    if (source.width * source.height > maximumPixels) throw new ElementScreenshotError("LIMIT_EXCEEDED", "source-pixels");
    const output = await composeElementScreenshot(source, before, width, height, request.region ?? null);
    const artifact = await createArtifact(ownerKeyId, "image/png", output.blob);
    return { nodeRef, tabRef: node.tabRef, artifact, width, height, sourceRect: output.sourceRect,
      contentRect: output.contentRect, viewport: before.viewport, viewportOnly: true };
  } finally { source.close(); }
}
