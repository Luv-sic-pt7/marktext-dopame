export interface LocalImage {
  url: string
  size: number
}
type Context = {
  disposed: boolean
  enabled: boolean
  loader: (source: string) => Promise<LocalImage | null>
  changed: () => void
  issue: () => void
  resolved: Map<string, string>
  pending: Set<string>
  queue: string[]
  active: number
  bytes: number
  urls: Set<string>
  reported: boolean
}
let current: Context | null = null
const placeholder =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
function report(context: Context) {
  if (!context.reported) {
    context.reported = true
    context.issue()
  }
}
function release(url: string) {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
function drain(context: Context) {
  while (!context.disposed && context.active < 4 && context.queue.length) {
    const source = context.queue.shift()!
    context.active++
    void context
      .loader(source)
      .then((image) => {
        if (context.disposed) {
          if (image) release(image.url)
          return
        }
        if (
          !image ||
          image.size > 8 * 1024 * 1024 ||
          context.bytes + image.size > 64 * 1024 * 1024
        ) {
          if (image) release(image.url)
          context.resolved.set(source, placeholder)
          report(context)
        } else {
          context.bytes += image.size
          context.urls.add(image.url)
          context.resolved.set(source, image.url)
        }
        context.changed()
      })
      .catch(() => {
        if (!context.disposed) {
          context.resolved.set(source, placeholder)
          report(context)
          context.changed()
        }
      })
      .finally(() => {
        context.active--
        context.pending.delete(source)
        drain(context)
      })
  }
}
export function setImageContext(
  loader: (source: string) => Promise<LocalImage | null>,
  changed: () => void,
  issue: () => void,
  enabled = true
) {
  clearImageContext()
  current = {
    disposed: false,
    enabled,
    loader,
    changed,
    issue,
    resolved: new Map(),
    pending: new Set(),
    queue: [],
    active: 0,
    bytes: 0,
    urls: new Set(),
    reported: false
  }
}
export function clearImageContext() {
  if (current) {
    current.disposed = true
    for (const url of current.urls) release(url)
  }
  current = null
}
export function resolveImageSource(source: string): { src: string; isUnknownType: boolean } {
  const context = current
  if (context && !context.enabled) return { src: '', isUnknownType: false }
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024)
    return { src: '', isUnknownType: false }
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source)
      if (url.username || url.password) return { src: '', isUnknownType: false }
      return { src: url.href, isUnknownType: !/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url.href) }
    } catch {
      return { src: '', isUnknownType: false }
    }
  }
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(source))
    return { src: source, isUnknownType: false }
  if (source.startsWith('blob:'))
    return { src: context?.urls.has(source) ? source : '', isUnknownType: false }
  if (!context || context.disposed || /^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i.test(source))
    return { src: '', isUnknownType: false }
  const saved = context.resolved.get(source)
  if (saved) return { src: saved, isUnknownType: false }
  if (!context.pending.has(source)) {
    context.pending.add(source)
    context.queue.push(source)
    drain(context)
  }
  return { src: placeholder, isUnknownType: false }
}
