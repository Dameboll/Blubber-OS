const SERVER_ONLY_ENV_KEYS = [
  "BLUBBER_AUTH_TOKEN",
  "BLUBBER_PICKER_TOKEN",
  "BLUBBER_STARTUP_NONCE",
] as const;

/**
 * Build an environment for processes launched by the Blubber server without
 * leaking the capabilities that protect server-only APIs.
 */
export function createSafeChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  additionalBlockedKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const childEnv = { ...source };

  for (const key of [...SERVER_ONLY_ENV_KEYS, ...additionalBlockedKeys]) {
    delete childEnv[key];
  }

  return childEnv;
}
