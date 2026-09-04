export interface CanonicalKey {
  readonly name: string;
  readonly virtualKey: number;
  readonly extended: boolean;
  readonly modifier: boolean;
}

export interface KeyboardKeyActionInput {
  readonly key: string;
  readonly action: "down" | "up";
}

export interface KeyboardWaitActionInput {
  readonly waitMs: number;
}

export type KeyboardActionInput = string | KeyboardKeyActionInput | KeyboardWaitActionInput;

export interface NativeKeyboardKey {
  readonly virtualKey: number;
  readonly extended: boolean;
}

export type NativeKeyboardAction =
  | { readonly kind: "press"; readonly keys: readonly NativeKeyboardKey[]; readonly holdMs: number }
  | { readonly kind: "down" | "up"; readonly keys: readonly NativeKeyboardKey[] }
  | { readonly kind: "wait"; readonly waitMs: number };

export interface HumanMistake {
  readonly index: number;
  readonly wrong: string;
  readonly beforeBackspaceMs: number;
  readonly beforeCorrectionMs: number;
}

export interface HumanTypingPlan {
  readonly randomSeed: number;
  readonly delaysMs: readonly number[];
  readonly mistakes: readonly HumanMistake[];
  readonly estimatedDurationMs: number;
}

interface KeyDeclaration {
  readonly name: string;
  readonly virtualKey: number;
  readonly extended?: boolean;
  readonly modifier?: boolean;
  readonly aliases?: readonly string[];
}

const declarations: KeyDeclaration[] = [
  { name: "Backspace", virtualKey: 0x08, aliases: ["bs"] },
  { name: "Tab", virtualKey: 0x09 },
  { name: "Enter", virtualKey: 0x0d, aliases: ["return"] },
  { name: "Pause", virtualKey: 0x13 },
  { name: "CapsLock", virtualKey: 0x14, aliases: ["caps"] },
  { name: "Escape", virtualKey: 0x1b, aliases: ["esc"] },
  { name: "Space", virtualKey: 0x20, aliases: ["spacebar", " "] },
  { name: "PageUp", virtualKey: 0x21, extended: true, aliases: ["pgup"] },
  { name: "PageDown", virtualKey: 0x22, extended: true, aliases: ["pgdn", "pagedn"] },
  { name: "End", virtualKey: 0x23, extended: true },
  { name: "Home", virtualKey: 0x24, extended: true },
  { name: "ArrowLeft", virtualKey: 0x25, extended: true, aliases: ["left"] },
  { name: "ArrowUp", virtualKey: 0x26, extended: true, aliases: ["up"] },
  { name: "ArrowRight", virtualKey: 0x27, extended: true, aliases: ["right"] },
  { name: "ArrowDown", virtualKey: 0x28, extended: true, aliases: ["down"] },
  { name: "PrintScreen", virtualKey: 0x2c, extended: true, aliases: ["prtsc", "snapshot"] },
  { name: "Insert", virtualKey: 0x2d, extended: true, aliases: ["ins"] },
  { name: "Delete", virtualKey: 0x2e, extended: true, aliases: ["del"] },
  { name: "MetaLeft", virtualKey: 0x5b, extended: true, modifier: true, aliases: ["meta", "win", "windows", "cmd", "command"] },
  { name: "MetaRight", virtualKey: 0x5c, extended: true, modifier: true },
  { name: "ContextMenu", virtualKey: 0x5d, extended: true, aliases: ["menu"] },
  { name: "NumpadMultiply", virtualKey: 0x6a, aliases: ["multiply"] },
  { name: "NumpadAdd", virtualKey: 0x6b, aliases: ["add"] },
  { name: "NumpadSeparator", virtualKey: 0x6c, aliases: ["separator"] },
  { name: "NumpadSubtract", virtualKey: 0x6d, aliases: ["subtract"] },
  { name: "NumpadDecimal", virtualKey: 0x6e, aliases: ["decimal"] },
  { name: "NumpadDivide", virtualKey: 0x6f, extended: true, aliases: ["divide"] },
  { name: "NumLock", virtualKey: 0x90, extended: true },
  { name: "ScrollLock", virtualKey: 0x91 },
  { name: "ShiftLeft", virtualKey: 0xa0, modifier: true, aliases: ["shift"] },
  { name: "ShiftRight", virtualKey: 0xa1, modifier: true },
  { name: "ControlLeft", virtualKey: 0xa2, modifier: true, aliases: ["ctrl", "control"] },
  { name: "ControlRight", virtualKey: 0xa3, extended: true, modifier: true },
  { name: "AltLeft", virtualKey: 0xa4, modifier: true, aliases: ["alt", "option"] },
  { name: "AltRight", virtualKey: 0xa5, extended: true, modifier: true },
  { name: "BrowserBack", virtualKey: 0xa6 },
  { name: "BrowserForward", virtualKey: 0xa7 },
  { name: "BrowserRefresh", virtualKey: 0xa8 },
  { name: "BrowserStop", virtualKey: 0xa9 },
  { name: "BrowserSearch", virtualKey: 0xaa },
  { name: "BrowserFavorites", virtualKey: 0xab },
  { name: "BrowserHome", virtualKey: 0xac },
  { name: "VolumeMute", virtualKey: 0xad },
  { name: "VolumeDown", virtualKey: 0xae },
  { name: "VolumeUp", virtualKey: 0xaf },
  { name: "MediaNextTrack", virtualKey: 0xb0 },
  { name: "MediaPreviousTrack", virtualKey: 0xb1 },
  { name: "MediaStop", virtualKey: 0xb2 },
  { name: "MediaPlayPause", virtualKey: 0xb3 },
  { name: "Semicolon", virtualKey: 0xba, aliases: [";"] },
  { name: "Plus", virtualKey: 0xbb, aliases: ["=", "equal"] },
  { name: "Comma", virtualKey: 0xbc, aliases: [","] },
  { name: "Minus", virtualKey: 0xbd, aliases: ["-"] },
  { name: "Period", virtualKey: 0xbe, aliases: ["."] },
  { name: "Slash", virtualKey: 0xbf, aliases: ["/"] },
  { name: "Backquote", virtualKey: 0xc0, aliases: ["backtick", "`"] },
  { name: "BracketLeft", virtualKey: 0xdb, aliases: ["["] },
  { name: "Backslash", virtualKey: 0xdc, aliases: ["\\"] },
  { name: "BracketRight", virtualKey: 0xdd, aliases: ["]"] },
  { name: "Quote", virtualKey: 0xde, aliases: ["'"] },
];

