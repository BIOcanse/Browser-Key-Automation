export interface CaptureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CaptureMatrix = readonly [number, number, number, number, number, number];

export interface CaptureBox {
  readonly parent: number;
  readonly selected: boolean;
  readonly visible: boolean;
  readonly width: number;
  readonly height: number;
  readonly matrix: CaptureMatrix;
  readonly radii: readonly [string, string, string, string];
  readonly border: readonly [number, number, number, number];
  readonly padding: readonly [number, number, number, number];
  readonly clipPath: string;
  readonly overflowX: boolean;
  readonly overflowY: boolean;
  // Positioned descendants escape overflow clips before their containing block.
  // null means no escape; -1 means the viewport is the containing block.
  readonly overflowEscape: number | null;
  readonly svg: {
    readonly path: string;
    readonly fill: boolean;
    readonly fillRule: CanvasFillRule;
    readonly strokeWidth: number;
    readonly lineCap: CanvasLineCap;
    readonly lineJoin: CanvasLineJoin;
    readonly miterLimit: number;
    readonly originX: number;
    readonly originY: number;
  } | null;
}

export interface CaptureGeometry {
  // The captured bitmap includes browser scrollbars; contentViewport does not.
  readonly viewport: CaptureRect;
  readonly contentViewport: CaptureRect;
  readonly rootIndex: number;
  readonly boxes: readonly CaptureBox[];
}

export class ElementScreenshotError extends Error {
  readonly code = "ELEMENT_SCREENSHOT_FAILED" as const;
  readonly details: {
    readonly reason: "EMPTY_REGION" | "GEOMETRY_CHANGED" | "GEOMETRY_UNSUPPORTED" | "LIMIT_EXCEEDED";
    readonly feature: string;
  };

  constructor(reason: ElementScreenshotError["details"]["reason"], feature: string) {
    super(`Element screenshot: ${reason} (${feature})`);
    this.name = "ElementScreenshotError";
    this.details = { reason, feature };
  }
}
