export interface NativeInputFailureDetails {
  readonly reason: string;
  readonly phase: "prepare" | "input";
  readonly clickState: "not_sent" | "unknown";
}

export interface NativeKeyboardFailureDetails {
  readonly reason: string;
  readonly phase: "prepare" | "input";
  readonly inputState: "not_sent" | "partially_sent" | "unknown";
  readonly completedActions: number;
}

export class NativeInputError extends Error {
  readonly code = "NATIVE_INPUT_FAILED" as const;
  readonly details: NativeInputFailureDetails | NativeKeyboardFailureDetails;

  constructor(details: NativeInputFailureDetails | NativeKeyboardFailureDetails, message = "Native input could not be completed safely") {
    super(message);
    this.name = "NativeInputError";
    this.details = details;
  }
}
