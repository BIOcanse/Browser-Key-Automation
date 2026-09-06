import { USER_SCRIPTS_SETUP_REQUIRED } from "../shared/user-scripts.js";

export type CapabilityUnavailableReason =
  | "CHROMIUM_API_FAILED"
  | "HOST_ACCESS_UNAVAILABLE"
  | "NATIVE_BACKEND_UNAVAILABLE"
  | "RESTRICTED_PAGE"
  | "TARGET_TAB_NOT_VISIBLE"
  | "UNEXPECTED_PLATFORM_RESULT"
  | "USER_SCRIPTS_NOT_ENABLED";

export interface CapabilityUnavailableDetails {
  readonly capabilityId: string;
  readonly reason: CapabilityUnavailableReason;
  readonly setupInstructions?: string;
}

export class CapabilityUnavailableError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE" as const;
  readonly details: CapabilityUnavailableDetails;

  constructor(capabilityId: string, reason: CapabilityUnavailableReason, message: string) {
    super(message);
    this.name = "CapabilityUnavailableError";
    this.details = reason === "USER_SCRIPTS_NOT_ENABLED"
      ? { capabilityId, reason, setupInstructions: USER_SCRIPTS_SETUP_REQUIRED }
      : { capabilityId, reason };
  }
}
