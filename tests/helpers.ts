import { openDatabase } from "../src/db";
import { createApp } from "../src/app";
import { now, addAssignment, startCycle } from "../src/domain";
import type { PdfConverter } from "../src/pdf";

// A boundary stub for queue tests; real conversion is verified separately.
export const mockPdf: PdfConverter = {
  convert: async () =>
    new TextEncoder().encode("%PDF-1.7\nmock PDF conversion boundary\n%%EOF"),
};

export function fixture() {
  const repo = openDatabase(":memory:");
  for (const [name, email] of [
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
    ["Carol", "carol@example.com"],
  ])
    repo.run(
      "INSERT INTO members(name,email,slack_user_id,department,created_at) VALUES (?,?,?,?,?)",
      name,
      email,
      "U01234567",
      "Engineering",
      now(),
    );
  repo.run(
    "INSERT INTO cycles(title,end_at,created_at) VALUES (?,?,?)",
    "테스트 회차",
    new Date(Date.now() + 86400000).toISOString(),
    now(),
  );
  for (const [i, type] of [
    "RATING",
    "TEXT",
    "SINGLE_CHOICE",
    "MULTIPLE_CHOICE",
  ].entries()) {
    repo.run(
      'INSERT INTO questions(cycle_id,"order",question_type,content) VALUES (1,?,?,?)',
      i + 1,
      type,
      `${type} 문항`,
    );
  }
  for (const q of [3, 4])
    for (const o of ["소통", "책임감"])
      repo.run(
        'INSERT INTO options(question_id,"order",option_text) VALUES (?,?,?)',
        q,
        o === "소통" ? 1 : 2,
        o,
      );
  repo.transaction(() => {
    addAssignment(repo, 1, 1, 2);
    addAssignment(repo, 1, 2, 1);
    addAssignment(repo, 1, 3, 2);
  });
  return repo;
}
export const answers = () => ({
  q_1_rating: "4",
  q_2_text:
    "항상 구체적이고 유용한 피드백을 전달해 주셔서 협업에 큰 도움이 되었습니다.",
  q_3_single: "1",
  q_4_multi: ["3", "4"],
});
export class Client {
  cookies = new Map<string, string>();
  constructor(public app: ReturnType<typeof createApp>) {}
  async request(
    path: string,
    method = "GET",
    data?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const body = data ? JSON.stringify(data) : undefined;
    const response = await this.app.request(`http://localhost${path}`, {
      method,
      headers: {
        Cookie: cookie,
        ...(data
          ? {
              "Content-Type": "application/json",
              "X-CSRFToken": this.cookies.get("csrftoken") ?? "",
            }
          : {}),
        ...headers,
      },
      body,
    });
    for (const entry of response.headers.getSetCookie()) {
      const [pair] = entry.split(";");
      const equals = pair.indexOf("=");
      this.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  }
  async admin() {
    await this.request("/setup/");
    return this.request("/setup/", "POST", {
      username: "admin",
      email: "admin@example.com",
      password: "password123",
      password_confirm: "password123",
    });
  }
  async login(repo: ReturnType<typeof fixture>, member = 1) {
    startCycleIfNeeded(repo);
    await this.request("/login/");
    return this.request("/login/", "POST", {
      code: repo.one(
        "SELECT code FROM pins WHERE member_id=? AND cycle_id=1",
        member,
      )!.code,
    });
  }
}
function startCycleIfNeeded(repo: ReturnType<typeof fixture>) {
  if (repo.cycle(1).status === "DRAFT") startCycle(repo, 1);
}
