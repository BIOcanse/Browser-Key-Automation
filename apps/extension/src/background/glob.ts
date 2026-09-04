export function linearGlobMatch(value: string, pattern: string): boolean {
  const input = Array.from(value);
  const glob = Array.from(pattern);
  let inputIndex = 0;
  let globIndex = 0;
  let starIndex = -1;
  let starInput = 0;
  while (inputIndex < input.length) {
    if (globIndex < glob.length && (glob[globIndex] === "?" || glob[globIndex] === input[inputIndex])) {
      inputIndex += 1;
      globIndex += 1;
      continue;
    }
    if (globIndex < glob.length && glob[globIndex] === "*") {
      starIndex = globIndex;
      globIndex += 1;
      starInput = inputIndex;
      continue;
    }
    if (starIndex >= 0) {
      starInput += 1;
      inputIndex = starInput;
      globIndex = starIndex + 1;
      continue;
    }
    return false;
  }
  while (globIndex < glob.length && glob[globIndex] === "*") globIndex += 1;
  return globIndex === glob.length;
}
