# Slack 연동 가이드 (Slack Integration Guide)

본 문서는 피어리뷰 시스템을 실제 Slack Workspace 및 Bot Token과 연동하기 위한 세부 절차 안내서입니다.

---

## 1. Slack App 생성 및 설정 절차

### 1단계: Slack App 생성
1. [Slack API 개발자 콘솔](https://api.slack.com/apps)에 접속합니다.
2. **`Create New App`** ➔ **`From scratch`**를 선택합니다.
3. App Name(예: `피어리뷰 자동화 봇`)을 입력하고 연동 대상 Workspace를 지정합니다.

### 2단계: 필수 Bot Token Scopes 4가지 추가
1. 좌측 메뉴에서 **`OAuth & Permissions`**를 선택합니다.
2. **`Scopes`** ➔ **`Bot Token Scopes`** 항목에 아래 4개 권한을 추가합니다:
   - `chat:write`: 사용자에게 PIN 코드 및 알림 메시지 DM 전송
   - `files:write`: 피어리뷰 결과 PDF 리포트 파일 업로드 (`files.upload_v2`)
   - `im:write`: 사용자 간 1:1 Direct Message 채널 생성
   - `users:read`: Slack 사용자 정보 및 Member ID 조회

### 3단계: Workspace 설치 및 Bot Token 발급
1. `OAuth & Permissions` 상단의 **`Install to Workspace`** 버튼을 누릅니다.
2. 접근 권한을 승인한 후 발급된 **`Bot User OAuth Token` (`xoxb-`로 시작)**을 복사합니다.

---

## 2. `.env` 환경 변수 설정

프로젝트 루트 디렉터리의 `.env` 파일(또는 `.env.example` 복사본)에 발급받은 토큰 및 모드 옵션을 설정합니다.

```ini
# .env 파일 예시
DJANGO_SECRET_KEY=your-django-secret-key
DEBUG=True

# Slack API 설정
SLACK_BOT_TOKEN=xoxb-1234567890-1234567890123-xxxxxx
MOCK_SLACK_MODE=False
```

- `MOCK_SLACK_MODE=True`: 실제 Slack DM을 보내지 않고 서버 콘솔/로그에 PIN 코드 및 메시지를 출력합니다.
- `MOCK_SLACK_MODE=False`: 실제 Slack API를 호출하여 사용자에게 DM 메시지와 PDF 파일이 전송됩니다.

---

## 3. 사용자 Slack Member ID 등록

사용자에게 DM 및 PDF를 전달하기 위해 Slack Member ID(`U12345678` 형태)가 필요합니다.

1. Slack 앱에서 팀원의 프로필을 클릭합니다.
2. 프로필 팝업의 **`더보기 (...)`** ➔ **`멤버 ID 복사`**를 선택합니다.
3. 관리자 웹 UI (**`/admin-panel/members/`**)에서 팀원 등록/수정 시 해당 멤버 ID를 입력합니다.

---

## 4. 연동 테스트

1. 관리자 웹 UI의 **`Slack DM 메시지 전송` (`/admin-panel/messages/send/`)** 페이지로 이동합니다.
2. 수신 대상을 지정하고 테스트 메시지를 작성하여 전송을 실행합니다.
3. 대상 사용자의 Slack 앱으로 메시지가 수신되는지 확인합니다.
