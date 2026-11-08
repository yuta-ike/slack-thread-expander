export class BodyTooLargeError extends Error {}

// Check actual streamed bytes as Content-Length may be absent or untrusted.
export async function readTextLimited(body: ReadableStream<Uint8Array>, limit: number) {
  using disposer = new DisposableStack()
  const reader = disposer.adopt(body.getReader(), (r) => r.releaseLock())

  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new BodyTooLargeError("Body exceeds limit")
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
