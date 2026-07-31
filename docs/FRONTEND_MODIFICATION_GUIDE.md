# 프론트엔드 연동 및 변경 가이드 (Frontend Modification Guide)

본 문서는 백엔드 시스템에 구축된 **피어리뷰 전체 폼 임시 저장(Draft Save), 권한, 질문지 잠금, 익명성, 실패 재시도, Slack DM 전송 기록, 테스트 DM** 등 핵심 기능을 프론트엔드 UI/템플릿에 연동하기 위한 안내서입니다.

---

## 1. 전체 질문지 폼 통합 임시 저장 (Full-Form Draft Save) API 연동

개별 문항 단위가 아닌 **전체 질문지의 모든 답변(RATING, TEXT, SINGLE_CHOICE, MULTIPLE_CHOICE)**을 한 번에 임시 저장합니다.

- **연동 엔드포인트**: `POST /review/<assignment_id>/save-draft/`
- **Content-Type**: `application/json` 또는 `multipart/form-data`
- **전송 Payload 구조 (전체 폼 데이터 예시)**:
  ```json
  {
      "q_1_rating": 4,
      "q_2_text": "현재 작성 중인 주관식 피드백입니다.",
      "q_3_single": 12,
      "q_4_multi": [101, 103, 105]
  }
  ```
- **JavaScript 폼 통합 임시 저장 구현 예시**:
  ```javascript
  function saveFullDraft(assignmentId) {
      const form = document.querySelector('#reviewForm');
      const formData = new FormData(form);

      fetch(`/review/${assignmentId}/save-draft/`, {
          method: 'POST',
          headers: {
              'X-CSRFToken': getCookie('csrftoken')
          },
          body: formData
      })
      .then(res => res.json())
      .then(data => {
          if (data.status === 'success') {
              alert(`[${data.saved_at}] 전체 답변이 임시 저장되었습니다.`);
          }
      });
  }
  ```

---

## 2. 관리자 기능 연동 조치

### 1) 발송 전 테스트 DM 전송 버튼 (`a-messages`)
- **연동 엔드포인트**: `POST /admin-panel/messages/send-test/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_send_test_dm' %}">
      {% csrf_token %}
      <button type="submit" class="btn">🧪 관리자 테스트 DM 보내기</button>
  </form>
  ```

### 2) 실패한 Slack DM 1클릭 재발송 버튼 (`a-messages`)
- **연동 엔드포인트**: `POST /admin-panel/messages/retry-failed/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_retry_failed_messages' %}">
      {% csrf_token %}
      <button type="submit" class="btn btn-warning">⚠️ 실패한 N명만 재발송</button>
  </form>
  ```

### 3) 질문지 잠금 상태 (`is_question_locked`) 처리 (`a-questions`)
- **백엔드 속성**: `cycle.is_question_locked`
- **HTML 예시**:
  ```html
  {% if cycle.is_question_locked %}
      <div class="banner banner-warning">
          🔒 피어리뷰가 시작(ACTIVE)되어 질문 문항 및 선택지가 잠금 상태입니다.
      </div>
      <button class="btn btn-primary" disabled>+ 신규 질문 추가 (잠김)</button>
  {% endif %}
  ```

### 4) 리포트 생성 실패 1클릭 재시도 버튼 (`a-reports`)
- **연동 엔드포인트**: `POST /admin-panel/reports/<report_id>/regenerate/`
- **HTML 예시**:
  ```html
  {% if r.validation_status == '생성 실패' %}
      <form method="POST" action="{% url 'admin_regenerate_report' report_id=r.report_id %}">
          {% csrf_token %}
          <button type="submit" class="btn btn-primary">🔄 {{ r.reviewee.name }} 리포트 재시도</button>
      </form>
  {% endif %}
  ```
