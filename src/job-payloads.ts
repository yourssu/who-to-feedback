import { z } from "zod";
import type { JobKind } from "./models";
const id = z.number().int().positive();
const schemas = {
  GENERATE: z.object({
    kind: z.literal("GENERATE"),
    payload: z.object({
      cycle_id: id,
      member_id: id.optional(),
      sample: z.boolean().optional(),
    }),
  }),
  PDF: z.object({
    kind: z.literal("PDF"),
    payload: z.object({
      report_id: id,
      html_hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  }),
  DM: z.object({
    kind: z.literal("DM"),
    payload: z
      .object({
        member_id: id,
        cycle_id: id.optional(),
        type: z.enum(["AUTH_CODE", "REMINDER", "CUSTOM_MSG", "TEST_DM"]),
        text: z.string(),
      })
      .refine(
        (p) =>
          !["AUTH_CODE", "REMINDER"].includes(p.type) ||
          p.cycle_id !== undefined,
      ),
  }),
  REPORT: z.object({
    kind: z.literal("REPORT"),
    payload: z.object({
      member_id: id,
      cycle_id: id,
      type: z.literal("REPORT"),
      report_id: id,
      revision: id,
      html_hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  }),
};
const workSchema = z.discriminatedUnion("kind", [
  schemas.GENERATE,
  schemas.PDF,
  schemas.DM,
  schemas.REPORT,
]);
export function parseJobPayload(kind: JobKind, source: string) {
  return workSchema.parse({ kind, payload: JSON.parse(source) });
}
