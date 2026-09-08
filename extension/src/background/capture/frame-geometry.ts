import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { ElementScreenshotError, type CaptureGeometry, type CaptureMatrix } from "./geometry-model.js";

export function multiplyCaptureMatrix(left: CaptureMatrix, right: CaptureMatrix): CaptureMatrix {
  return [left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5]];
}

/** The caller must already have proved that parent.rootIndex owns this exact child document. */
export function combineFrameGeometry(child: CaptureGeometry, parent: CaptureGeometry): CaptureGeometry {
  const owner = parent.boxes[parent.rootIndex];
  if (!owner) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-owner");
  const left = owner.border[3] + owner.padding[3], top = owner.border[0] + owner.padding[0];
  const width = owner.width - left - owner.border[1] - owner.padding[1], height = owner.height - top - owner.border[2] - owner.padding[2];
  if (width <= 0 || height <= 0) throw new ElementScreenshotError("EMPTY_REGION", "frame-content-box");
  // Browser integer viewport rounding may differ by < 1 CSS pixel. Do not turn it into an invented scale.
  if (child.viewport.x !== 0 || child.viewport.y !== 0 || child.contentViewport.x !== 0 || child.contentViewport.y !== 0 ||
      Math.abs(child.viewport.width - width) >= 1 || Math.abs(child.viewport.height - height) >= 1) {
    throw new ElementScreenshotError("GEOMETRY_UNSUPPORTED", "frame-viewport-scale");
  }
  const offset = parent.rootIndex + 1, matrix = multiplyCaptureMatrix(owner.matrix, [1, 0, 0, 1, left, top]);
  const prefix = parent.boxes.slice(0, offset).map(box => ({...box, visible: false, selected: false}));
  const boxes = [...prefix, ...child.boxes.map(box => ({...box, parent: box.parent < 0 ? parent.rootIndex : box.parent + offset,
    matrix: multiplyCaptureMatrix(matrix, box.matrix),
    overflowEscape: box.overflowEscape === null ? null : box.overflowEscape < 0 ? parent.rootIndex : box.overflowEscape + offset}))];
  const depths: number[] = [];
  for (const box of boxes) {
    const depth = box.parent < 0 ? 0 : (depths[box.parent] ?? Number.MAX_SAFE_INTEGER) + 1;
    if (depth > COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_depth"]) throw new ElementScreenshotError("LIMIT_EXCEEDED", "combined-frame-depth");
    depths.push(depth);
  }
  const frameClips = [...parent.frameClips ?? [], {matrix: owner.matrix, rect: {x: left, y: top, width, height}},
    {matrix, rect: child.contentViewport}, ...(child.frameClips ?? []).map(clip => ({matrix: multiplyCaptureMatrix(matrix, clip.matrix), rect: clip.rect}))];
  const geometry: CaptureGeometry = {viewport: parent.viewport, contentViewport: parent.contentViewport, rootIndex: child.rootIndex + offset, boxes, frameClips};
  if (boxes.length > COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_nodes"] ||
      new TextEncoder().encode(JSON.stringify(geometry)).byteLength > COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_bytes"]) {
    throw new ElementScreenshotError("LIMIT_EXCEEDED", "combined-frame-geometry");
  }
  return geometry;
}
