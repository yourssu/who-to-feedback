# Slack 연동

Slack 앱을 만들고 Bot Token을 발급받아 `SLACK_BOT_TOKEN`에 설정합니다. 실제 전송에는 `MOCK_SLACK_MODE=false`가 필요합니다. 개발 기본값은 `true`입니다.

## 구현에서 사용하는 메서드와 권한

| 기능 | SDK 메서드 | Bot 권한 |
|---|---|---|
| 이메일로 Slack 사용자 찾기 | `users.lookupByEmail` | `users:read.email` |
| DM 채널 열기 | `conversations.open` | `im:write` |
| PIN·리마인더·운영 메시지 | `chat.postMessage` | `chat:write` |
| HTML·PDF 함께 업로드 | `filesUploadV2` | `files:write` |

이메일 조회 권한은 [Slack 공식 메서드 문서](https://docs.slack.dev/reference/methods/users.lookupByEmail/)를 기준으로 확인했습니다. 권한 변경 후 워크스페이스에 앱을 다시 설치해야 합니다. 팀원에 유효한 Slack User ID가 있으면 이메일 조회를 생략합니다.

팀원의 Slack 프로필에서 멤버 ID를 복사해 관리자 팀원 등록 시 입력합니다. 관리자 테스트 DM은 관리자 이메일과 같은 팀원의 Slack 정보를 사용합니다.

## 검증 순서

1. 테스트 워크스페이스의 관리자·팀원 정보를 등록합니다.
2. 관리자 화면에서 ‘관리자 테스트 DM’을 실행합니다.
3. 작은 테스트 회차를 시작하고 PIN 수신·로그인을 확인합니다.
4. 리뷰 제출·관리자 마감·HTML/PDF 검토를 완료합니다.
5. ‘검토 완료 및 발송’을 실행하고 같은 DM에서 두 파일을 다운로드할 수 있는지 확인합니다.

실제 메시지를 보내는 검증은 대상과 발송 범위를 정한 후 실행합니다. 로컬 업무·UI 테스트는 가상 발송기를 사용하므로 실제 Slack 전달을 입증하지 않습니다.

## 오류와 재전송

명시적 API 실패는 `FAILED`, 네트워크 단절 또는 전송 중 종료로 결과가 불명확하면 `UNKNOWN`입니다. rate limit은 지정된 시간 이후 제한된 횟수로 재시도합니다. SDK 자체의 자동 재시도는 끄고 큐에서 관리합니다.

‘실패한 DM 재발송’은 `FAILED`만 처리합니다. `UNKNOWN`은 관리자 화면에서 수신 여부를 확인하고 완료 또는 미수신 재전송으로 처리합니다. 보고서는 승인된 생성물 버전·해시와 작업이 일치해야 전송됩니다.
