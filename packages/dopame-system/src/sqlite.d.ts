declare module 'bun:sqlite' {
  export type SQLValue = string | number | bigint | null | Uint8Array
  export interface Statement<T = Record<string, unknown>> {
    get(...bindings: SQLValue[]): T | null
    all(...bindings: SQLValue[]): T[]
    run(...bindings: SQLValue[]): { changes: number; lastInsertRowid: number | bigint }
  }
  export class Database {
    constructor(path: string, options?: { strict?: boolean; readonly?: boolean; create?: boolean })
    exec(sql: string): void
    query<T = Record<string, unknown>>(sql: string): Statement<T>
    transaction<T>(callback: () => T): () => T
    close(): void
  }
}
