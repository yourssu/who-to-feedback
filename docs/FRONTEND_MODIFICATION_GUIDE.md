# 프론트엔드 변경 가이드

웹사이트는 `core/templates`의 Nunjucks 템플릿과 `core/static/css/style.css`, `core/static/js/app.js`로 구성됩니다. 기존 클래스·DOM·폰트·반응형·라이트/다크 테마를 유지합니다. Figma를 기준으로 수정할 때는 저장소의 `agents.md`에 따라 화면별 최신 컨텍스트와 스크린샷을 확인하고 정적 미리보기·실제 화면을 함께 대조합니다.

URL은 `src/templates.ts`에 이름으로 등록하고 `{{ url('admin_status') }}`처럼 호출합니다. 변경 요청 폼에는 `<input type="hidden" name="csrfmiddlewaretoken" value="{{ csrf_token }}">`를 포함합니다. AJAX는 `X-CSRFToken`으로 전달합니다. Django 태그는 사용하지 않습니다.

리뷰 폼은 문항 4종의 전체 값을 `POST /review/:assignment_id/save-draft/`로 임시 저장합니다. 응답은 `status`, `message`, `saved_at`을 포함합니다. 제출과 마감 이후 잠금은 서버에서 재검증하므로 버튼 비활성화만으로 권한을 판단하지 않습니다.

관리자 Slack 메시지 화면은 `FAILED`와 `UNKNOWN`을 구분합니다. 재전송 버튼은 실패가 확인된 작업 수만 표시하고, 결과 불명확 작업은 수신 여부 확인 액션을 제공합니다.

`bun run test:ui`는 메모리 DB·가상 HTTP에서 실제 템플릿과 정적 자산을 사용합니다. 데스크톱·모바일, 라이트·다크, 기본·빈 화면·오류·잠금·발송 실패·PDF 실패를 캡처하고 가로 넘침과 브라우저 오류를 검사합니다. 픽셀 비교나 최신 Figma 검수를 대신하지 않습니다.

PDF 디자인은 웹 앱 화면과 독립적으로 `core/templates/reports/peer_review_report.html`, `src/reporting/print-style.ts`에서 변경합니다. PDF 생성 후 `bun run test:pdf`와 페이지 렌더링 검수를 함께 수행합니다.
