import type { DatabaseDriver, SQLQueryBindings } from "../repository";
export class DurableSqlite implements DatabaseDriver {
  constructor(private storage: DurableObjectStorage) {}
  exec(sql: string) {
    this.storage.sql.exec(sql).toArray();
  }
  query(sql: string) {
    const execute = (args: SQLQueryBindings[]) =>
      this.storage.sql.exec(
        sql,
        ...args.map((value) =>
          typeof value === "bigint"
            ? Number(value)
            : typeof value === "boolean"
              ? Number(value)
              : value,
        ),
      );
    return {
      all: (...args: SQLQueryBindings[]) => execute(args).toArray(),
      get: (...args: SQLQueryBindings[]) => execute(args).toArray()[0] ?? null,
      run: (...args: SQLQueryBindings[]) => {
        execute(args).toArray();
        const row = this.storage.sql
          .exec("SELECT changes() AS changes, last_insert_rowid() AS id")
          .one();
        return {
          changes: Number(row.changes),
          lastInsertRowid: Number(row.id),
        };
      },
    };
  }
  transaction<T>(fn: () => T) {
    return { immediate: () => this.storage.transactionSync(fn) };
  }
  close() {}
}
