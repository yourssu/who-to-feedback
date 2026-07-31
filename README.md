# 🚀 팀원 간 피어리뷰 전체 자동화 시스템 (Who To Feedback)

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat&logo=python&logoColor=white)
![Django](https://img.shields.io/badge/Django-5.x-092E20?style=flat&logo=django&logoColor=white)
![Slack](https://img.shields.io/badge/Slack-API-4A154B?style=flat&logo=slack&logoColor=white)

웹 기반으로 동작하며 **Slack DM 인증**, **6개 전용 커스텀 관리자 센터**, **4가지 유연한 질문 유형**, **미작성 동료 명단 명시 Slack DM 자동 리마인더**, 그리고 **전원 작성 완료 시 PDF 리포트 생성 및 관리자 사전 검토 후 Slack DM 일괄 배포**를 지원하는 피어리뷰 전체 자동화 웹 시스템입니다.

---

## 💡 주요 핵심 기능

### 🔑 1. Slack DM 패스워드리스 핀코드 인증
- 피어리뷰 시작 시 리뷰어에게 **중복 없는 6자리 PIN 코드**를 Slack DM으로 일괄 자동 발송
- 비밀번호 설정이 필요 없이 **6자리 PIN 코드 입력만으로 웹 로그인** (서버 콘솔 로그에도 PIN 코드 출력으로 빠른 테스트 가능)

### 📋 2. 4가지 유연한 질문 유형 지원
- **`RATING`**: 5점 / 10점 척도 선택 평가
- **`TEXT`**: 서술형 주관식 피드백 (익명성 보장)
- **`SINGLE_CHOICE`**: 객관식 단일 선택 (Radio Button)
- **`MULTIPLE_CHOICE`**: 객관식 다중 선택 (Checkbox - 역량/장점 키워드 태그 칩 제공)

### ⏰ 3. 미작성 동료 명단이 명시된 Slack DM 자동 리마인더
- 마감 임박 시 작성하지 않은 리뷰어에게 **"아직 피어리뷰를 작성하지 않은 동료: [홍길동, 김철수]"** 명단을 명시한 독촉 Slack DM 발송

### ⚙️ 4. 6개 커스텀 관리자 전용 웹 센터 (`/admin-panel/`)
기본 Django Admin을 대체하며, 사용자 웹 UI 스타일과 통합된 전용 페이지 제공:
1. **메인 대시보드 (`/admin-panel/`)**: 회차 목록, 제출 진행률(%), 신규 회차 생성
2. **팀원 관리 페이지 (`/admin-panel/members/`)**: 팀원 목록, 신규 추가, 수정 및 삭제
3. **질문지 제작 페이지 (`/admin-panel/cycles/<id>/questions/`)**: 4가지 문항 및 선택지 옵션 제작
4. **매칭 관리 페이지 (`/admin-panel/cycles/<id>/assignments/`)**:
   - **팀(부서) 필터 기반 선택 드롭다운** 지원
   - **`ACTIVE` (진행 중) 상태에서도 매칭 동적 추가/삭제 지원** (신규 리뷰어 PIN 코드 Slack DM 자동 발송)
5. **진행 상태 대시보드 (`/admin-panel/cycles/<id>/status/`)**: 실시간 완료율(%) 프로그레스 바, 리뷰어별 미작성 동료 조회, 시작 & 리마인더 버튼
6. **HTML & PDF 결과 검토 페이지 (`/admin-panel/cycles/<id>/reports/`)**: Reviewee별 익명 피드백 웹 요약 미리보기 & PDF 프리뷰/다운로드, 승인 일괄 배포
7. **Slack DM 커스텀 메시지 전송 페이지 (`/admin-panel/messages/send/`)**: 특정 팀원 또는 전체 팀원에게 커스텀 안내/공지 Slack DM 발송

### 🛡️ 5. Strict 100% 마감 & 관리자 사전 검토/승인 배포
- **Strict 100% Completion Rule**: 지정된 모든 리뷰어가 작성을 마치기 전에는 세션이 마감되지 않음
- **자동 PDF 생성 & 검토 대기 (`COMPLETED`)**: 전원 작성 완료 시 PDF 리포트 자동 생성 후 관리자 대시보드에 보관 (대상자에게 즉시 발송되지 않음)
- **관리자 승인 발송 (`CLOSED`)**: 관리자가 대시보드에서 승인 클릭 시 Slack SDK `files.upload_v2`를 이용하여 Reviewee의 Slack DM으로 PDF 리포트 전송

---

## 🛠️ 기술 스택 (Tech Stack)

- **Backend**: Python 3.11+, Django 5.x
- **Database**: SQLite (기본 개발용) / PostgreSQL 호환 ORM
- **PDF Engine**: `xhtml2pdf` (HTML/CSS 렌더링 -> PDF 변환)
- **Slack SDK**: `slack-sdk` (`WebClient` - DM 전송 및 `files.upload_v2` 파일 전송, Mock Mode 탑재)
- **Frontend**: Django Templates + Vanilla CSS (Responsive Modern Design Tokens)

---

## 📁 프로젝트 구조

```
who-to-feedback/
├── config/                  # Django 설정 및 URL 라우팅
│   ├── settings.py
│   └── urls.py
├── core/                    # 핵심 피어리뷰 애플리케이션
│   ├── models.py            # Member, ReviewCycle, ReviewQuestion 등 8개 ORM 모델
│   ├── views/
│   │   ├── auth_views.py    # 6자리 PIN 코드 인증 로그인
│   │   ├── review_views.py  # 리뷰어 피어리뷰 동적 작성 폼
│   │   └── admin_views.py   # 6개 커스텀 관리자 웹 UI 뷰
│   ├── services/
│   │   ├── slack_service.py # Slack API 연동 및 Mock DM 서비스
│   │   └── pdf_service.py   # 익명 집계 & xhtml2pdf PDF 렌더링 엔진
│   ├── management/commands/ # CLI 자동화 커맨드
│   │   ├── start_review_cycle.py
│   │   ├── send_reminders.py
│   │   ├── generate_reports.py
│   │   └── publish_reports.py
│   ├── templates/
│   │   ├── auth/            # PIN 코드 로그인 템플릿
│   │   ├── review/          # 리뷰어 대시보드 & 작성 폼 템플릿
│   │   ├── reports/         # PDF 변환용 익명 피드백 리포트 템플릿
│   │   └── admin_custom/    # 6개 커스텀 관리자 전용 템플릿
│   └── tests.py             # 7개 통합 테스트 스위트 (100% Pass)
├── manage.py
├── requirements.txt
└── README.md
```

---

## 🚀 시작 가이드 (Quick Start)

### 1. 가상환경 설정 및 의존성 패키지 설치
```bash
# 가상환경 생성 및 활성화
python3 -m venv venv
source venv/bin/activate

# 의존성 패키지 설치
pip install -r requirements.txt
```

### 2. 데이터베이스 마이그레이션 & 슈퍼유저 생성
```bash
python manage.py makemigrations core
python manage.py migrate
python manage.py createsuperuser
```

### 3. 개발 서버 실행
```bash
python manage.py runserver
```
- **⚙️ 커스텀 관리자 센터**: [http://127.0.0.1:8000/admin-panel/](http://127.0.0.1:8000/admin-panel/)
- **🔑 리뷰어 PIN 로그인**: [http://127.0.0.1:8000/login/](http://127.0.0.1:8000/login/)

---

## ⚙️ Slack Bot 토큰 연동 및 Mock 테스트 모드

- `.env` 또는 환경 변수에 Slack Bot Token 설정:
  ```bash
  export SLACK_BOT_TOKEN="xoxb-your-slack-bot-token"
  export MOCK_SLACK_MODE="False"
  ```
- **Mock Mode (기본 활성화)**: `SLACK_BOT_TOKEN`이 지정되지 않거나 `MOCK_SLACK_MODE=True`인 경우, 실제 Slack API를 호출하지 않고 **서버 콘솔(stdout) 및 로그에 인증 PIN 코드와 메시지**를 명확하게 출력해 주어 토큰 없이도 완벽 테스트가 가능합니다.

---

## 🧪 자동화 테스트 실행

```bash
python manage.py test core
```

---

## 📄 라이선스
MIT License
