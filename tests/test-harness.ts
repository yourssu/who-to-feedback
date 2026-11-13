import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker, { processQueueMessage } from "../src/index.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  Env,
  Queue,
  QueueMessage,
  R2Bucket,
  R2ObjectBody,
  ReportGenerationJobMessage,
  SlackDeliveryJobMessage,
} from "../src/types.ts";

class SqliteD1PreparedStatement implements D1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as any[])) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async run(): Promise<D1Result> {
    const stmt = this.db.prepare(this.sql);
    const res = stmt.run(...(this.params as any[]));
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(res.changes),
        last_row_id: Number(res.lastInsertRowid),
      },
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.params as any[])) as T[];
    return {
      results: rows,
      success: true,
      meta: { changes: 0, last_row_id: 0 },
    };
  }
}

export class SqliteD1Database implements D1Database {
  rawDb: DatabaseSync;

  constructor() {
    this.rawDb = new DatabaseSync(":memory:");
    const schemaSql = readFileSync(
      resolve("migrations/0001_initial.sql"),
      "utf-8",
    );
    this.rawDb.exec(schemaSql);
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.rawDb, query);
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.rawDb.exec("BEGIN IMMEDIATE");
    try {
      const out: D1Result<T>[] = [];
      for (const stmt of statements) {
        out.push((await stmt.run()) as D1Result<T>);
      }
      this.rawDb.exec("COMMIT");
      return out;
    } catch (err) {
      this.rawDb.exec("ROLLBACK");
      throw err;
    }
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.rawDb.exec(query);
    return { count: 1, duration: 0 };
  }
}

export class MemoryR2Bucket implements R2Bucket {
  objects = new Map<
    string,
    { bytes: Uint8Array; httpMetadata?: { contentType?: string } }
  >();

  async put(
    key: string,
    value: string | Uint8Array | ArrayBuffer | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown> {
    let bytes: Uint8Array;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      bytes = new Uint8Array(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk);
      }
      const total = chunks.reduce((a, b) => a + b.byteLength, 0);
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
    }
    this.objects.set(key, { bytes, httpMetadata: options?.httpMetadata });
    return { key };
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    const copy = new Uint8Array(entry.bytes);
    return {
      key,
      size: copy.byteLength,
      httpMetadata: entry.httpMetadata,
      async arrayBuffer() {
        return copy.buffer.slice(
          copy.byteOffset,
          copy.byteOffset + copy.byteLength,
        );
      },
      async text() {
        return new TextDecoder().decode(copy);
      },
      body: null,
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.objects.delete(k);
    }
  }
}

export function createTestEnv(): {
  env: Env;
  db: SqliteD1Database;
  r2: MemoryR2Bucket;
  queuedMessages: QueueMessage[];
  flushQueues: () => Promise<void>;
  request: (
    path: string,
    options?: {
      method?: string;
      cookie?: string;
      csrfToken?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ) => Promise<Response>;
} {
  const db = new SqliteD1Database();
  const r2 = new MemoryR2Bucket();
  const queuedMessages: QueueMessage[] = [];

  const reportQueue: Queue<ReportGenerationJobMessage> = {
    async send(message) {
      queuedMessages.push(message);
    },
  };
  const deliveryQueue: Queue<SlackDeliveryJobMessage> = {
    async send(message) {
      queuedMessages.push(message);
    },
  };

  const env: Env = {
    DB: db,
    FILES: r2,
    REPORT_QUEUE: reportQueue,
    DELIVERY_QUEUE: deliveryQueue,
    SITE_URL: "http://localhost:8787",
    MOCK_SLACK_MODE: "true",
  };

  async function flushQueues(): Promise<void> {
    while (queuedMessages.length > 0) {
      const msg = queuedMessages.shift()!;
      await processQueueMessage(env, msg);
    }
  }

  async function request(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      csrfToken?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers || {});
    if (options.cookie) {
      headers.set("Cookie", options.cookie);
    }
    if (options.csrfToken) {
      headers.set("X-CSRF-Token", options.csrfToken);
    }
    let bodyInit: BodyInit | undefined;
    if (options.body instanceof FormData) {
      bodyInit = options.body;
    } else if (options.body !== undefined) {
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      bodyInit =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
    }
    const req = new Request(`http://localhost:8787${path}`, {
      method: options.method ?? "GET",
      headers,
      body: bodyInit,
    });
    return worker.fetch(req, env);
  }

  return { env, db, r2, queuedMessages, flushQueues, request };
}
