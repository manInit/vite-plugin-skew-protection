// The plugin turns this import into a string, see `build/inline-script.ts`.
// oxlint-disable-next-line import/default
import recoveryScript from './recovery.ts?inline-script';

/** Builds the inline script that is injected into <head> before the app, see `recovery.ts`. */
export function createRecoveryScript(cooldownMs: number): string {
  return recoveryScript.replaceAll('__SKEW_COOLDOWN_MS__', JSON.stringify(cooldownMs));
}