let digit = 0;
while (digit <= 9) {
  declarations.push({ name: `Digit${digit}`, virtualKey: 0x30 + digit, aliases: [`${digit}`] });
  declarations.push({ name: `Numpad${digit}`, virtualKey: 0x60 + digit });
  digit += 1;
}
let letter = 0;
while (letter < 26) {
  const value = String.fromCharCode(65 + letter);
  declarations.push({ name: `Key${value}`, virtualKey: 0x41 + letter, aliases: [value] });
  letter += 1;
}
let functionKey = 1;
while (functionKey <= 24) {
  declarations.push({ name: `F${functionKey}`, virtualKey: 0x6f + functionKey });
  functionKey += 1;
}

function normalizedName(value: string): string {
  return value.trim().replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

const byAlias = new Map<string, CanonicalKey>();
const byVirtualKey = new Map<number, CanonicalKey>();
for (const declaration of declarations) {
  const canonical: CanonicalKey = {
    name: declaration.name,
    virtualKey: declaration.virtualKey,
    extended: declaration.extended === true,
    modifier: declaration.modifier === true,
  };
  byAlias.set(normalizedName(declaration.name), canonical);
  for (const alias of declaration.aliases ?? []) byAlias.set(normalizedName(alias), canonical);
  if (!byVirtualKey.has(canonical.virtualKey)) byVirtualKey.set(canonical.virtualKey, canonical);
}

export function resolveKeyboardKey(value: string): CanonicalKey | null {
  return byAlias.get(normalizedName(value)) ?? null;
}

export function canonicalKeyNameForVirtualKey(virtualKey: number): string | null {
  return byVirtualKey.get(virtualKey)?.name ?? null;
}

export function hasOnlyUnicodeScalars(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) return false;
      index += 2;
      continue;
    }
    if (first >= 0xdc00 && first <= 0xdfff) return false;
    index += 1;
  }
  return true;
}

function parseChord(value: string, maximumChordKeys: number): readonly CanonicalKey[] | null {
  const pieces = value.split("+");
  if (pieces.length === 0 || pieces.length > maximumChordKeys || pieces.some((piece) => piece.trim() === "")) return null;
  const keys: CanonicalKey[] = [];
  const seen = new Set<number>();
  for (const piece of pieces) {
    const key = resolveKeyboardKey(piece);
    if (key === null || seen.has(key.virtualKey)) return null;
    seen.add(key.virtualKey);
    keys.push(key);
  }
  return keys;
}

