import puppeteer from "@cloudflare/puppeteer";
import { handleRequest } from "./app.ts";
import { processReportGenerationJob } from "./reporting/generator.ts";
import { processSlackDeliveryJob } from "./slack/delivery.ts";
import type {
  D1Database,
  Env,
  ExecutionContext,
  MessageBatch,
  QueueMessage,
  R2Bucket,
  R2ObjectBody,
  ReportGenerationJobMessage,
  ScheduledController,
  SlackDeliveryJobMessage,
} from "./types.ts";

function toUint8Array(
  value: string | Uint8Array | ArrayBuffer | ReadableStream,
): Promise<Uint8Array> | Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Response(value).arrayBuffer().then((buf) => new Uint8Array(buf));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createD1FallbackBucket(db: D1Database): R2Bucket {
  const ensureTable = async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS _r2_fallback_objects (
          key TEXT PRIMARY KEY,
          content_type TEXT NOT NULL,
          data_b64 TEXT NOT NULL,
          size INTEGER NOT NULL
        )`,
      )
      .run();
  };

  return {
    async put(key, value, options) {
      await ensureTable();
      const bytes = await toUint8Array(value);
      const contentType =
        options?.httpMetadata?.contentType ?? "application/octet-stream";
      await db
        .prepare(
          `INSERT INTO _r2_fallback_objects (key, content_type, data_b64, size)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             content_type = excluded.content_type,
             data_b64 = excluded.data_b64,
             size = excluded.size`,
        )
        .bind(key, contentType, bytesToBase64(bytes), bytes.byteLength)
        .run();
      return { key };
    },
    async get(key): Promise<R2ObjectBody | null> {
      await ensureTable();
      const row = await db
        .prepare(
          "SELECT key, content_type, data_b64, size FROM _r2_fallback_objects WHERE key = ?",
        )
        .bind(key)
        .first<{
          key: string;
          content_type: string;
          data_b64: string;
          size: number;
        }>();
      if (!row) return null;
      const bytes = base64ToBytes(row.data_b64);
      return {
        key: row.key,
        size: row.size,
        httpMetadata: { contentType: row.content_type },
        async arrayBuffer() {
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        },
        async text() {
          return new TextDecoder().decode(bytes);
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
    async delete(keys) {
      await ensureTable();
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        await db
          .prepare("DELETE FROM _r2_fallback_objects WHERE key = ?")
          .bind(k)
          .run();
      }
    },
  };
}

function withRuntimeBindings(rawEnv: Env, ctx?: ExecutionContext): Env {
  const env: Env = { ...rawEnv };
  if (!env.FILES) {
    env.FILES = createD1FallbackBucket(env.DB);
  }
  if (!env.REPORT_QUEUE) {
    env.REPORT_QUEUE = {
      async send(message: ReportGenerationJobMessage) {
        const task = processReportGenerationJob(env, message);
        if (ctx) {
          ctx.waitUntil(task);
        }
        await task;
      },
    };
  }
  if (!env.DELIVERY_QUEUE) {
    env.DELIVERY_QUEUE = {
      async send(message: SlackDeliveryJobMessage) {
        const task = processSlackDeliveryJob(env, message);
        if (ctx) {
          ctx.waitUntil(task);
        }
        await task;
      },
    };
  }
  return env;
}

export async function processQueueMessage(
  rawEnv: Env,
  message: QueueMessage,
  sharedBrowser?: any,
): Promise<void> {
  const env = withRuntimeBindings(rawEnv);
  if (message.job_type === "GENERATE_REPORT") {
    await processReportGenerationJob(env, message, sharedBrowser);
  } else if (message.job_type === "SEND_SLACK_DELIVERY") {
    await processSlackDeliveryJob(env, message);
  }
}

export async function runScheduledMaintenance(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM login_attempts WHERE updated_at <= ?").bind(
      now - 24 * 60 * 60 * 1000,
    ),
  ]);
}

export default {
  async fetch(
    request: Request,
    rawEnv: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const env = withRuntimeBindings(rawEnv, ctx);
    return handleRequest(request, env);
  },

  async queue(
    batch: MessageBatch<QueueMessage>,
    rawEnv: Env,
    ctx?: ExecutionContext,
  ): Promise<void> {
    const env = withRuntimeBindings(rawEnv, ctx);
    const hasReportJobs = batch.messages.some(
      (m) => m.body.job_type === "GENERATE_REPORT",
    );

    let sharedBrowser: any = undefined;
    if (hasReportJobs && env.BROWSER && !env.PDF_RENDERER) {
      try {
        sharedBrowser = await puppeteer.launch(env.BROWSER as any);
      } catch (err) {
        console.error(
          "Shared browser launch failed (will retry in 15s):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    try {
      for (const msg of batch.messages) {
        try {
          await processQueueMessage(env, msg.body, sharedBrowser);
          msg.ack();
        } catch (err) {
          console.error("Queue consumer error (retrying in 15s):", err);
          msg.retry({ delaySeconds: 15 });
        }
      }
    } finally {
      if (sharedBrowser) {
        await sharedBrowser.close().catch(() => {});
      }
    }
  },

  async scheduled(
    _controller: ScheduledController,
    rawEnv: Env,
    _ctx?: ExecutionContext,
  ): Promise<void> {
    await runScheduledMaintenance(rawEnv);
  },
};

