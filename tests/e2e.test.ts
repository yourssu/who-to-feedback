import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestEnv } from "./test-harness.ts";

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "Expected Set-Cookie header");
  return setCookie!.split(";")[0];
}

async function readJson(res: Response): Promise<any> {
  return res.json();
}

describe("PeerFlow v2 OpenAPI & D1 End-to-End Pipeline", () => {
  it("completes the full peer review lifecycle from setup to CLOSED", async () => {
    const { db, flushQueues, request } = createTestEnv();

    // 1. Health check & Setup status
    const healthRes = await request("/api/health");
    assert.equal(healthRes.status, 200);
    const healthData = await readJson(healthRes);
    assert.equal(healthData.status, "ok");

    const setupStatusRes = await request("/api/auth/setup-status");
    assert.equal(setupStatusRes.status, 200);
    assert.deepEqual(await readJson(setupStatusRes), { needs_setup: true });

    // 2. Initial Admin Setup
    const setupRes = await request("/api/auth/setup", {
      method: "POST",
      body: {
        username: "admin",
        email: "admin@example.com",
        password: "password1234",
      },
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = extractCookie(setupRes);
    const adminSession = await readJson(setupRes);
    assert.equal(adminSession.role, "ADMIN");
    assert.equal(adminSession.admin.username, "admin");
    const adminCsrf = adminSession.csrf_token;

    // Duplicate setup returns 409
    const dupSetupRes = await request("/api/auth/setup", {
      method: "POST",
      body: {
        username: "admin2",
        email: "admin2@example.com",
        password: "password1234",
      },
    });
    assert.equal(dupSetupRes.status, 409);

    // 3. Members: single add + CSV import + invalid CSV 422
    const m1Res = await request("/api/admin/members", {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: {
        name: "김철수",
        email: "chulsoo@example.com",
        department: "백엔드",
        slack_user_id: "U10001",
      },
    });
    assert.equal(m1Res.status, 201);
    const member1 = await readJson(m1Res);

    const csvForm = new FormData();
    const csvText =
      "name,email,department,slack_user_id\n이영희,younghee@example.com,백엔드,U10002\n박민수,minsoo@example.com,프론트엔드,U10003\n";
    csvForm.set(
      "csv_file",
      new File([csvText], "members.csv", { type: "text/csv" }),
    );
    const csvRes = await request("/api/admin/members/import-csv", {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: csvForm,
    });
    assert.equal(csvRes.status, 200);
    assert.deepEqual(await readJson(csvRes), {
      created_count: 2,
      updated_count: 0,
    });

    // Invalid CSV returns 422 CsvValidationErrorResponse
    const badCsvForm = new FormData();
    badCsvForm.set(
      "csv_file",
      new File(["name,email\n,not-an-email\n"], "bad.csv", {
        type: "text/csv",
      }),
    );
    const badCsvRes = await request("/api/admin/members/import-csv", {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: badCsvForm,
    });
    assert.equal(badCsvRes.status, 422);
    const badCsvBody = await readJson(badCsvRes);
    assert.equal(badCsvBody.code, "CSV_VALIDATION_ERROR");
    assert.equal(badCsvBody.row_index, 2);

    const membersListRes = await request("/api/admin/members", {
      cookie: adminCookie,
    });
    const { items: allMembers } = await readJson(membersListRes);
    assert.equal(allMembers.length, 3);

    // 4. Create Cycle (DRAFT)
    const now = Date.now();
    const cycleRes = await request("/api/admin/cycles", {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: {
        title: "2026 상반기 피어리뷰",
        start_at: new Date(now - 3600_000).toISOString(),
        end_at: new Date(now + 7 * 86400_000).toISOString(),
      },
    });
    assert.equal(cycleRes.status, 201);
    const cycle = await readJson(cycleRes);
    assert.equal(cycle.status, "DRAFT");

    // 5. Add Questions (RATING, TEXT with PNG image, MULTIPLE_CHOICE with options)
    const q1Res = await request(`/api/admin/cycles/${cycle.id}/questions`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: {
        display_order: 1,
        question_type: "RATING",
        scale_type: "NUMERIC_5",
        category: "협업 역량",
        content: "동료와의 커뮤니케이션이 원활했나요?",
      },
    });
    assert.equal(q1Res.status, 201);
    const q1 = await readJson(q1Res);

    // Minimal valid PNG header bytes
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const q2Form = new FormData();
    q2Form.set("display_order", "2");
    q2Form.set("question_type", "TEXT");
    q2Form.set("category", "성장 피드백");
    q2Form.set("content", "동료의 강점과 개선점을 작성해 주세요.");
    q2Form.set(
      "image",
      new File([pngBytes], "guide.png", { type: "image/png" }),
    );

    const q2Res = await request(`/api/admin/cycles/${cycle.id}/questions`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: q2Form,
    });
    assert.equal(q2Res.status, 201);
    const q2 = await readJson(q2Res);
    assert.ok(q2.image_url);

    // Verify media streaming endpoint
    const mediaRes = await request(q2.image_url, { cookie: adminCookie });
    assert.equal(mediaRes.status, 200);
    assert.equal(mediaRes.headers.get("content-type"), "image/png");

    const q3Res = await request(`/api/admin/cycles/${cycle.id}/questions`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: {
        display_order: 3,
        question_type: "MULTIPLE_CHOICE",
        category: "키워드",
        content: "어울리는 키워드를 골라주세요.",
      },
    });
    assert.equal(q3Res.status, 201);
    const q3 = await readJson(q3Res);

    const opt1Res = await request(`/api/admin/questions/${q3.id}/options`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: { option_text: "책임감" },
    });
    assert.equal(opt1Res.status, 201);
    const opt1 = await readJson(opt1Res);

    const opt2Res = await request(`/api/admin/questions/${q3.id}/options`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: { option_text: "문제해결력" },
    });
    assert.equal(opt2Res.status, 201);
    const opt2 = await readJson(opt2Res);

    // Rapid duplicate option text on the same question returns 409 Conflict
    const dupOptRes = await request(`/api/admin/questions/${q3.id}/options`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: { option_text: "책임감" },
    });
    assert.equal(dupOptRes.status, 409);

    // >10MB image upload returns 413 Payload Too Large
    const tooLargeBytes = new Uint8Array(10 * 1024 * 1024 + 16);
    tooLargeBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const bigForm = new FormData();
    bigForm.set("display_order", "4");
    bigForm.set("question_type", "TEXT");
    bigForm.set("content", "대용량 이미지 테스트");
    bigForm.set(
      "image",
      new File([tooLargeBytes], "huge.png", { type: "image/png" }),
    );
    const bigImgRes = await request(`/api/admin/cycles/${cycle.id}/questions`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: bigForm,
    });
    assert.equal(bigImgRes.status, 413);

    // 6. Auto-match SAME_DEPARTMENT (김철수 <-> 이영희 in 백엔드)
    const autoMatchRes = await request(
      `/api/admin/cycles/${cycle.id}/assignments/auto-match`,
      {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
        body: { match_type: "SAME_DEPARTMENT" },
      },
    );
    assert.equal(autoMatchRes.status, 200);
    assert.deepEqual(await readJson(autoMatchRes), { created_count: 2 });

    // 7. Start Cycle (DRAFT -> ACTIVE) & flush PIN deliveries
    const startRes = await request(`/api/admin/cycles/${cycle.id}/start`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
    });
    assert.equal(startRes.status, 200);
    const startedCycle = await readJson(startRes);
    assert.equal(startedCycle.status, "ACTIVE");

    await flushQueues();

    const deliveriesAfterStart = await request(
      `/api/admin/cycles/${cycle.id}/deliveries?delivery_type=PIN_ISSUE`,
      { cookie: adminCookie },
    );
    const { items: pinDeliveries } = await readJson(deliveriesAfterStart);
    assert.equal(pinDeliveries.length, 2);
    assert.ok(pinDeliveries.every((d: any) => d.status === "SENT"));

    // Closing cycle with 0 submitted answers returns 409 STATE_CONFLICT
    const emptyCloseRes = await request(`/api/admin/cycles/${cycle.id}/close`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: { require_all_submitted: false },
    });
    assert.equal(emptyCloseRes.status, 409);

    // 8. Reviewer 1 logs in with 6-digit PIN
    const pinRow = db.rawDb
      .prepare("SELECT code FROM pins WHERE cycle_id = ? AND member_id = ?")
      .get(cycle.id, member1.id) as { code: string };
    assert.match(pinRow.code, /^[0-9]{6}$/);

    const revLoginRes = await request("/api/auth/reviewer/login", {
      method: "POST",
      body: { pin_code: pinRow.code },
    });
    assert.equal(revLoginRes.status, 200);
    const revCookie = extractCookie(revLoginRes);
    const revSession = await readJson(revLoginRes);
    assert.equal(revSession.role, "REVIEWER");
    const revCsrf = revSession.csrf_token;

    // Reviewer dashboard
    const dashRes = await request("/api/reviewer/dashboard", {
      cookie: revCookie,
    });
    assert.equal(dashRes.status, 200);
    const dashData = await readJson(dashRes);
    assert.equal(dashData.total_count, 1);
    const assignmentId = dashData.assignments[0].id;

    // Save draft
    const draftRes = await request(
      `/api/reviewer/assignments/${assignmentId}/draft`,
      {
        method: "PUT",
        cookie: revCookie,
        csrfToken: revCsrf,
        body: {
          answers: [{ question_id: q1.id, rating_value: 5 }],
        },
      },
    );
    assert.equal(draftRes.status, 200);

    // Final submit
    const submitRes = await request(
      `/api/reviewer/assignments/${assignmentId}/submit`,
      {
        method: "POST",
        cookie: revCookie,
        csrfToken: revCsrf,
        body: {
          answers: [
            { question_id: q1.id, rating_value: 5 },
            {
              question_id: q2.id,
              answer_text: "항상 적극적으로 소통하고 문제를 해결합니다.",
            },
            { question_id: q3.id, option_ids: [opt1.id, opt2.id] },
          ],
        },
      },
    );
    assert.equal(submitRes.status, 200);
    const submittedSummary = await readJson(submitRes);
    assert.equal(submittedSummary.is_submitted, true);

    // Re-submitting locked assignment returns 409
    const dupSubmitRes = await request(
      `/api/reviewer/assignments/${assignmentId}/submit`,
      {
        method: "POST",
        cookie: revCookie,
        csrfToken: revCsrf,
        body: {
          answers: [
            { question_id: q1.id, rating_value: 4 },
            { question_id: q2.id, answer_text: "수정 시도" },
            { question_id: q3.id, option_ids: [opt1.id] },
          ],
        },
      },
    );
    assert.equal(dupSubmitRes.status, 409);

    // 9. Admin sends reminder to remaining unsubmitted reviewer (multiple times allowed after SENT)
    const remindRes = await request(
      `/api/admin/cycles/${cycle.id}/reminders`,
      {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
      },
    );
    assert.equal(remindRes.status, 202);
    assert.deepEqual(await readJson(remindRes), { queued_count: 1 });
    await flushQueues();

    const remindSecondRes = await request(
      `/api/admin/cycles/${cycle.id}/reminders`,
      {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
      },
    );
    assert.equal(remindSecondRes.status, 202);
    assert.deepEqual(await readJson(remindSecondRes), { queued_count: 1 });
    await flushQueues();

    // 10. Close Cycle (ACTIVE -> COMPLETED) & generate HTML + PDF reports
    const closeRes = await request(`/api/admin/cycles/${cycle.id}/close`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: { require_all_submitted: false },
    });
    assert.equal(closeRes.status, 202);
    const closedCycle = await readJson(closeRes);
    assert.equal(closedCycle.status, "COMPLETED");

    await flushQueues();

    const reportsListRes = await request(
      `/api/admin/cycles/${cycle.id}/reports`,
      { cookie: adminCookie },
    );
    assert.equal(reportsListRes.status, 200);
    const { items: reports } = await readJson(reportsListRes);
    assert.equal(reports.length, 2);
    assert.ok(reports.every((r: any) => r.generation_status === "READY"));

    // Verify human-readable R2 keys in DB
    const r2Row = db.rawDb
      .prepare("SELECT html_r2_key, pdf_r2_key FROM reports WHERE id = ?")
      .get(reports[0].id) as { html_r2_key: string; pdf_r2_key: string };
    assert.ok(r2Row.html_r2_key.includes("cycle-1_2026_상반기_피어리뷰"));
    assert.ok(r2Row.pdf_r2_key.endsWith("_피어리뷰_리포트.pdf"));

    // Regenerate first report and verify revision bumps to 2
    const regenRes = await request(
      `/api/admin/reports/${reports[0].id}/regenerate`,
      {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
      },
    );
    assert.equal(regenRes.status, 202);
    const regenData = await readJson(regenRes);
    assert.equal(regenData.revision, 2);
    await flushQueues();

    // Preview HTML & PDF
    const htmlPreviewRes = await request(
      `/api/admin/reports/${reports[0].id}/html`,
      { cookie: adminCookie },
    );
    assert.equal(htmlPreviewRes.status, 200);
    const htmlText = await htmlPreviewRes.text();
    assert.ok(htmlText.includes("피어리뷰 리포트"));

    const pdfPreviewRes = await request(
      `/api/admin/reports/${reports[0].id}/pdf`,
      { cookie: adminCookie },
    );
    assert.equal(pdfPreviewRes.status, 200);
    assert.equal(pdfPreviewRes.headers.get("content-type"), "application/pdf");

    // 11. Publish Reports -> approves all & sends via Slack -> transitions cycle to CLOSED
    const publishRes = await request(
      `/api/admin/cycles/${cycle.id}/reports/publish`,
      {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
      },
    );
    assert.equal(publishRes.status, 202);
    assert.deepEqual(await readJson(publishRes), { queued_count: 2 });

    await flushQueues();

    const finalCycleRes = await request(`/api/admin/cycles/${cycle.id}`, {
      cookie: adminCookie,
    });
    const { cycle: finalCycle } = await readJson(finalCycleRes);
    assert.equal(finalCycle.status, "CLOSED");
  });

  it("enforces CSRF, role guards, rate limiting, and failed delivery retry", async () => {
    const { env, flushQueues, request } = createTestEnv();

    const setupRes = await request("/api/auth/setup", {
      method: "POST",
      body: {
        username: "root",
        email: "root@example.com",
        password: "password1234",
      },
    });
    const adminCookie = extractCookie(setupRes);
    const { csrf_token: adminCsrf } = await readJson(setupRes);

    // Missing CSRF token returns 403
    const noCsrfRes = await request("/api/admin/members", {
      method: "POST",
      cookie: adminCookie,
      body: { name: "홍길동", email: "hong@example.com" },
    });
    assert.equal(noCsrfRes.status, 403);

    // Rate limiting after 5 failed PIN login attempts
    for (let i = 0; i < 5; i++) {
      const failRes = await request("/api/auth/reviewer/login", {
        method: "POST",
        body: { pin_code: "999999" },
      });
      assert.equal(failRes.status, 401);
    }
    const lockedRes = await request("/api/auth/reviewer/login", {
      method: "POST",
      body: { pin_code: "999999" },
    });
    assert.equal(lockedRes.status, 429);

    // Add 2 members, create cycle, start cycle with failing Slack client, then retry-failed
    const m1 = await readJson(
      await request("/api/admin/members", {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
        body: { name: "유저A", email: "a@example.com" },
      }),
    );
    const m2 = await readJson(
      await request("/api/admin/members", {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
        body: { name: "유저B", email: "b@example.com" },
      }),
    );

    const now = Date.now();
    const cycle = await readJson(
      await request("/api/admin/cycles", {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
        body: {
          title: "재시도 검증 회차",
          start_at: new Date(now - 1000).toISOString(),
          end_at: new Date(now + 86400_000).toISOString(),
        },
      }),
    );

    await request(`/api/admin/cycles/${cycle.id}/questions`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: {
        display_order: 1,
        question_type: "RATING",
        content: "만족도",
      },
    });
    await request(`/api/admin/cycles/${cycle.id}/assignments`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
      body: { reviewer_id: m1.id, reviewee_id: m2.id },
    });

    let shouldFailSlack = true;
    env.SLACK_CLIENT = {
      async sendDmText() {
        if (shouldFailSlack) throw new Error("Slack temporary outage");
        return {};
      },
      async sendReportFiles() {
        if (shouldFailSlack) throw new Error("Slack temporary outage");
        return {};
      },
    };

    await request(`/api/admin/cycles/${cycle.id}/start`, {
      method: "POST",
      cookie: adminCookie,
      csrfToken: adminCsrf,
    });
    await flushQueues();

    const failedList = await readJson(
      await request(`/api/admin/cycles/${cycle.id}/deliveries?status=FAILED`, {
        cookie: adminCookie,
      }),
    );
    assert.equal(failedList.items.length, 1);

    // Recover Slack and retry failed deliveries
    shouldFailSlack = false;
    const retryRes = await request(
      `/api/admin/cycles/${cycle.id}/deliveries/retry-failed`,
      {
        method: "POST",
        cookie: adminCookie,
        csrfToken: adminCsrf,
      },
    );
    assert.equal(retryRes.status, 202);
    assert.deepEqual(await readJson(retryRes), { queued_count: 1 });
    await flushQueues();

    const sentList = await readJson(
      await request(`/api/admin/cycles/${cycle.id}/deliveries?status=SENT`, {
        cookie: adminCookie,
      }),
    );
    assert.equal(sentList.items.length, 1);
  });
});
