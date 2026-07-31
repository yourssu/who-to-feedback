# Who To Feedback (피어리뷰 자동화 시스템)

Django 기반의 웹 피어리뷰 시스템으로, Slack DM을 활용한 PIN 코드 인증, 피어리뷰 작성, 미작성자 알림, HTML/PDF 리포트 생성 및 관리자 검토/배포 기능을 제공합니다.

---

## 주요 기능

1. **Slack DM PIN 코드 인증**: 리뷰 회차 시작 시 사용자에게 6자리 PIN 코드를 Slack DM으로 발송하여 비밀번호 없이 로그인합니다.
2. **피어리뷰 문항 유형**: 척도(Rating), 서술형 주관식(Text), 객관식 단일 선택(Single Choice), 객관식 다중 선택(Multiple Choice) 문항을 지원합니다.
3. **미작성자 Slack DM 알림**: 피어리뷰 마감 전 미작성자에게 작성해야 할 동료 목록을 포함하여 독촉 DM을 발송합니다.
4. **전용 관리자 웹 UI (`/admin-panel/`)**:
   - 팀원 정보 등록 및 수정 (`/admin-panel/members/`)
   - 문항 및 객관식 선택지 제작 (`/admin-panel/cycles/<id>/questions/`)
   - 부서별 필터링 기반 리뷰어-리뷰이 매칭 (진행 중 매칭 변경 가능)
   - 회차별 제출 진행률 확인 및 알림 트리거 (`/admin-panel/cycles/<id>/status/`)
   - HTML/PDF 리포트 미리보기 및 Slack DM 배포 (`/admin-panel/cycles/<id>/reports/`)
   - 커스텀 Slack DM 메시지 발송 (`/admin-panel/messages/send/`)
5. **PDF 생성 및 관리자 검토**: 전원 제출 완료 시 PDF 리포트가 생성되며, 관리자가 검토 대시보드에서 확인 후 배포를 승인합니다.

---

## 기술 스택

- **Backend**: Python 3.11+, Django 5.x
- **Database**: SQLite (개발용) / Django ORM
- **PDF Engine**: xhtml2pdf
- **Integration**: Slack SDK (WebClient API)

---

## 실행 방법

### 1. 환경 설정 및 패키지 설치
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. 마이그레이션 및 서버 실행
```bash
# .env.example 파일 복사 및 환경 변수 설정
cp .env.example .env

python manage.py migrate
python manage.py runserver
```

- **관리자 웹 UI**: http://127.0.0.1:8000/admin-panel/
- **사용자 로그인**: http://127.0.0.1:8000/login/

### 3. 테스트 실행
```bash
python manage.py test core
```

---

## 기술 문서

- **기술 명세서**: [docs/TECHNICAL_SPECIFICATION.md](docs/TECHNICAL_SPECIFICATION.md)
- **Slack 연동 가이드**: [docs/SLACK_INTEGRATION_GUIDE.md](docs/SLACK_INTEGRATION_GUIDE.md)
