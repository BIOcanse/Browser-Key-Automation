import { PUBLIC_TRIAL_KEY } from "../generated/command-config.js";

// Intentionally public, not a private credential. The stored Key record owns access.
export { PUBLIC_TRIAL_KEY };
export const PUBLIC_TRIAL_KEY_ID = PUBLIC_TRIAL_KEY.split(".")[1]!;
export const PUBLIC_TRIAL_KEY_NAME = "Public trial Key";
