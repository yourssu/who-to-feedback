#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Node v22.22.2 및 IPv4 우선 DNS 해석 설정 (서버 IPv6 타임아웃 방지)
if [ -d "/home/yoon-server/.nvm/versions/node/v22.22.2/bin" ]; then
  export PATH="/home/yoon-server/.nvm/versions/node/v22.22.2/bin:$PATH"
fi
export NODE_OPTIONS="${NODE_OPTIONS:---dns-result-order=ipv4first}"

echo "============================================================"
echo " PeerFlow v2 — Cloudflare 테스트 배포 스크립트 (*.workers.dev)"
echo "============================================================"

# 1. .env.cloudflare 로드
if [ -f "$ROOT_DIR/.env.cloudflare" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.cloudflare"
  set +a
fi

# Placeholder 값인 경우 환경 변수에서 해제 (wrangler login 세션과 충돌 방지)
if [[ "${CLOUDFLARE_ACCOUNT_ID:-}" == "YOUR_CLOUDFLARE_ACCOUNT_ID_HERE" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  unset CLOUDFLARE_ACCOUNT_ID || true
fi
if [[ "${CLOUDFLARE_API_TOKEN:-}" == "YOUR_CLOUDFLARE_API_TOKEN_HERE" || -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  unset CLOUDFLARE_API_TOKEN || true
fi

# 2. Cloudflare 인증 상태 확인
echo "[1/5] Cloudflare 인증 상태 확인 중..."
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo ""
  echo "❌ Cloudflare 인증 정보가 설정되지 않았거나 유효하지 않습니다."
  echo "아래 두 가지 방법 중 하나로 인증 정보를 입력한 뒤 다시 실행해 주세요:"
  echo ""
  echo "  방법 A) .env.cloudflare 파일에 아래 두 값 입력:"
  echo "          CLOUDFLARE_ACCOUNT_ID=\"본인의_Account_ID\""
  echo "          CLOUDFLARE_API_TOKEN=\"본인의_API_Token\""
  echo ""
  echo "  방법 B) 대화형 OAuth 로그인 실행:"
  echo "          npx wrangler login"
  echo ""
  exit 1
fi
echo "  ✔ Cloudflare 인증 확인 완료"

# 3. D1 데이터베이스(peerflow-db) 확인 및 생성
echo "[2/5] Cloudflare D1 데이터베이스(peerflow-db) 확인 중..."
D1_LIST_JSON="$(npx wrangler d1 list --json 2>/dev/null || echo "[]")"
DB_ID="$(node -e '
  const list = JSON.parse(process.argv[1] || "[]");
  const found = list.find((d) => d.name === "peerflow-db");
  if (found && found.uuid) process.stdout.write(found.uuid);
' "$D1_LIST_JSON")"

if [ -z "$DB_ID" ]; then
  echo "  ➜ peerflow-db가 존재하지 않아 새로 생성합니다..."
  npx wrangler d1 create peerflow-db >/dev/null
  D1_LIST_JSON="$(npx wrangler d1 list --json)"
  DB_ID="$(node -e '
    const list = JSON.parse(process.argv[1] || "[]");
    const found = list.find((d) => d.name === "peerflow-db");
    if (found && found.uuid) process.stdout.write(found.uuid);
  ' "$D1_LIST_JSON")"
fi

if [ -z "$DB_ID" ]; then
  echo "❌ D1 데이터베이스 UUID를 조회하지 못했습니다. API 토큰의 D1:Edit 권한을 확인해 주세요."
  exit 1
fi
echo "  ✔ D1 database_id: $DB_ID"

# wrangler.jsonc 내 database_id 및 vars 업데이트
node -e '
  const fs = require("fs");
  const file = "wrangler.jsonc";
  let text = fs.readFileSync(file, "utf8");
  const dbId = process.argv[1];
  const mockSlack = process.argv[2] || "true";
  const siteUrl = process.argv[3] || "";
  text = text.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${dbId}"`);
  text = text.replace(/"MOCK_SLACK_MODE":\s*"[^"]*"/, `"MOCK_SLACK_MODE": "${mockSlack}"`);
  if (siteUrl && !text.includes("\"SITE_URL\"")) {
    text = text.replace(
      `"MOCK_SLACK_MODE": "${mockSlack}"`,
      `"MOCK_SLACK_MODE": "${mockSlack}",\n    "SITE_URL": "${siteUrl}"`
    );
  }
  fs.writeFileSync(file, text, "utf8");
' "$DB_ID" "${MOCK_SLACK_MODE:-true}" "${SITE_URL:-}"

# 4. 원격 D1 마이그레이션 적용
if [[ "${1:-}" == "--reset-db" ]]; then
  echo "[3/5] 원격 D1 데이터베이스 초기화(--reset-db) 및 스키마 재적용 중..."
  npx wrangler d1 execute peerflow-db --remote --command "
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS answer_options;
    DROP TABLE IF EXISTS answers;
    DROP TABLE IF EXISTS deliveries;
    DROP TABLE IF EXISTS reports;
    DROP TABLE IF EXISTS pins;
    DROP TABLE IF EXISTS assignments;
    DROP TABLE IF EXISTS question_options;
    DROP TABLE IF EXISTS questions;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS login_attempts;
    DROP TABLE IF EXISTS cycles;
    DROP TABLE IF EXISTS members;
    DROP TABLE IF EXISTS admins;
    DROP TABLE IF EXISTS _r2_fallback_objects;
    DROP TABLE IF EXISTS d1_migrations;
    PRAGMA foreign_keys = ON;
  "
else
  echo "[3/5] D1 스키마 마이그레이션 적용 중 (migrations/0001_initial.sql)..."
fi
npx wrangler d1 migrations apply peerflow-db --remote
echo "  ✔ D1 스키마 마이그레이션 완료"

# 5. R2 버킷 및 Queues 리소스 확인 (계정 플랜에 따라 자동 감지)
echo "[4/5] R2 버킷 및 Queues 리소스 준비 중..."
HAS_R2="true"
if npx wrangler r2 bucket list >/dev/null 2>&1; then
  npx wrangler r2 bucket create peerflow-files >/dev/null 2>&1 || true
  echo "  ✔ R2 버킷(peerflow-files) 준비 완료"
else
  HAS_R2="false"
  echo "  ℹ 계정에 R2가 비활성화되어 있어 D1 내장 스토리지 폴백 모드로 배포합니다."
fi

HAS_QUEUES="true"
if npx wrangler queues list >/dev/null 2>&1; then
  npx wrangler queues create peerflow-report-queue >/dev/null 2>&1 || true
  npx wrangler queues create peerflow-delivery-queue >/dev/null 2>&1 || true
  echo "  ✔ Queues(peerflow-report-queue, peerflow-delivery-queue) 준비 완료"
else
  HAS_QUEUES="false"
  echo "  ℹ 계정이 Workers Free 플랜(Queues 미지원)이어서 인라인 비동기 실행 모드로 배포합니다."
fi

# 배포용 임시 설정 생성 (R2/Queues/Browser 미지원 플랜에서도 즉시 배포되도록 자동 조정)
DEPLOY_CONFIG="$ROOT_DIR/.wrangler/deploy.wrangler.json"
mkdir -p "$ROOT_DIR/.wrangler"

build_deploy_config() {
  local use_r2="$1"
  local use_queues="$2"
  local use_browser="$3"
  node -e '
    const fs = require("fs");
    const raw = fs.readFileSync("wrangler.jsonc", "utf8");
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const cfg = JSON.parse(stripped);
    cfg.assets.directory = "../web";
    cfg.main = "../src/index.ts";
    cfg.d1_databases[0].migrations_dir = "../migrations";
    if (process.argv[1] !== "true") delete cfg.r2_buckets;
    if (process.argv[2] !== "true") delete cfg.queues;
    if (process.argv[3] !== "true") delete cfg.browser;
    fs.writeFileSync(process.argv[4], JSON.stringify(cfg, null, 2), "utf8");
  ' "$use_r2" "$use_queues" "$use_browser" "$DEPLOY_CONFIG"
}

build_deploy_config "$HAS_R2" "$HAS_QUEUES" "true"

# 6. Worker + Pages Assets 배포 (*.workers.dev)
echo "[5/5] Cloudflare Workers (*.workers.dev) 배포 중..."
if ! npx wrangler deploy --config "$DEPLOY_CONFIG"; then
  echo "  ℹ Browser Rendering 바인딩 제외 후 재배포를 시도합니다..."
  build_deploy_config "$HAS_R2" "$HAS_QUEUES" "false"
  npx wrangler deploy --config "$DEPLOY_CONFIG"
fi

# 7. 실제 SLACK_BOT_TOKEN 시크릿 등록 (입력된 경우에만)
if [[ -n "${SLACK_BOT_TOKEN:-}" && "${SLACK_BOT_TOKEN}" != "xoxb-YOUR-SLACK-BOT-TOKEN-HERE" ]]; then
  echo "  ➜ SLACK_BOT_TOKEN 시크릿을 등록합니다..."
  printf "%s" "$SLACK_BOT_TOKEN" | npx wrangler secret put SLACK_BOT_TOKEN --config "$DEPLOY_CONFIG"
fi

rm -f "$DEPLOY_CONFIG"

echo ""
echo "============================================================"
echo " ✅ 배포가 완료되었습니다!"
echo " 위에 출력된 https://peerflow.<서브도메인>.workers.dev 주소로 접속하여"
echo " 최초 관리자 계정 설정(/api/auth/setup 화면)부터 바로 테스트할 수 있습니다."
echo "============================================================"
