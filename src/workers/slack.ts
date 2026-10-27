import type { Repository } from "../repository";
import type { DeliveryPayload } from "../models";
export class SlackError extends Error {
  constructor(
    message: string,
    public known: boolean,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
export async function deliver(
  repo: Repository,
  p: DeliveryPayload,
  env: {
    TEST_MODE?: string;
    MOCK_SLACK_MODE: string;
    SLACK_BOT_TOKEN?: string;
  },
) {
  if (env.TEST_MODE === "true" || env.MOCK_SLACK_MODE === "true") return;
  if (env.MOCK_SLACK_MODE !== "false" || !env.SLACK_BOT_TOKEN)
    throw new SlackError("Explicit Slack mode and secret required", true);
  let uploadStarted = false;
  async function api(method: string, data: Record<string, unknown>) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429)
      throw new SlackError(
        "Slack rate limit",
        !uploadStarted,
        Number(response.headers.get("retry-after") ?? 30),
      );
    if (!response.ok)
      throw new SlackError(`Slack HTTP ${response.status}`, false);
    const result = (await response.json()) as any;
    if (!result.ok)
      throw new SlackError(
        String(result.error ?? "Slack rejected request"),
        !uploadStarted,
      );
    return result;
  }
  const member = repo.require("members", p.member_id);
  let user = member.slack_user_id;
  if (!/^[UW][A-Z0-9]+$/.test(user)) {
    user = (await api("users.lookupByEmail", { email: member.email })).user?.id;
    if (!user) throw new SlackError("Slack user not found", true);
    repo.run("UPDATE members SET slack_user_id=? WHERE id=?", user, member.id);
  }
  const channel = (await api("conversations.open", { users: user })).channel
    ?.id;
  if (!channel) throw new SlackError("Slack DM channel not found", true);
  if (p.type !== "REPORT") {
    await api("chat.postMessage", { channel, text: p.text });
    return;
  }
  const report = repo.require("reports", p.report_id),
    cycle = repo.require("cycles", p.cycle_id);
  if (
    report.validation_status !== "APPROVED" ||
    report.revision !== p.revision ||
    report.approved_hash !== p.html_hash ||
    !report.html ||
    !report.pdf ||
    report.pdf_status !== "READY"
  )
    throw new SlackError("Report approval changed", true);
  const files = [];
  for (const [extension, reference] of [
    ["html", report.html],
    ["pdf", report.pdf],
  ] as const) {
    const file = await repo.platform!.artifact(
      reference,
      extension === "html" ? "text/html" : "application/pdf",
    );
    if (!file.ok) throw new SlackError("Report artifact missing", true);
    const filename = `peer_review_${cycle.id}_${member.id}.${extension}`;
    const upload = await api("files.getUploadURLExternal", {
      filename,
      length: Number(file.headers.get("Content-Length")),
    });
    const target = new URL(upload.upload_url);
    if (target.protocol !== "https:" || !target.hostname.endsWith(".slack.com"))
      throw new SlackError("Unexpected upload URL", true);
    uploadStarted = true;
    const uploaded = await fetch(target, {
      method: "POST",
      body: file.body,
      signal: AbortSignal.timeout(60000),
    });
    if (!uploaded.ok)
      throw new SlackError("Slack upload result uncertain", false);
    files.push({
      id: upload.file_id,
      title: `${cycle.title} 피어리뷰 리포트_${member.name} (${extension.toUpperCase()})`,
    });
  }
  await api("files.completeUploadExternal", {
    channel_id: channel,
    files,
    initial_comment: `[${cycle.title}] 피어리뷰 HTML·PDF 결과 리포트가 도착했습니다.`,
  });
}
