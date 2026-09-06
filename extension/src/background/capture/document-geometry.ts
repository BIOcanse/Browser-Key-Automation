import type { CaptureBox, CaptureGeometry, CaptureMatrix } from "./geometry-model.js";

export type DocumentGeometryResult =
  | { readonly ok: true; readonly geometry: CaptureGeometry }
  | { readonly ok: false; readonly reason: "empty" | "limit" | "stale" | "unsupported"; readonly feature: string };

// Self-contained because Chromium serializes this function into the existing
// isolated world. It reads geometry only: no style mutation or page repaint.
export function collectDocumentGeometry(
  nodeRef: string,
  maximumNodes: number,
  maximumDepth: number,
  maximumBytes: number,
): DocumentGeometryResult {
  interface Rect { x: number; y: number; width: number; height: number }
  interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number; is2D?: boolean }
  interface ElementLike {
    readonly isConnected: boolean;
    readonly ownerDocument: unknown;
    readonly tagName: string;
    readonly namespaceURI: string;
    readonly parentElement: ElementLike | null;
    readonly assignedSlot?: ElementLike | null;
    readonly children: Iterable<ElementLike>;
    readonly shadowRoot?: { readonly children: Iterable<ElementLike> } | null;
    readonly offsetParent?: ElementLike | null;
    readonly offsetWidth?: number;
    readonly offsetHeight?: number;
    readonly clientLeft?: number;
    readonly clientTop?: number;
    getRootNode(): { readonly host?: ElementLike };
    getBoundingClientRect(): Rect;
    getClientRects(): { readonly length: number };
    getAttribute(name: string): string | null;
    getBBox?(): Rect;
    getScreenCTM?(): Matrix | null;
    assignedElements?(options: { flatten: boolean }): ElementLike[];
    readonly [name: string]: unknown;
  }
  interface ViewLike {
    readonly document: unknown;
    readonly top: unknown;
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly visualViewport?: { readonly offsetLeft: number; readonly offsetTop: number; readonly width: number; readonly height: number; readonly scale: number };
    readonly performance: { now(): number };
    readonly DOMMatrixReadOnly: new (value?: string) => Matrix;
    getComputedStyle(element: ElementLike): Record<string, string>;
    __BKA_DOM_NODE_REGISTRY_V1__?: { readonly nodes: Map<string, { readonly element: ElementLike; readonly expiresAt: number }> };
  }
  const page = globalThis as unknown as ViewLike;
  const entry = page.__BKA_DOM_NODE_REGISTRY_V1__?.nodes.get(nodeRef);
  const failure = (reason: "empty" | "limit" | "stale" | "unsupported", feature: string): DocumentGeometryResult => ({ ok: false, reason, feature });
  if (!entry || entry.expiresAt <= page.performance.now() || !entry.element.isConnected || entry.element.ownerDocument !== page.document) return failure("stale", "node-ref");
  // Cross-document screen transforms need a separately proven frame mapping;
  // never return child-frame coordinates as if they were top-level coordinates.
  if (page.top !== globalThis) return failure("unsupported", "frame-coordinate-mapping");
  const viewport = page.visualViewport;
  const scale = viewport?.scale ?? 1;
  const viewportRect = { x: viewport?.offsetLeft ?? 0, y: viewport?.offsetTop ?? 0, width: page.innerWidth / scale, height: page.innerHeight / scale };
  const contentViewport = { ...viewportRect, width: viewport?.width ?? viewportRect.width, height: viewport?.height ?? viewportRect.height };
  if (![viewportRect.x, viewportRect.y, viewportRect.width, viewportRect.height].every(Number.isFinite) || viewportRect.width <= 0 || viewportRect.height <= 0) return failure("empty", "viewport");
  const parentOf = (element: ElementLike): ElementLike | null => element.assignedSlot ?? element.parentElement ?? element.getRootNode().host ?? null;
  const ancestors: ElementLike[] = [];
  const visited = new Set<ElementLike>();
  let ancestor = parentOf(entry.element);
  while (ancestor) {
    if (ancestors.length >= maximumDepth || visited.has(ancestor)) return failure("limit", "ancestor-depth");
    visited.add(ancestor); ancestors.push(ancestor); ancestor = parentOf(ancestor);
  }
  visited.clear();
  ancestors.reverse();
  const work: { element: ElementLike; parent: number; selected: boolean; depth: number }[] = [];
  const boxes: CaptureBox[] = [];
  const elements = new Map<ElementLike, number>();
  const linear: CaptureMatrix[] = [];
  const identity: CaptureMatrix = [1, 0, 0, 1, 0, 0];
  const rootIndex = ancestors.length;
  let estimatedBytes = 0;
  const number = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
  const multiply = (left: CaptureMatrix, right: CaptureMatrix): CaptureMatrix => [
    left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3], 0, 0,
  ];
  // Prefix ancestors are processed before the selected subtree, in document order.
  work.push({ element: entry.element, parent: ancestors.length - 1, selected: true, depth: ancestors.length });
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    work.push({ element: ancestors[index] as ElementLike, parent: index - 1, selected: false, depth: index });
  }
  try {
    while (work.length > 0) {
      const current = work.pop();
      if (!current || visited.has(current.element)) continue;
      const { element, parent, selected, depth } = current;
      if (boxes.length >= maximumNodes || depth > maximumDepth) return failure("limit", "geometry-nodes");
      visited.add(element);
      const style = page.getComputedStyle(element);
      const tag = element.tagName.toLowerCase();
      const isSvg = element.namespaceURI === "http://www.w3.org/2000/svg";
      // Unrendered branches cannot contribute geometry. In particular, their
      // unused clip-path/mask/3D styles must not block a visible sibling.
      if (style.display === "none" || Number(style.opacity) === 0 ||
          isSvg && ["defs", "clippath", "mask", "symbol"].includes(tag)) {
        if (!selected || element === entry.element) return failure("empty", "element");
        continue;
      }
      // content-visibility hides contents, not the element's own border box.
      if (!selected && style.contentVisibility === "hidden") return failure("empty", "ancestor-contents");
      const index = boxes.length;
      const rect = element.getBoundingClientRect();
      const border = [number(style.borderTopWidth), number(style.borderRightWidth), number(style.borderBottomWidth), number(style.borderLeftWidth)] as const;
      const padding = [number(style.paddingTop), number(style.paddingRight), number(style.paddingBottom), number(style.paddingLeft)] as const;
      let width = Number.parseFloat(style.width ?? ""), height = Number.parseFloat(style.height ?? "");
      if (style.boxSizing !== "border-box") { width += border[1] + border[3] + padding[1] + padding[3]; height += border[0] + border[2] + padding[0] + padding[2]; }
      if (!Number.isFinite(width)) width = element.offsetWidth ?? rect.width;
      if (!Number.isFinite(height)) height = element.offsetHeight ?? rect.height;
      let local: CaptureMatrix = identity;
      const transformed = style.transform && style.transform !== "none" ? new page.DOMMatrixReadOnly(style.transform) : null;
      if (transformed && transformed.is2D === false || style.perspective && style.perspective !== "none") return failure("unsupported", "perspective-transform");
      if (transformed) local = [transformed.a, transformed.b, transformed.c, transformed.d, 0, 0];
      const zoom = style.zoom === "normal" || !style.zoom ? 1 : number(style.zoom);
      let scaleX = zoom, scaleY = zoom;
      if (style.scale && style.scale !== "none") {
        const factors = style.scale.trim().split(/\s+/u);
        if (factors.length > 2) return failure("unsupported", "3d-scale");
        const factor = (token: string) => number(token) / (token.endsWith("%") ? 100 : 1);
        scaleX *= factor(factors[0] ?? "1"); scaleY *= factor(factors[1] ?? factors[0] ?? "1");
      }
      local = multiply([scaleX, 0, 0, scaleY, 0, 0], local);
      if (style.rotate && style.rotate !== "none") {
        const rotation = /^(?:z\s+)?([+-]?(?:\d*\.)?\d+)(deg|rad|turn|grad)$/u.exec(style.rotate);
        if (!rotation) return failure("unsupported", "3d-rotation");
        const angle = Number(rotation[1]) * (rotation[2] === "deg" ? Math.PI / 180 : rotation[2] === "turn" ? Math.PI * 2 : rotation[2] === "grad" ? Math.PI / 200 : 1);
        local = multiply([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0], local);
      }
      let matrix = multiply(linear[parent] ?? identity, local);
      let svg: CaptureBox["svg"] = null;
      let paint = selected && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "contents";
      if (isSvg && tag !== "svg") {
        if (tag === "g") paint = false;
        else if (element.getBBox && element.getScreenCTM) {
          const bounds = element.getBBox(), ctm = element.getScreenCTM();
          if (!ctm) return failure("empty", "svg-transform");
          const value = (name: string) => {
            const animated = element[name] as { readonly baseVal?: { readonly value?: number } } | undefined;
            return animated?.baseVal?.value ?? number(element.getAttribute(name) ?? "0");
          };
          let data: string;
          if (tag === "path") data = element.getAttribute("d") ?? "";
          else if (tag === "polygon" || tag === "polyline") data = `M${element.getAttribute("points") ?? ""}${tag === "polygon" ? "Z" : ""}`;
          else if (tag === "line") data = `M${value("x1")} ${value("y1")}L${value("x2")} ${value("y2")}`;
          else if (tag === "circle" || tag === "ellipse") {
            const x = value("cx"), y = value("cy"), rx = value(tag === "circle" ? "r" : "rx"), ry = value(tag === "circle" ? "r" : "ry");
            data = `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
          } else if (tag === "rect" && value("rx") === 0 && value("ry") === 0) {
            data = `M${value("x")} ${value("y")}h${value("width")}v${value("height")}h${-value("width")}Z`;
          } else return failure("unsupported", `svg-${tag}`);
          const strokeWidth = style.stroke && style.stroke !== "none" ? number(style.strokeWidth) : 0;
          if (strokeWidth > 0 && (style.vectorEffect && style.vectorEffect !== "none" || style.strokeDasharray && style.strokeDasharray !== "none")) return failure("unsupported", "svg-stroke-effect");
          const lineCap = style.strokeLinecap || "butt", lineJoin = style.strokeLinejoin || "miter";
          if (!["butt", "round", "square"].includes(lineCap) || !["bevel", "round", "miter"].includes(lineJoin)) return failure("unsupported", "svg-stroke-join");
          const x = bounds.x - strokeWidth / 2, y = bounds.y - strokeWidth / 2;
          width = bounds.width + strokeWidth; height = bounds.height + strokeWidth;
          matrix = [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e + ctm.a * x + ctm.c * y, ctm.f + ctm.b * x + ctm.d * y];
          svg = { path: data, fill: style.fill !== "none", fillRule: style.fillRule === "evenodd" ? "evenodd" : "nonzero",
            strokeWidth, lineCap: lineCap as CanvasLineCap, lineJoin: lineJoin as CanvasLineJoin,
            miterLimit: number(style.strokeMiterlimit) || 4, originX: x, originY: y };
        }
      }
      if (!svg) {
        if (element.getClientRects().length > 1 && paint) return failure("unsupported", "fragmented-inline-box");
        const xs = [0, matrix[0] * width, matrix[2] * height, matrix[0] * width + matrix[2] * height];
        const ys = [0, matrix[1] * width, matrix[3] * height, matrix[1] * width + matrix[3] * height];
        matrix = [matrix[0], matrix[1], matrix[2], matrix[3], rect.x - Math.min(...xs), rect.y - Math.min(...ys)];
      }
      if (![width, height, ...matrix].every(Number.isFinite)) return failure("unsupported", "non-finite-geometry");
      if (style.maskImage && style.maskImage !== "none" || style.clip && style.clip !== "auto" || number(style.overflowClipMargin) !== 0) return failure("unsupported", "css-mask-or-legacy-clip");
      const clip = style.clipPath || "none";
      estimatedBytes += 640 + clip.length * 3 + (svg?.path.length ?? 0) * 3;
      if (estimatedBytes > maximumBytes) return failure("limit", "geometry-bytes");
      const offsetParent = element.offsetParent;
      const escape = style.position === "absolute" || style.position === "fixed" ?
        offsetParent ? elements.get(offsetParent) ?? -1 : -1 : null;
      boxes.push({ parent, selected, visible: paint && width > 0 && height > 0, width, height, matrix,
        radii: [style.borderTopLeftRadius || "0", style.borderTopRightRadius || "0", style.borderBottomRightRadius || "0", style.borderBottomLeftRadius || "0"],
        border, padding, clipPath: clip, svg,
        overflowX: ["hidden", "clip", "scroll", "auto"].includes(style.overflowX ?? ""),
        overflowY: ["hidden", "clip", "scroll", "auto"].includes(style.overflowY ?? ""), overflowEscape: escape });
      linear.push(matrix); elements.set(element, index);
      if (!selected) continue;
      if (style.contentVisibility === "hidden") continue;
      const assigned = element.assignedElements?.({ flatten: true });
      const children = assigned?.length ? assigned : element.shadowRoot?.children ?? element.children;
      const ordered: ElementLike[] = [];
      for (const child of children) {
        if (ordered.length + work.length + boxes.length >= maximumNodes) return failure("limit", "geometry-nodes");
        ordered.push(child);
      }
      for (let child = ordered.length - 1; child >= 0; child -= 1) work.push({ element: ordered[child] as ElementLike, parent: index, selected: true, depth: depth + 1 });
    }
    if (!boxes.some((box) => box.visible)) return failure("empty", "element");
    return { ok: true, geometry: { viewport: viewportRect, contentViewport, rootIndex, boxes } };
  } catch { return failure("unsupported", "geometry-read"); }
}