function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === names.length && keys.every((key, index) => key === [...names].sort()[index]);
}

export function parseKeyboardActions(
  value: unknown,
  holdMs: number,
  gapMs: number,
  maximumActions: number,
  maximumChordKeys: number,
  maximumWaitMs: number,
): readonly NativeKeyboardAction[] | null {
  const inputs = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (inputs === null || inputs.length === 0 || inputs.length > maximumActions) return null;
  const actions: NativeKeyboardAction[] = [];
  let index = 0;
  while (index < inputs.length) {
    const input = inputs[index];
    if (typeof input === "string") {
      const chord = parseChord(input, maximumChordKeys);
      if (chord === null) return null;
      actions.push({
        kind: "press",
        keys: chord.map(({ virtualKey, extended }) => ({ virtualKey, extended })),
        holdMs,
      });
    } else if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const candidate = input as Record<string, unknown>;
      if (exactKeys(candidate, ["waitMs"])) {
        if (!Number.isSafeInteger(candidate.waitMs) || (candidate.waitMs as number) < 0 || (candidate.waitMs as number) > maximumWaitMs) return null;
        actions.push({ kind: "wait", waitMs: candidate.waitMs as number });
      } else if (exactKeys(candidate, ["action", "key"]) &&
          (candidate.action === "down" || candidate.action === "up") && typeof candidate.key === "string") {
        const key = resolveKeyboardKey(candidate.key);
        if (key === null) return null;
        actions.push({ kind: candidate.action, keys: [{ virtualKey: key.virtualKey, extended: key.extended }] });
      } else {
        return null;
      }
    } else {
      return null;
    }
    if (gapMs > 0 && index + 1 < inputs.length) actions.push({ kind: "wait", waitMs: gapMs });
    index += 1;
  }
  return actions;
}

const nearbyLetters: Readonly<Record<string, string>> = {
  a: "qwsz", b: "vghn", c: "xdfv", d: "ersfcx", e: "wsdr", f: "rtgdvc", g: "tyfhvb",
  h: "yugjbn", i: "ujko", j: "uikhmn", k: "ijolm", l: "kop", m: "njk", n: "bhjm",
  o: "iklp", p: "ol", q: "wa", r: "edft", s: "awedxz", t: "rfgy", u: "yhji",
  v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
};

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
  return state.value / 0x1_0000_0000;
}

export function buildHumanTypingPlan(
  text: string,
  charactersPerMinute: number,
  mistakePercent: number,
  randomSeed: number,
): HumanTypingPlan {
  const characters = [...text];
  const state = { value: randomSeed >>> 0 };
  const baseInterval = 60000 / charactersPerMinute;
  const delaysMs: number[] = [];
  const mistakes: HumanMistake[] = [];
  let estimatedDurationMs = 0;
  let index = 0;
  while (index < characters.length) {
    const character = characters[index] ?? "";
    const punctuationFactor = /[.,!?;:\u3002\uff0c\uff01\uff1f\uff1b\uff1a]/u.test(character) ? 1.8 : 1;
    const delayMs = Math.max(0, Math.round(baseInterval * (0.7 + nextRandom(state) * 0.6) * punctuationFactor));
    delaysMs.push(delayMs);
    estimatedDurationMs += delayMs;
    const lower = character.toLowerCase();
    const neighbors = nearbyLetters[lower];
    if (neighbors !== undefined && nextRandom(state) * 100 < mistakePercent) {
      let wrong = neighbors[Math.floor(nextRandom(state) * neighbors.length)] ?? neighbors[0] ?? "";
      if (character !== lower) wrong = wrong.toUpperCase();
      const beforeBackspaceMs = Math.max(0, Math.round(baseInterval * 0.55));
      const beforeCorrectionMs = Math.max(0, Math.round(baseInterval * 0.45));
      mistakes.push({ index, wrong, beforeBackspaceMs, beforeCorrectionMs });
      estimatedDurationMs += beforeBackspaceMs + beforeCorrectionMs;
    }
    index += 1;
  }
  return { randomSeed: randomSeed >>> 0, delaysMs, mistakes, estimatedDurationMs };
}
