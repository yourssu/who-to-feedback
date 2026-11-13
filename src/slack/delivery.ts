import { nowIso } from "../crypto.ts";
import {
  isCycleDeadlinePassed,
  requireCycle,
  requireMember,
} from "../db/queries.ts";
import type {
  DeliveryRow,
  Env,
  ReportRecord,
  SlackClient,
  SlackDeliveryJobMessage,
} from "../types.ts";

async function slackApiPostJson(
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !data.ok) {
    throw new Error(
      `Slack API 오류 (${endpoint}): ${String(data.error ?? res.statusText)}`,
    );
  }
  return data;
}

async function resolveSlackUserAndChannel(
  token: string,
  email: string,
  slackUserId: string,
): Promise<{ userId: string; channelId: string; resolvedNew: boolean }> {
  let userId = slackUserId.trim();
  let resolvedNew = false;

  if (!/^[UW][A-Z0-9]+$/.test(userId)) {
    const query = new URLSearchParams({ email });
    const lookupRes = await fetch(
      `https://slack.com/api/users.lookupByEmail?${query.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const lookupData = (await lookupRes.json()) as {
      ok?: boolean;
      error?: string;
      user?: { id?: string };
    };
    if (!lookupRes.ok || !lookupData.ok || !lookupData.user?.id) {
      throw new Error(
        `Slack User ID 조회 실패 (${email}): ${lookupData.error ?? "not_found"}`,
      );
    }
    userId = lookupData.user.id;
    resolvedNew = true;
  }

  const openData = (await slackApiPostJson(token, "conversations.open", {
    users: userId,
  })) as { channel?: { id?: string } };
  const channelId = openData.channel?.id;
  if (!channelId) {
    throw new Error("Slack DM 채널을 열 수 없습니다.");
  }
  return { userId, channelId, resolvedNew };
}

async function uploadSingleFileV2(
  token: string,
  filename: string,
  title: string,
  bytes: Uint8Array,
): Promise<{ id: string; title: string }> {
  const form = new URLSearchParams({
    filename,
    length: String(bytes.byteLength),
  });
  const urlRes = await fetch(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  const urlData = (await urlRes.json()) as {
    ok?: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  };
  if (
    !urlRes.ok ||
    !urlData.ok ||
    !urlData.upload_url ||
    !urlData.file_id
  ) {
    throw new Error(
      `Slack 업로드 URL 발급 실패: ${urlData.error ?? "unknown"}`,
    );
  }

  const putRes = await fetch(urlData.upload_url, {
    method: "POST",
    body: bytes as unknown as BodyInit,
  });
  if (!putRes.ok) {
    throw new Error(`Slack 파일 바이너리 업로드 실패 (${putRes.status})`);
  }
  return { id: urlData.file_id, title };
}

export const defaultSlackClient: SlackClient = {
  async sendDmText({ email, slackUserId, text, env }) {
    if ((env.MOCK_SLACK_MODE ?? "true").toLowerCase() !== "false") {
      console.log(
        `[MOCK_SLACK_MODE][SLACK_DM] to=<${email}> (slack_user_id=${slackUserId || "none"}) | message=${text.replace(/\n/g, " | ")}`,
      );
      return {};
    }
    if (!env.SLACK_BOT_TOKEN) {
      throw new Error("SLACK_BOT_TOKEN 환경변수가 설정되지 않았습니다.");
    }
    const { userId, channelId, resolvedNew } = await resolveSlackUserAndChannel(
      env.SLACK_BOT_TOKEN,
      email,
      slackUserId,
    );
    await slackApiPostJson(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: channelId,
      text,
    });
    return resolvedNew ? { resolvedSlackUserId: userId } : {};
  },

  async sendReportFiles({
    email,
    slackUserId,
    cycleId,
    cycleTitle,
    memberId,
    memberName,
    htmlBytes,
    pdfBytes,
    env,
  }) {
    if ((env.MOCK_SLACK_MODE ?? "true").toLowerCase() !== "false") {
      console.log(
        `[MOCK_SLACK_MODE][SLACK_REPORT_DM] to="${memberName}" <${email}> | cycle="${cycleTitle}" (#${cycleId}) | files=[HTML:${htmlBytes.byteLength}B, PDF:${pdfBytes.byteLength}B]`,
      );
      return {};
    }
    if (!env.SLACK_BOT_TOKEN) {
      throw new Error("SLACK_BOT_TOKEN 환경변수가 설정되지 않았습니다.");
    }
    const { userId, channelId, resolvedNew } = await resolveSlackUserAndChannel(
      env.SLACK_BOT_TOKEN,
      email,
      slackUserId,
    );
    const htmlFile = await uploadSingleFileV2(
      env.SLACK_BOT_TOKEN,
      `peer_review_${cycleId}_${memberId}.html`,
      `${cycleTitle} 피어리뷰 리포트_${memberName} (HTML)`,
      htmlBytes,
    );
    const pdfFile = await uploadSingleFileV2(
      env.SLACK_BOT_TOKEN,
      `peer_review_${cycleId}_${memberId}.pdf`,
      `${cycleTitle} 피어리뷰 리포트_${memberName} (PDF)`,
      pdfBytes,
    );
    await slackApiPostJson(
      env.SLACK_BOT_TOKEN,
      "files.completeUploadExternal",
      {
        channel_id: channelId,
        initial_comment: `[${cycleTitle}] 피어리뷰 HTML·PDF 결과 리포트가 도착했습니다.`,
        files: [htmlFile, pdfFile],
      },
    );
    return resolvedNew ? { resolvedSlackUserId: userId } : {};
  },
};

