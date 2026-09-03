import { ElementScreenshotError, type CaptureGeometry, type CaptureMatrix, type CaptureRect } from "./geometry-model.js";
import { borderPath, clipPath, overflowPath } from "./shape-path.js";

export function containRect(sourceWidth: number, sourceHeight: number, width: number, height: number): CaptureRect {
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  return { x: (width - sourceWidth * scale) / 2, y: (height - sourceHeight * scale) / 2, width: sourceWidth * scale, height: sourceHeight * scale };
}

export function alphaBounds(data: Uint8ClampedArray, width: number, height: number): CaptureRect | null {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export function paintGeometryMask(
  context: OffscreenCanvasRenderingContext2D,
  geometry: CaptureGeometry,
  pixelWidth: number,
  pixelHeight: number,
  region: CaptureRect | null,
): void {
  const sx = pixelWidth / geometry.viewport.width, sy = pixelHeight / geometry.viewport.height;
  const transform = (matrix: CaptureMatrix) => context.setTransform(
    matrix[0] * sx, matrix[1] * sy, matrix[2] * sx, matrix[3] * sy,
    (matrix[4] - geometry.viewport.x) * sx, (matrix[5] - geometry.viewport.y) * sy,
  );
  // A hidden leaf cannot paint or clip a visible descendant. Resolve paths only
  // for contributors and their ancestors, retaining visibility overrides.
  const paths = new Map<number, { border: Path2D | null; clip: ReturnType<typeof clipPath>; overflow: Path2D | null }>();
  const shapeAt = (index: number) => {
    const cached = paths.get(index);
    if (cached) return cached;
    const box = geometry.boxes[index];
    if (!box) throw new ElementScreenshotError("GEOMETRY_CHANGED", "parent-path");
    const shape = { border: box.visible ? borderPath(box) : null, clip: clipPath(box), overflow:
      box.overflowX || box.overflowY ? overflowPath(box, Number.MAX_SAFE_INTEGER / 1024) : null };
    paths.set(index, shape);
    return shape;
  };
  const root = geometry.boxes[geometry.rootIndex];
  if (!root) throw new ElementScreenshotError("GEOMETRY_CHANGED", "missing-root");
  for (let index = 0; index < geometry.boxes.length; index += 1) {
    const box = geometry.boxes[index];
    if (!box?.visible) continue;
    context.save();
    try {
      context.setTransform(sx, 0, 0, sy, -geometry.viewport.x * sx, -geometry.viewport.y * sy);
      const viewportClip = new Path2D();
      viewportClip.rect(geometry.contentViewport.x, geometry.contentViewport.y, geometry.contentViewport.width, geometry.contentViewport.height);
      context.clip(viewportClip);
      if (region) {
        transform(root.matrix);
        const selection = new Path2D(); selection.rect(region.x, region.y, region.width, region.height); context.clip(selection);
      }
      let ancestor = index, overflowBoundary: number | null = null;
      while (ancestor >= 0) {
        const parent = geometry.boxes[ancestor], shape = shapeAt(ancestor);
        if (!parent) throw new ElementScreenshotError("GEOMETRY_CHANGED", "parent-path");
        transform(parent.matrix);
        if (overflowBoundary === ancestor) overflowBoundary = null;
        if (ancestor !== index && overflowBoundary === null && shape.overflow) context.clip(shape.overflow);
        if (shape.clip) context.clip(shape.clip.path, shape.clip.rule);
        if (parent.overflowEscape !== null) overflowBoundary = overflowBoundary === null ? parent.overflowEscape : Math.min(overflowBoundary, parent.overflowEscape);
        ancestor = parent.parent;
      }
      transform(box.matrix);
      context.fillStyle = "#fff";
      const path = shapeAt(index).border;
      if (!path) continue;
      if (!box.svg || box.svg.fill) context.fill(path, box.svg?.fillRule ?? "nonzero");
      if (box.svg && box.svg.strokeWidth > 0) {
        context.strokeStyle = "#fff"; context.lineWidth = box.svg.strokeWidth;
        context.lineCap = box.svg.lineCap; context.lineJoin = box.svg.lineJoin;
        context.miterLimit = box.svg.miterLimit; context.stroke(path);
      }
    } finally { context.restore(); }
  }
}

export async function composeElementScreenshot(
  source: ImageBitmap,
  geometry: CaptureGeometry,
  width: number,
  height: number,
  region: CaptureRect | null,
): Promise<{ readonly blob: Blob; readonly sourceRect: CaptureRect; readonly contentRect: CaptureRect }> {
  const mask = new OffscreenCanvas(source.width, source.height);
  const maskContext = mask.getContext("2d", { willReadFrequently: true });
  if (!maskContext) throw new ElementScreenshotError("GEOMETRY_UNSUPPORTED", "canvas-2d");
  paintGeometryMask(maskContext, geometry, source.width, source.height, region);
  const bounds = alphaBounds(maskContext.getImageData(0, 0, source.width, source.height).data, source.width, source.height);
  if (!bounds) throw new ElementScreenshotError("EMPTY_REGION", "visible-mask");
  // Apply alpha at the source resolution, then resample the masked RGBA once.
  // Resizing the unmasked source first blends excluded background into edges.
  maskContext.globalCompositeOperation = "source-in";
  maskContext.drawImage(source, 0, 0);
  const contentRect = containRect(bounds.width, bounds.height, width, height);
  const output = new OffscreenCanvas(width, height);
  const context = output.getContext("2d");
  if (!context) throw new ElementScreenshotError("GEOMETRY_UNSUPPORTED", "canvas-2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(mask, bounds.x, bounds.y, bounds.width, bounds.height, contentRect.x, contentRect.y, contentRect.width, contentRect.height);
  const sx = source.width / geometry.viewport.width, sy = source.height / geometry.viewport.height;
  return {
    blob: await output.convertToBlob({ type: "image/png" }), contentRect,
    sourceRect: { x: bounds.x / sx + geometry.viewport.x, y: bounds.y / sy + geometry.viewport.y, width: bounds.width / sx, height: bounds.height / sy },
  };
}
