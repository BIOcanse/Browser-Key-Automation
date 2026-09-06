import { ElementScreenshotError, type CaptureBox, type CaptureRect } from "./geometry-model.js";

interface MaskPath { readonly path: Path2D; readonly rule: CanvasFillRule }
type Radius = { x: number; y: number };

function unsupported(feature: string): never {
  throw new ElementScreenshotError("GEOMETRY_UNSUPPORTED", feature);
}

// Split only at the top level: calc() and path strings may contain separators.
function split(value: string, separator: " " | ","): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) { if (character === quote && value[index - 1] !== "\\") quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && (separator === " " ? /\s/u.test(character) : character === separator)) {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

export function shapeLength(value: string, size: number): number {
  const token = value.trim();
  const match = /^([+-]?(?:\d*\.)?\d+)(px|%)?$/u.exec(token);
  if (match) return Number(match[1]) * (match[2] === "%" ? size / 100 : 1);
  if (token.startsWith("calc(") && token.endsWith(")")) {
    const expression = token.slice(5, -1).trim();
    const terms = expression.match(/[+-]?\s*(?:\d*\.)?\d+(?:px|%)/gu);
    if (!terms || terms.join("").replaceAll(/\s/gu, "") !== expression.replaceAll(/\s/gu, "")) unsupported("css-length");
    let result = 0;
    for (const term of terms) {
      const item = /^([+-]?(?:\d*\.)?\d+)(px|%)$/u.exec(term.replaceAll(/\s/gu, ""));
      if (!item) unsupported("css-length");
      result += Number(item[1]) * (item[2] === "%" ? size / 100 : 1);
    }
    return result;
  }
  return unsupported("css-length");
}

function four<T>(values: readonly T[]): [T, T, T, T] {
  if (values.length < 1 || values.length > 4) unsupported("shape-arity");
  const first = values[0] as T;
  return [first, values[1] ?? first, values[2] ?? first, values[3] ?? values[1] ?? first];
}

function rounded(rect: CaptureRect, radii: readonly Radius[]): Path2D {
  const path = new Path2D();
  if (rect.width <= 0 || rect.height <= 0) return path;
  path.roundRect(rect.x, rect.y, rect.width, rect.height, radii.map(({ x, y }) => ({ x: Math.max(0, x), y: Math.max(0, y) })));
  return path;
}

function outerRadii(box: CaptureBox): Radius[] {
  const radii = box.radii.map((value) => {
    const tokens = split(value, " ");
    return { x: shapeLength(tokens[0] ?? "0", box.width), y: shapeLength(tokens[1] ?? tokens[0] ?? "0", box.height) };
  });
  // CSS normalizes the outer corners before deriving the inner border curves.
  // Letting roundRect normalize only after insetting gives a different shape.
  const [tl, tr, br, bl] = radii as [Radius, Radius, Radius, Radius];
  const ratio = (size: number, sum: number) => sum > 0 ? size / sum : 1;
  const factor = Math.min(1, ratio(box.width, tl.x + tr.x), ratio(box.width, bl.x + br.x),
    ratio(box.height, tl.y + bl.y), ratio(box.height, tr.y + br.y));
  return radii.map(({ x, y }) => ({ x: x * factor, y: y * factor }));
}

function insetBox(box: CaptureBox, inset: readonly [number, number, number, number]): { rect: CaptureRect; radii: Radius[] } {
  const [top, right, bottom, left] = inset;
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom]] as const;
  return {
    rect: { x: left, y: top, width: Math.max(0, box.width - left - right), height: Math.max(0, box.height - top - bottom) },
    radii: outerRadii(box).map((radius, index) => ({
      x: Math.max(0, radius.x - (corners[index]?.[0] ?? 0)),
      y: Math.max(0, radius.y - (corners[index]?.[1] ?? 0)),
    })),
  };
}

export function borderPath(box: CaptureBox): Path2D {
  if (box.svg) {
    const path = new Path2D();
    path.addPath(new Path2D(box.svg.path), { e: -box.svg.originX, f: -box.svg.originY });
    return path;
  }
  return rounded({ x: 0, y: 0, width: box.width, height: box.height }, outerRadii(box));
}

export function overflowPath(box: CaptureBox, extent: number): Path2D {
  const { rect, radii } = insetBox(box, box.border);
  if (box.overflowX && box.overflowY) return rounded(rect, radii);
  const path = new Path2D();
  path.rect(box.overflowX ? rect.x : -extent, box.overflowY ? rect.y : -extent,
    box.overflowX ? rect.width : extent * 2, box.overflowY ? rect.height : extent * 2);
  return path;
}