async function maybeCloseCompletedCycle(
  env: Env,
  cycleId: number,
): Promise<void> {
  const targetsRow = await env.DB.prepare(
    "SELECT COUNT(DISTINCT reviewee_id) AS cnt FROM assignments WHERE cycle_id = ?",
  )
    .bind(cycleId)
    .first<{ cnt: number }>();
  const sentRow = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM reports WHERE cycle_id = ? AND approval_status = 'SENT'",
  )
    .bind(cycleId)
    .first<{ cnt: number }>();

  const targets = Number(targetsRow?.cnt ?? 0);
  const sent = Number(sentRow?.cnt ?? 0);
  if (targets > 0 && sent === targets) {
    await env.DB.prepare(
      "UPDATE cycles SET status = 'CLOSED', updated_at = ? WHERE id = ? AND status = 'COMPLETED'",
    )
      .bind(nowIso(), cycleId)
      .run();
  }
}

export async function processSlackDeliveryJob(
  env: Env,
  msg: SlackDeliveryJobMessage,
): Promise<void> {
  const delivery = await env.DB.prepare(
    "SELECT * FROM deliveries WHERE id = ?",
  )
    .bind(msg.delivery_id)
    .first<DeliveryRow>();

  if (!delivery || delivery.status === "SENT") {
    return;
  }

  const client = env.SLACK_CLIENT ?? defaultSlackClient;
  const siteUrl = (env.SITE_URL ?? "http://localhost:8787").replace(/\/+$/, "");

  await env.DB.prepare(
    "UPDATE deliveries SET attempts = attempts + 1, updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), delivery.id)
    .run();

  try {
    const [cycle, member] = await Promise.all([
      requireCycle(env.DB, delivery.cycle_id),
      requireMember(env.DB, delivery.member_id),
    ]);

    let resolvedSlackUserId: string | undefined;

    if (delivery.delivery_type === "PIN_ISSUE") {
      if (cycle.status !== "ACTIVE" || isCycleDeadlinePassed(cycle)) {
        await env.DB.prepare(
          "UPDATE deliveries SET status = 'FAILED', error_message = '회차가 마감되어 PIN 발송이 취소되었습니다.', updated_at = ? WHERE id = ?",
        )
          .bind(nowIso(), delivery.id)
          .run();
        return;
      }
      const pinRow = await env.DB.prepare(
        "SELECT code FROM pins WHERE cycle_id = ? AND member_id = ?",
      )
        .bind(cycle.id, member.id)
        .first<{ code: string }>();
      if (!pinRow) {
        throw new Error("발급된 PIN 코드를 찾을 수 없습니다.");
      }
      const text = `[${cycle.title}] 피어리뷰를 시작해 주세요.\n6자리 PIN: ${pinRow.code}\n참여 링크: ${siteUrl}/login`;
      const res = await client.sendDmText({
        email: member.email,
        slackUserId: member.slack_user_id,
        text,
        env,
      });
      resolvedSlackUserId = res.resolvedSlackUserId;
    } else if (delivery.delivery_type === "REMINDER") {
      if (cycle.status !== "ACTIVE" || isCycleDeadlinePassed(cycle)) {
        await env.DB.prepare(
          "UPDATE deliveries SET status = 'FAILED', error_message = '회차가 마감되어 리마인더 발송이 취소되었습니다.', updated_at = ? WHERE id = ?",
        )
          .bind(nowIso(), delivery.id)
          .run();
        return;
      }
      const unsubmittedRes = await env.DB.prepare(
        `SELECT m.name
         FROM assignments a
         JOIN members m ON m.id = a.reviewee_id
         WHERE a.cycle_id = ? AND a.reviewer_id = ? AND a.is_submitted = 0
         ORDER BY a.id ASC`,
      )
        .bind(cycle.id, member.id)
        .all<{ name: string }>();

      const names = unsubmittedRes.results.map((r) => r.name);
      const text = `[${cycle.title}] 아직 작성하지 않은 리뷰 대상자: ${names.join(", ")}\n작성하러 가기: ${siteUrl}/`;
      const res = await client.sendDmText({
        email: member.email,
        slackUserId: member.slack_user_id,
        text,
        env,
      });
      resolvedSlackUserId = res.resolvedSlackUserId;
    } else if (delivery.delivery_type === "REPORT") {
      if (!delivery.report_id) {
        throw new Error("리포트 ID가 누락되었습니다.");
      }
      const report = await env.DB.prepare(
        "SELECT * FROM reports WHERE id = ?",
      )
        .bind(delivery.report_id)
        .first<ReportRecord>();

      if (
        !report ||
        report.generation_status !== "READY" ||
        report.approval_status === "NEEDS_REVIEW" ||
        !report.html_r2_key ||
        !report.pdf_r2_key ||
        report.content_hash !== report.approved_hash
      ) {
        throw new Error("승인된 최신 HTML·PDF 리포트가 준비되지 않았습니다.");
      }

      const [htmlObj, pdfObj] = await Promise.all([
        env.FILES.get(report.html_r2_key),
        env.FILES.get(report.pdf_r2_key),
      ]);
      if (!htmlObj || !pdfObj) {
        throw new Error("R2 스토리지에서 리포트 파일을 찾을 수 없습니다.");
      }

      const res = await client.sendReportFiles({
        email: member.email,
        slackUserId: member.slack_user_id,
        cycleId: cycle.id,
        cycleTitle: cycle.title,
        memberId: member.id,
        memberName: member.name,
        htmlBytes: new Uint8Array(await htmlObj.arrayBuffer()),
        pdfBytes: new Uint8Array(await pdfObj.arrayBuffer()),
        env,
      });
      resolvedSlackUserId = res.resolvedSlackUserId;

      const sentAt = nowIso();
      await env.DB.prepare(
        "UPDATE reports SET approval_status = 'SENT', sent_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(sentAt, sentAt, report.id)
        .run();
    }

    const now = nowIso();
    if (resolvedSlackUserId) {
      await env.DB.prepare(
        "UPDATE members SET slack_user_id = ?, updated_at = ? WHERE id = ?",
      )
        .bind(resolvedSlackUserId, now, member.id)
        .run();
    }

    await env.DB.prepare(
      "UPDATE deliveries SET status = 'SENT', error_message = '', sent_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(now, now, delivery.id)
      .run();

    if (delivery.delivery_type === "REPORT") {
      await maybeCloseCompletedCycle(env, delivery.cycle_id);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Slack DM 발송에 실패했습니다.";
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ?",
    )
      .bind(message, nowIso(), delivery.id)
      .run();
  }
}
