/**
 * The server's tRPC error formatter translates application errors into Russian.
 * Network and transport failures lack tRPC error data and may contain English
 * browser messages. Never expose those raw transport errors to the user.
 */
export function localizedTrpcError(
  error: { message: string; data?: { code?: string | null } | null | undefined },
  fallback: string,
): string {
  return error.data?.code ? error.message : fallback;
}
