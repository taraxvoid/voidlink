import { Database } from 'bun:sqlite'

type Stmt = {
    bind: (...args: unknown[]) => Stmt
    first: (column?: string) => Promise<unknown>
    all: () => Promise<{ results: unknown[]; success: true }>
    run: () => Promise<{ success: true; meta: { changes: number } }>
    exec: () => void
}

/**
 * Just enough of D1's API (prepare/bind/first/all/run/batch) for the Worker,
 * over bun:sqlite. `batch` runs in one transaction, as D1's does.
 */
export function testD1(sqlite = new Database(':memory:')) {
    const statement = (query: string, params: unknown[]): Stmt => {
        const stmt = () => sqlite.query(query)
        const args = params as never[]
        return {
            bind: (...next) => statement(query, next),
            first: async (column) => {
                const row = stmt().get(...args) as Record<
                    string,
                    unknown
                > | null
                if (!row) return null
                return column ? (row[column] ?? null) : row
            },
            all: async () => ({ results: stmt().all(...args), success: true }),
            run: async () => {
                const { changes } = stmt().run(...args)
                return { success: true, meta: { changes } }
            },
            exec: () => {
                stmt().run(...args)
            },
        }
    }
    const db = {
        sqlite,
        prepare: (query: string) => statement(query, []),
        batch: async (stmts: Stmt[]) => {
            sqlite.transaction(() => {
                for (const s of stmts) s.exec()
            })()
            return []
        },
    }
    return db as unknown as D1Database & { sqlite: Database }
}
