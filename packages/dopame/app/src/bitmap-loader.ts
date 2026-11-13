const maximumBytes = 8 * 1024 * 1024
export function bitmapSize(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to))
  let width = 0,
    height = 0
  if (data.length >= 24 && ascii(1, 4) === 'PNG' && data[0] === 137 && ascii(12, 16) === 'IHDR') {
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (data.length >= 10 && /^GIF8[79]a$/.test(ascii(0, 6))) {
    width = view.getUint16(6, true)
    height = view.getUint16(8, true)
  } else if (data.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const kind = ascii(12, 16)
    const u24 = (offset: number) =>
      data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16)
    if (kind === 'VP8X') {
      width = u24(24) + 1
      height = u24(27) + 1
    } else if (kind === 'VP8L' && data[20] === 47) {
      const bits = view.getUint32(21, true)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    } else if (kind === 'VP8 ' && data[23] === 157 && data[24] === 1 && data[25] === 42) {
      width = view.getUint16(26, true) & 0x3fff
      height = view.getUint16(28, true) & 0x3fff
    }
  } else if (data[0] === 255 && data[1] === 216) {
    let offset = 2
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break
      while (data[offset] === 255) offset++
      const marker = data[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > data.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > data.length) break
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 7
      ) {
        height = view.getUint16(offset + 3)
        width = view.getUint16(offset + 5)
        break
      }
      offset += length
    }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 16 * 1024 * 1024)
    throw new Error('Unsupported or oversized bitmap')
  return { width, height }
}

/** Read bitmap headers without relying on off-DOM Image load events in acdert 0.0.9. */
export async function loadBitmap(url: string) {
  let data: Uint8Array
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(url)) {
    const encoded = url.slice(url.indexOf(',') + 1)
    if (encoded.length > Math.ceil(maximumBytes / 3) * 4)
      throw new Error('Image exceeded byte limit')
    data = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), credentials: 'omit' })
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get('content-length') ?? 0) > maximumBytes
    )
      throw new Error('Image unavailable')
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > maximumBytes) throw new Error('Image exceeded byte limit')
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    data = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.length
    }
  }
  if (data.length > maximumBytes) throw new Error('Image exceeded byte limit')
  return { url, ...bitmapSize(data) }
}
