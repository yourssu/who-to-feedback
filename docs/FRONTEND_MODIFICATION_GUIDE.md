# 프론트엔드 연동 및 추가 조치 가이드 (Frontend Integration & Action Guide)

---

### 1) 전체 질문지 폼 통합 임시 저장 (`save_draft`) - `review/form.html` & `app.js`
- **목적**: 주관식, 척도점수, 객관식 단일/다중 선택 등 전체 폼 데이터를 한 번에 임시 저장.
- **백엔드 API**: `POST /review/<assignment_id>/save-draft/`
- **JS 예시**:
  ```javascript
  function saveFullDraft(assignmentId) {
      const form = document.querySelector('#reviewForm');
      const formData = new FormData(form);

      fetch(`/review/${assignmentId}/save-draft/`, {
          method: 'POST',
          headers: { 'X-CSRFToken': getCookie('csrftoken') },
          body: formData
      })
      .then(res => res.json())
      .then(data => {
          if (data.status === 'success') {
              alert(`[${data.saved_at}] 전체 폼 답변이 성공적으로 임시 저장되었습니다.`);
          }
      });
  }
  ```

---

### 2) 발송 전 관리자 테스트 DM 전송 버튼 - `admin_custom/send_message.html`
- **목적**: 전체 발송 전 관리자 본인의 Slack DM으로 사전 테스트 메시지 전송.
- **백엔드 API**: `POST /admin-panel/messages/send-test/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_send_test_dm' %}">
      {% csrf_token %}
      <button type="submit" class="btn btn-outline">🧪 관리자 테스트 DM 보내기</button>
  </form>
  ```

---

### 3) 실패한 Slack DM 1클릭 재발송 버튼 - `admin_custom/send_message.html`
- **목적**: 전송에 실패한 대상자만 모아서 1클릭 재발송 처리.
- **백엔드 API**: `POST /admin-panel/messages/retry-failed/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_retry_failed_messages' %}">
      {% csrf_token %}
      <button type="submit" class="btn btn-warning">⚠️ 실패한 DM 1클릭 재발송</button>
  </form>
  ```

---

### 4) 질문지 잠금 배너 및 버튼 비활성화 (`is_question_locked`) - `admin_custom/questions.html`
- **목적**: 피어리뷰 시작(`ACTIVE`) 후 문항 추가/삭제 버튼 비활성화 및 안내 배너 표시.
- **백엔드 속성**: `cycle.is_question_locked` (Boolean)
- **HTML 예시**:
  ```html
  {% if cycle.is_question_locked %}
      <div class="banner banner-warning">
          🔒 피어리뷰가 시작(ACTIVE)되어 질문 문항 및 선택지가 잠금 상태입니다.
      </div>
      <button class="btn btn-primary" disabled>+ 신규 질문 추가 (잠김)</button>
  {% else %}
      <button type="button" class="btn btn-primary" data-modal-open="questionModal">+ 문항 추가</button>
  {% endif %}
  ```

---

### 5) 1클릭 개별 리포트 재생성 및 실패 재시도 - `admin_custom/reports.html`
- **목적**: 특정 대상자(`Glen.pdf`, `Alex.pdf`) 리포트만 개별 재생성 또는 생성 실패 건 1클릭 재시도.
- **백엔드 API**: `POST /admin-panel/reports/<report_id>/regenerate/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_regenerate_report' report_id=r.report_id %}">
      {% csrf_token %}
      <button type="submit" class="btn btn-sm btn-outline">🔄 {{ r.reviewee.name }} 리포트만 재생성</button>
  </form>
  ```

---

### 6) 관리자 코멘트 / 수정 메모 저장 폼 - `admin_custom/reports.html`
- **목적**: 검토 중 특정 사람 리포트에 "키워드 확인 필요" 등 코멘트 메모 입력 및 DB 저장.
- **백엔드 API**: `POST /admin-panel/reports/<report_id>/memo/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_save_report_memo' report_id=r.report_id %}" class="inline-form">
      {% csrf_token %}
      <input type="text" class="form-control" name="admin_memo" value="{{ r.admin_memo }}" placeholder="관리자 수정 메모 입력...">
      <button type="submit" class="btn btn-small">💾 메모 저장</button>
  </form>
  ```

---

### 7) 자동 레이아웃 검수 일괄 실행 버튼 - `admin_custom/reports.html`
- **목적**: 300자/500자 이상 긴 글 overflow 및 태그 넘침 자동 검사 실행 및 결과 표시.
- **백엔드 API**: `POST /admin-panel/cycles/<cycle_id>/layout-check/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_run_layout_check' cycle_id=cycle.id %}">
      {% csrf_token %}
      <button type="submit" class="btn btn-secondary">🔍 전체 자동 레이아웃 검수 실행</button>
  </form>

  {% if not r.layout_check_passed %}
      <div class="alert alert-warning">⚠️ 레이아웃 이슈: {{ r.layout_issue_notes }}</div>
  {% endif %}
  ```

