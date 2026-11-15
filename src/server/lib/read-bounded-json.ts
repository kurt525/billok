/**
 * Refuse oversized JSON API bodies even when Content-Length is missing or
 * falsified (chunked transfer). Nothing reaches JSON.parse above the limit.
 * A browser cannot submit a text/plain form into the privileged JSON APIs.
 */
export async function readBoundedJson(req: Request, maxBytes: number): Promise<unknown | null> {
  const mime = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime !== 'application/json' && !mime.endsWith('+json')) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;

  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
