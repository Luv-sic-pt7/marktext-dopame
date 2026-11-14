import { saveAs, saveResource } from '../files'
import type { SaveSnapshot } from '../domain/documentController'

/** File authorization stays in this window; the coordinator never receives a path to open. */
export const filePort = {
  async save(snapshot: SaveSnapshot, copy: boolean) {
    if (copy || !snapshot.resource) return saveAs(snapshot.name, snapshot.text)
    return { name: snapshot.name, resource: await saveResource(snapshot.resource, snapshot.text) }
  },
}
