# Campo Figma-to-HTML AI 작업 회고

## 작업 목표

PeerFlow 피그마 디자인을 정적 HTML 프리뷰와 Django 템플릿에 반영하고, 이미 구현된 백엔드 기능은 화면의 실제 버튼·폼·URL과 연결하는 것을 목표로 작업했다.

## 수행한 작업

### 1. 피그마 화면 반영

- Reviewer 화면의 PC·모바일 로그인, 대시보드, 작성 개요, Rating·서술형·단일 선택·다중 선택, 완료 상태를 정적 프리뷰에 구성했다.
- Admin 화면의 PC·모바일 로그인, 대시보드, 팀원 관리, 질문지 제작, 피어리뷰 매칭, 진행 상태, 리포트 검토, Slack DM 전송 화면을 구성했다.
- Rating은 여러 값을 동시에 선택하지 못하도록 단일 선택 라디오 방식으로 유지했다.
- 기존 `360도 매칭` 관련 표현을 `피어리뷰 매칭` 또는 `리뷰 매칭`으로 정리했다.
- 피그마의 관리자 리포트·Slack DM·모바일 리포트 프레임을 다시 확인해 수신자 목록, 익명 미리보기, PDF, 승인 흐름을 보강했다.

### 2. 정적 프리뷰

- `core/static/preview.html`에 Reviewer 20개, Admin 17개 화면 상태를 선택할 수 있는 프리뷰를 유지·보완했다.
- 관리자 모바일 리포트에 수신자별 목록 → 익명 HTML 미리보기 → PDF → 최종 승인 흐름을 추가했다.
- 정적 프리뷰는 `http://127.0.0.1:4173/preview.html`로 제공되는 상태를 확인했다.

### 3. Reviewer 기능 연결

- 리뷰 작성 폼에 전체 답변 임시 저장을 연결했다.
  - `POST /review/<assignment_id>/save-draft/`
  - `review/form.html`과 `core/static/js/app.js`에서 `FormData`와 CSRF 토큰을 사용하도록 처리했다.
- 리뷰어 사이드바의 `내 대시보드` 이동 경로를 점검했다.

### 4. Admin 기능 연결

- 질문지 제작 화면에 `cycle.is_question_locked` 상태를 반영했다.
  - ACTIVE 이후 문항·선택지 추가/삭제를 비활성화하고 잠금 안내를 표시한다.
- 리포트 검토 화면에 아래 기능을 연결했다.
  - 개별 리포트 재생성
  - 관리자 메모 저장
  - 전체 레이아웃 검수
  - 샘플 3명 테스트 리포트 생성
  - PDF 미리보기·다운로드
  - 발송 대상 체크리스트
  - 커스텀 HTML 결과지 양식 업로드 및 적용 토글
- 대시보드에 회차·템플릿·문항의 버전 변경 이력 진입과 이력 목록을 추가했다.
- Slack DM 화면에 관리자 테스트 DM, 실패 DM 재발송, 발송 대상 체크리스트 진입을 추가했다.
- 질문 생성 모달에 관리자 역량 카테고리 입력을 추가하고, 질문 목록에도 카테고리를 표시했다.
- 팀원 관리 화면에 CSV 일괄 등록 폼을 추가했다.

## 주요 수정 파일

- `core/static/preview.html`
- `core/static/css/preview.css`
- `core/static/css/style.css`
- `core/static/js/app.js`
- `core/templates/review/form.html`
- `core/templates/review/dashboard.html`
- `core/templates/admin_custom/dashboard.html`
- `core/templates/admin_custom/questions.html`
- `core/templates/admin_custom/assignments.html`
- `core/templates/admin_custom/reports.html`
- `core/templates/admin_custom/send_message.html`
- `core/templates/admin_custom/members.html`
- `core/templates/base.html`
- `core/views/admin_views.py`
- `docs/TECHNICAL_SPECIFICATION.md`

## 어려웠던 점과 개선 방식

1. 피그마 변경이 여러 차례 누적되면서 일부 화면과 문구가 누락되기 쉬웠다.
   - 이후에는 피그마 화면 하나를 확인한 직후 해당 정적 HTML/Django 템플릿을 바로 대조하고 수정하는 방식으로 진행했다.

2. 정적 프리뷰와 실제 Django 템플릿이 별개여서 한쪽만 수정된 것처럼 보일 수 있었다.
   - 기능 화면은 정적 프리뷰와 실제 템플릿을 함께 확인·수정하는 원칙으로 보완했다.

3. 일부 피그마 화면은 UI만 필요하고, 일부는 백엔드 기능과 연결해야 했다.
   - 백엔드가 없는 `특정 회차 미작성자` DM 직접 발송은 실제 연결된 것처럼 처리하지 않고 준비 중 UI로 구분했다.
   - 기존 엔드포인트가 있는 기능은 실제 `<form>`과 URL로 연결했다.

4. 로컬 환경에 Django 패키지가 설치되어 있지 않아 실제 서버 렌더링과 POST 요청의 종단 간 테스트는 수행하지 못했다.
   - 대신 Python 컴파일, JavaScript 파싱, URL/템플릿 연결 확인, `git diff --check`, 정적 호스팅 응답 확인을 수행했다.

## 검증 결과

- `python3 -m compileall -q core` 통과
- 정적 프리뷰의 인라인 스크립트 파싱 통과
- `core/static/js/app.js` 문법 검사 통과
- `git diff --check` 통과
- 정적 프리뷰 HTTP 200 응답 확인

## 후속 권장 사항

- 의존성을 설치한 뒤 Django 서버를 실행해 로그인, 임시 저장, 리포트 생성, 파일 업로드, Slack DM 관련 POST 흐름을 실제로 테스트한다.
- 브라우저 스크린샷 비교로 피그마와 HTML의 픽셀 단위 간격·높이·반응형 동작을 최종 점검한다.
- 정적 프리뷰와 Django 템플릿에 공통 컴포넌트 또는 데이터 구조를 더 공유해 이후 피그마 수정 시 이중 반영 비용을 줄인다.
