export interface NativeInputFailureDetails {
  readonly reason: string;
  readonly phase: "prepare" | "input";
  readonly clickState: "not_sent" | "unknown";
}

export class NativeInputError extends Error {
  readonly code = "NATIVE_INPUT_FAILED" as const;
  readonly details: NativeInputFailureDetails;

  constructor(details: NativeInputFailureDetails, message = "Native click could not be completed safely") {
    super(message);
    this.name = "NativeInputError";
    this.details = details;
  }
}
