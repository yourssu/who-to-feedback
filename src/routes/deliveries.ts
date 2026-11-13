import { nowIso } from "../crypto.ts";
import { listCycleDeliveries, requireCycle } from "../db/queries.ts";
import { jsonResponse, type Router } from "../router.ts";
import { parsePathId, validateDeliveryQuery } from "../schemas.ts";
import type { DeliveryRow } from "../types.ts";

export function registerDeliveriesRoutes(router: Router): void {
  router.get(
    "/api/admin/cycles/:cycleId/deliveries",
    async ({ url, params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const filters = validateDeliveryQuery(url);
      const items = await listCycleDeliveries(env.DB, cycleId, filters);
      return jsonResponse({ items });
    },
  );

  router.post(
    "/api/admin/cycles/:cycleId/deliveries/retry-failed",
    async ({ params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      await requireCycle(env.DB, cycleId);

      const failedRes = await env.DB.prepare(
        "SELECT * FROM deliveries WHERE cycle_id = ? AND status = 'FAILED' ORDER BY id ASC",
      )
        .bind(cycleId)
        .all<DeliveryRow>();

      const now = nowIso();
      let queued_count = 0;

      for (const d of failedRes.results) {
        await env.DB.prepare(
          "UPDATE deliveries SET status = 'PENDING', error_message = '', updated_at = ? WHERE id = ?",
        )
          .bind(now, d.id)
          .run();
        await env.DELIVERY_QUEUE.send({
          job_type: "SEND_SLACK_DELIVERY",
          delivery_id: d.id,
        });
        queued_count++;
      }

      return jsonResponse({ queued_count }, 202);
    },
  );
}
