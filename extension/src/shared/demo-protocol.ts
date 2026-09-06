export const DEMO_PAGE = "demo/index.html";
export const DEMO_PORT_NAME = "browser-key-automation.demo.v1";

export interface DemoReadChunk {
  readonly artifactRef: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sha256: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly dataBase64Url: string;
}

export type DemoReadResponse =
  | { readonly ok: true; readonly chunk: DemoReadChunk }
  | { readonly ok: false; readonly code: string };