---

### 8) 샘플 3명 미리보기 테스트 리포트 생성 버튼 - `admin_custom/reports.html`
- **목적**: 기존 헤더의 `disabled` 버튼(`샘플 생성 기능 준비 중`)을 실제 샘플 리포트 생성 폼으로 연동.
- **백엔드 API**: `POST /admin-panel/cycles/<cycle_id>/sample-reports/`
- **HTML 예시**:
  ```html
  <form method="POST" action="{% url 'admin_generate_sample_reports' cycle_id=cycle.id %}">
      {% csrf_token %}
      <button type="submit" class="btn btn-outline">🧪 샘플 3명 테스트 리포트 생성</button>
  </form>
  ```

---

### 9) 발송 대상 체크리스트 뷰 - `admin_custom/reports.html` / `send_message.html`
- **목적**: Slack 발송 전 이름/팀/Slack ID/PDF/승인 여부 5가지 지표 표 집계.
- **백엔드 API**: `GET /admin-panel/cycles/<cycle_id>/checklist/`
- **HTML 예시**:
  ```html
  <a href="{% url 'admin_delivery_checklist' cycle_id=cycle.id %}" class="btn btn-tonal">📋 발송 대상 체크리스트 보기</a>
  ```

---

### 10) 회차 및 템플릿/문항 버전 변경 이력 뷰 - `admin_custom/dashboard.html`
- **목적**: 버전(`v1` ➔ `v2`) 변경 이력 타임라인 조회.
- **백엔드 API**: `GET /admin-panel/cycles/<cycle_id>/history/`
- **HTML 예시**:
  ```html
  <a href="{% url 'admin_cycle_history' cycle_id=item.cycle.id %}" class="btn btn-ghost btn-small">📜 버전 변경 이력</a>
  ```

---

### 11) 커스텀 HTML 리포트 템플릿 업로드 & 토글 - `admin_custom/reports.html`
- **목적**: 관리자가 커스텀 HTML 결과지 양식 파일(.html)을 업로드하고, 커스텀 템플릿 ↔ 기본 템플릿 적용 여부를 토글.
- **백엔드 API**:
  - `POST /admin-panel/cycles/<cycle_id>/upload-template/` (`admin_upload_custom_template`)
  - `POST /admin-panel/cycles/<cycle_id>/toggle-template/` (`admin_toggle_custom_template`)
- **HTML 구현 예시**:
  ```html
  <div class="card p-4 my-3">
      <h4>🎨 커스텀 HTML 결과지 템플릿 관리</h4>
      <p class="text-muted">디자인된 HTML 양식을 업로드하면 멤버별 PDF 생성 시 적용됩니다.</p>
      
      <!-- HTML 파일 업로드 폼 -->
      <form method="POST" action="{% url 'admin_upload_custom_template' cycle_id=cycle.id %}" enctype="multipart/form-data" class="d-flex gap-2 my-2">
          {% csrf_token %}
          <input type="file" name="html_file" accept=".html, .htm" class="form-control" required>
          <button type="submit" class="btn btn-primary">📤 양식 업로드 및 적용</button>
      </form>

      <!-- 템플릿 사용 여부 토글 버튼 -->
      {% if cycle.custom_html_file %}
          <div class="mt-2">
              <span>현재 업로드된 파일: <code>{{ cycle.custom_html_file.name }}</code></span>
              <form method="POST" action="{% url 'admin_toggle_custom_template' cycle_id=cycle.id %}" class="d-inline ms-2">
                  {% csrf_token %}
                  {% if cycle.use_custom_template %}
                      <button type="submit" class="btn btn-warning btn-sm">커스텀 템플릿 적용 해제</button>
                  {% else %}
                      <button type="submit" class="btn btn-success btn-sm">커스텀 템플릿 적용하기</button>
                  {% endif %}
              </form>
          </div>
      {% endif %}
  </div>
  ```

---

### 12) 질문지 제작 모달 내 관리자 카테고리 필드 추가 - `admin_custom/questions.html`
- **목적**: 5점 척도/주관식 문항 생성 시 관리자 전용 역량 카테고리 (예: Active Ownership, Deep Immersion, Mutual Growth) 지정.
- **백엔드 API**: `POST /admin-panel/cycles/<cycle_id>/questions/add/` (파라미터: `category`)
- **HTML 구현 예시**:
  ```html
  <div class="form-group my-2">
      <label>관리자 역량 카테고리</label>
      <input type="text" name="category" class="form-control" placeholder="예: Active Ownership, 소통역량" value="기본 역량">
      <small class="form-text text-muted">방사형/원/막대 그래프 생성을 위해 관리자가 문항별로 지정하는 역량 구분입니다.</small>
  </div>
  ```


