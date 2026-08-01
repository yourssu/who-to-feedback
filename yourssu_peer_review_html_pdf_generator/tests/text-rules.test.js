"use strict";

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "app", "public", "assets", "text-rules.js"),
  "utf8"
);
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const rules = sandbox.window.YourssuTextRules;

const reject = [
  ".",
  ":)",
  "ㅋㅋㅋㅋ",
  "👏👏",
  "없음",
  "없습니다.",
  "없는 것 같아요.",
  "없는 거 같아요.",
  "딱히 없음",
  "크게 없음",
  "별다른 내용 없음.",
  "함께 프로젝트를 진행한 경험이 부족하여 답변이 어렵습니다.",
  "강점이나 약점을 판단할 만큼의 업무 경험이 없음.",
  "아직 같이 협업하는 작업을 해보지 못해서 섣부르게 말씀드리기 어렵습니다."
];

const keep = [
  "회의에서 의견을 명확히 전달해 주셔서 좋았습니다.",
  "같이 프로젝트를 해보지는 않았지만 문서화를 더 잘하면 좋겠습니다.",
  "배우고 얻었는지도 모르겠어요ㅋㅋㅋㅋ",
  "아직 익숙하지 않지만 질문을 더 자주 해주면 협업에 도움이 될 것 같습니다."
];

const failures = [];
for (const value of reject) {
  if (!rules.isMeaningless(value, "improveTexts")) {
    failures.push(`REJECT expected: ${value}`);
  }
}
for (const value of keep) {
  if (rules.isMeaningless(value, "improveTexts")) {
    failures.push(`KEEP expected: ${value}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`text-rules: ${reject.length} rejected, ${keep.length} retained`);