function point(value: string, width: number, height: number): readonly [number, number] {
  const tokens = split(value || "center", " ");
  const axis = (token: string, size: number) => token === "center" ? size / 2 :
    token === "left" || token === "top" ? 0 : token === "right" || token === "bottom" ? size : shapeLength(token, size);
  if (tokens.length === 4) {
    const [horizontal, x, vertical, y] = tokens;
    if (!x || !y || !["left", "right"].includes(horizontal ?? "") || !["top", "bottom"].includes(vertical ?? "")) unsupported("shape-position");
    return [horizontal === "left" ? shapeLength(x, width) : width - shapeLength(x, width),
      vertical === "top" ? shapeLength(y, height) : height - shapeLength(y, height)];
  }
  if (tokens.length > 2) unsupported("shape-position");
  let x = tokens[0] ?? "center", y = tokens[1] ?? "center";
  if (x === "top" || x === "bottom" || y === "left" || y === "right") [x, y] = [y, x];
  return [axis(x, width), axis(y, height)];
}

function roundTokens(value: string, rect: CaptureRect): Radius[] {
  const sides = value.split("/");
  if (sides.length > 2) unsupported("shape-radius");
  const horizontal = four(split(sides[0] ?? "0", " ").map((token) => shapeLength(token, rect.width)));
  const vertical = four(split(sides[1] ?? sides[0] ?? "0", " ").map((token) => shapeLength(token, rect.height)));
  return horizontal.map((x, index) => ({ x, y: vertical[index] ?? 0 }));
}

export function clipPath(box: CaptureBox): MaskPath | null {
  const css = box.clipPath;
  if (!css || css === "none") return null;
  const geometry = /(?:^|\s)(border-box|padding-box|content-box)$/u.exec(css)?.[1] ?? "border-box";
  const inset = geometry === "content-box" ? box.border.map((value, index) => value + (box.padding[index] ?? 0)) as [number, number, number, number] :
    geometry === "padding-box" ? box.border : [0, 0, 0, 0] as const;
  const reference = insetBox(box, inset);
  const value = css.replace(/\s*(border-box|padding-box|content-box)$/u, "").trim();
  if (!value) return { path: rounded(reference.rect, reference.radii), rule: "nonzero" };
  const match = /^([a-z]+)\(([\s\S]*)\)$/u.exec(value);
  if (!match) return unsupported("clip-path");
  const type = match[1], body = match[2] ?? "";
  const width = reference.rect.width, height = reference.rect.height;
  let path = new Path2D(), rule: CanvasFillRule = "nonzero";
  if (type === "circle" || type === "ellipse") {
    const parts = body.split(/(?:^|\s+)at\s+/u);
    const size = split(parts[0]?.trim() || "closest-side", " ");
    const [x, y] = point(parts[1] ?? "center", width, height);
    const radius = (token: string, extent: number, distances: readonly number[]) => token === "closest-side" ? Math.max(0, Math.min(...distances)) :
      token === "farthest-side" ? Math.max(...distances) : shapeLength(token, extent);
    const rx = radius(size[0] ?? "closest-side", type === "circle" ? Math.hypot(width, height) / Math.SQRT2 : width,
      type === "circle" ? [x, y, width - x, height - y] : [x, width - x]);
    const ry = type === "circle" ? rx : radius(size[1] ?? size[0] ?? "closest-side", height, [y, height - y]);
    if (rx > 0 && ry > 0) path.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  } else if (type === "polygon") {
    const vertices = split(body, ",");
    if (vertices[0] === "evenodd" || vertices[0] === "nonzero") rule = vertices.shift() as CanvasFillRule;
    if (vertices.length < 3) unsupported("clip-polygon");
    for (let index = 0; index < vertices.length; index += 1) {
      const coordinates = split(vertices[index] ?? "", " ");
      if (coordinates.length !== 2) unsupported("clip-polygon");
      const x = shapeLength(coordinates[0] ?? "0", width), y = shapeLength(coordinates[1] ?? "0", height);
      if (index === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
  } else if (type === "inset" || type === "xywh") {
    const parts = body.split(/\s+round\s+/u);
    const tokens = split(parts[0] ?? "", " ");
    const values = four(tokens);
    let rect: CaptureRect;
    if (type === "xywh") {
      if (tokens.length !== 4) unsupported("clip-xywh");
      rect = { x: shapeLength(values[0], width), y: shapeLength(values[1], height), width: shapeLength(values[2], width), height: shapeLength(values[3], height) };
    } else {
      const top = shapeLength(values[0], height), right = shapeLength(values[1], width), bottom = shapeLength(values[2], height), left = shapeLength(values[3], width);
      rect = { x: left, y: top, width: width - left - right, height: height - top - bottom };
    }
    path = rounded(rect, roundTokens(parts[1] ?? "0", rect));
  } else if (type === "path") {
    const tokens = split(body, ",");
    if (tokens[0] === "evenodd" || tokens[0] === "nonzero") rule = tokens.shift() as CanvasFillRule;
    const data = tokens.join(",").trim();
    if (data.length < 2 || !["'", '"'].includes(data[0] ?? "") || data[0] !== data[data.length - 1] || data.includes("\\")) unsupported("clip-path-data");
    path = new Path2D(data.slice(1, -1));
  } else return unsupported(`clip-${type}`);
  const translated = new Path2D();
  translated.addPath(path, { e: reference.rect.x, f: reference.rect.y });
  return { path: translated, rule };
}
