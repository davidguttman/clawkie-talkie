export const DEFAULT_CLIENT_ORIGIN = 'https://clawkietalkie.app';

export function resolveClientOrigin(
  cliValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return cliValue?.trim() || env.CT_CLIENT_ORIGIN?.trim() || DEFAULT_CLIENT_ORIGIN;
}
