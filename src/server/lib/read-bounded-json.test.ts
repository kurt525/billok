import { describe, expect, test } from 'vitest';
import { readBoundedJson } from './read-bounded-json';

function request(body: ReadableStream<Uint8Array>, contentType = 'application/json') {
  return new Request('https://billok.ru/api/admin/export', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}
function stream(...chunks: Uint8Array[]) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) controller.close();
      else controller.enqueue(chunks[i++]!);
    },
  });
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe('Issue 6.12.6: bounded JSON for privileged administrative API', () => {
  test('allows exact request-size limit with and without Content-Length', async () => {
    const text = JSON.stringify({ text: 'а'.repeat(200) });
    const encoded = bytes(text);
    expect(await readBoundedJson(request(stream(encoded.slice(0, 23), encoded.slice(23))), encoded.length)).toEqual({
      text: 'а'.repeat(200),
    });
  });

  test('rejects a chunked body exceeding the limit without reading/parsing the whole request', async () => {
    const data = bytes('x'.repeat(1024));
    const response = await readBoundedJson(request(stream(data, data, data)), 1024);
    expect(response).toBeNull();
  });

  test('rejects browser CSRF form encodings and invalid JSON', async () => {
    expect(await readBoundedJson(request(stream(bytes('a=1')), 'text/plain'), 100)).toBeNull();
    expect(await readBoundedJson(request(stream(bytes('a=1')), 'application/x-www-form-urlencoded'), 100)).toBeNull();
    expect(await readBoundedJson(request(stream(bytes('{not-json}'))), 100)).toBeNull();
    expect(
      await readBoundedJson(request(stream(bytes('{"ok":true}')), 'application/json; charset=utf-8'), 100),
    ).toEqual({ ok: true });
  });

  test('bounds UTF-8 bytes, not JavaScript characters, and rejects malformed UTF-8', async () => {
    expect(await readBoundedJson(request(stream(bytes('{"message":"💰"}'))), 16)).toBeNull();
    expect(await readBoundedJson(request(stream(new Uint8Array([0xff, 0xfe]))), 100)).toBeNull();
  });
});
