# 04. OpenAPI 3.1.0 REST API 명세

본 문서는 **PeerFlow v2** 백엔드 API의 설계 표준과 전체 엔드포인트 구성을 요약합니다. 기계 가독형 전체 OpenAPI 3.1.0 표준 명세 원본은 프로젝트 루트의 **[`openapi.yaml`](../openapi.yaml)**에 정의되어 있습니다.

---

## 1. OpenAPI 3.1.0 설계 표준

1. **엄격한 OpenAPI 3.1.0 규격 준수**:
   * `openapi: 3.1.0` 및 JSON Schema Draft 2020-12 문법(`type: [string, "null"]` 등)을 준수합니다.
   * 모든 요청/응답 객체에 `additionalProperties: false` 및 명확한 길이·범위·패턴 제약을 부여했습니다.
2. **소문자 단일 단어 태그(Tag) 규칙**:
   * 하이픈(`-`)이나 대문자 없이 소문자 한 단어로 된 10개의 태그(`system`, `auth`, `members`, `cycles`, `questions`, `assignments`, `reports`, `deliveries`, `reviewer`, `media`)로 분류했습니다.
3. **명사구 단답형 요약(`summary`, `description`)**:
   * 모든 오퍼레이션의 `summary`와 `description`을 한눈에 파악할 수 있는 간결한 명사구 단답형으로 통일했습니다.
4. **인증 및 CSRF 보호**:
   * 세션 쿠키(`peerflow_session`, `HttpOnly`, `SameSite=Lax`)와 커스텀 헤더(`X-CSRF-Token`)를 조합하여 인증 및 CSRF 검증을 수행합니다.
   * 관리자 전용 엔드포인트는 `/api/admin/*`, 리뷰어 전용 엔드포인트는 `/api/reviewer/*` 경로 프리픽스로 명확히 구분됩니다.

---

## 2. 태그별 전체 엔드포인트 목록 (총 28개 오퍼레이션)

### 2.1 `system` — 시스템 상태 확인
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | `getHealth` | 서버 및 D1 상태 확인 | Public |

### 2.2 `auth` — 설정·로그인·세션 관리
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/auth/setup-status` | `getSetupStatus` | 초기 관리자 설정 필요 여부 조회 | Public |
| `POST` | `/api/auth/setup` | `setupInitialAdmin` | 최초 관리자 계정 생성 | Public (최초 1회) |
| `POST` | `/api/auth/admin/login` | `loginAdmin` | 관리자 로그인 | Public |
| `POST` | `/api/auth/reviewer/login` | `loginReviewer` | 리뷰어 6자리 PIN 로그인 | Public |
| `POST` | `/api/auth/logout` | `logout` | 로그아웃 및 세션 폐기 | Authenticated |
| `GET` | `/api/auth/me` | `getCurrentSession` | 현재 로그인 세션 조회 | Authenticated |

### 2.3 `members` — 팀원 등록·조회·삭제 및 CSV 업로드
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/members` | `listMembers` | 전체 팀원 목록 조회 | Admin |
| `POST` | `/api/admin/members` | `createMember` | 팀원 단건 등록 | Admin |
| `POST` | `/api/admin/members/import-csv` | `importMembersCsv` | 팀원 CSV 일괄 업로드 | Admin |
| `DELETE` | `/api/admin/members/{memberId}` | `deleteMember` | 팀원 삭제 | Admin |

### 2.4 `cycles` — 피어리뷰 회차 및 진행 상태 관리
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/cycles` | `listCycles` | 전체 회차 목록 조회 | Admin |
| `POST` | `/api/admin/cycles` | `createCycle` | 신규 회차 생성 | Admin |
| `GET` | `/api/admin/cycles/{cycleId}` | `getCycleDetail` | 회차 상세 및 제출 현황 조회 | Admin |
| `PATCH` | `/api/admin/cycles/{cycleId}` | `updateCycle` | 회차 기본 정보 수정 | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/start` | `startCycle` | 회차 시작 및 PIN 발송 요청 | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/close` | `closeCycle` | 회차 마감 및 리포트 생성 요청 (최소 1개 답변 제출 필수) | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/reminders` | `sendCycleReminders` | 미제출 리뷰어 리마인더 발송 요청 | Admin |

### 2.5 `questions` — 설문 문항 및 객관식 선택지 관리
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/cycles/{cycleId}/questions` | `listCycleQuestions` | 회차별 설문 문항 및 선택지 목록 조회 | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/questions` | `createQuestion` | 설문 문항 추가 (참고 이미지 최대 10MB 업로드 포함) | Admin |
| `DELETE` | `/api/admin/questions/{questionId}` | `deleteQuestion` | 설문 문항 삭제 | Admin |
| `POST` | `/api/admin/questions/{questionId}/options` | `createQuestionOption` | 객관식 선택지 추가 (동일 문항 내 중복 선택지 차단) | Admin |
| `DELETE` | `/api/admin/options/{optionId}` | `deleteQuestionOption` | 객관식 선택지 삭제 | Admin |

### 2.6 `assignments` — 리뷰어·피평가자 매칭 관리
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/cycles/{cycleId}/assignments` | `listCycleAssignments` | 회차별 리뷰 매칭 목록 조회 | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/assignments` | `createAssignment` | 개별 리뷰 매칭 추가 | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/assignments/auto-match` | `autoMatchAssignments` | 조건별 리뷰 자동 매칭 실행 (`ALL` / `SAME_DEPARTMENT`) | Admin |
| `DELETE` | `/api/admin/assignments/{assignmentId}` | `deleteAssignment` | 미제출 리뷰 매칭 삭제 | Admin |

### 2.7 `reports` — 결과 리포트 조회·승인·발송
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/cycles/{cycleId}/reports` | `listCycleReports` | 회차별 리포트 목록 조회 (실패 건 15초 경과 시 자동 재큐잉) | Admin |
| `POST` | `/api/admin/reports/{reportId}/regenerate` | `regenerateReport` | 개별 리포트 재생성 요청 | Admin |
| `GET` | `/api/admin/reports/{reportId}/html` | `getReportHtml` | 리포트 HTML 미리보기 및 다운로드 | Admin |
| `GET` | `/api/admin/reports/{reportId}/pdf` | `getReportPdf` | 리포트 PDF 미리보기(`inline`) 및 다운로드(`?download=true`) | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/reports/publish` | `publishCycleReports` | 리포트 일괄 승인 및 Slack 발송 요청 | Admin |

### 2.8 `deliveries` — Slack DM 발송 이력 및 재시도
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/cycles/{cycleId}/deliveries` | `listCycleDeliveries` | 회차별 Slack DM 발송 이력 조회 | Admin |
| `POST` | `/api/admin/cycles/{cycleId}/deliveries/retry-failed` | `retryFailedDeliveries` | 실패 발송 건 일괄 재시도 요청 | Admin |

### 2.9 `reviewer` — 리뷰어 배정 목록 및 답변 작성·제출
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/reviewer/dashboard` | `getReviewerDashboard` | 리뷰어 배정 목록 및 진행률 조회 | Reviewer |
| `GET` | `/api/reviewer/assignments/{assignmentId}` | `getReviewerAssignmentForm` | 배정별 문항 및 작성 답변 조회 | Reviewer |
| `PUT` | `/api/reviewer/assignments/{assignmentId}/draft` | `saveAssignmentDraft` | 작성 중인 리뷰 답변 임시 저장 | Reviewer |
| `POST` | `/api/reviewer/assignments/{assignmentId}/submit` | `submitAssignmentReview` | 리뷰 답변 최종 제출 | Reviewer |

### 2.10 `media` — 문항 첨부 이미지 조회
| Method | Path | Operation ID | 요약 (`summary`) | 권한 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/media/questions/{questionId}/image` | `getQuestionImage` | 문항 참고 이미지 R2 스트리밍 조회 | Admin / Reviewer |

---

## 3. 공통 에러 응답 규격 (`ErrorResponse`)

모든 API 오류는 일관된 JSON 에러 스키마를 반환합니다:

```json
{
  "code": "STATE_CONFLICT",
  "message": "제출된 피어리뷰 답변이 최소 1개 이상 포함되어야 회차를 마감할 수 있습니다."
}
```

| 에러 코드 (`code`) | HTTP 상태 코드 | 발생 상황 |
| :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 필수 파라미터 누락, 형식 불일치, 범위 초과 |
| `UNAUTHORIZED` | `401` | 세션 쿠키 없음, 만료된 세션, 잘못된 로그인 자격증명 |
| `FORBIDDEN` | `403` | 역할 권한 불일치(`ADMIN` vs `REVIEWER`), CSRF 토큰 누락/불일치 |
| `NOT_FOUND` | `404` | 요청한 리소스 ID 또는 R2 파일이 존재하지 않음 |
| `STATE_CONFLICT` | `409` | 회차 상태 제약 위반(예: 답변 0개 상태에서 마감 시도), 중복 이메일/선택지/매칭 |
| `PAYLOAD_TOO_LARGE` | `413` | 문항 참고 이미지 10MB 초과, CSV 파일 2MB 초과 |
| `CSV_VALIDATION_ERROR` | `422` | CSV 업로드 시 특정 행(`row_index`)의 이메일/형식 오류 |
| `RATE_LIMITED` | `429` | 15분 내 로그인 5회 연속 실패로 인한 일시 잠금 |
| `INTERNAL_ERROR` | `500` | 예기치 못한 서버 내부 오류 |
