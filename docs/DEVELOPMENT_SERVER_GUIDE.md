# PeerFlow 개발 서버 구동 & 운영 가이드 (Development Server Guide)

본 문서는 **Django 기반 피어리뷰 시스템 (PeerFlow)**의 개발 환경 구축, 마이그레이션, 슈퍼유저 계정 생성, 개발 서버 실행, MOCK 모드 및 실 Slack API 연동 설정, 단위 테스트 실행 방법을 정리한 종합 가이드입니다.

---

## 1. 사전 요구사항 (Prerequisites)

- **Python**: 3.10 이상 (Python 3.14 권장)
- **pip & venv**: 파이썬 가상환경 도구
- **SQLite3**: 기본 내장 가상 DB 사용

---

## 2. 가상환경 설정 및 패키지 설치

### 1) 가상환경 생성 및 활성화
```bash
# 가상환경 생성 (최초 1회)
python3 -m venv venv

# macOS / Linux 가상환경 활성화
source venv/bin/activate

# Windows (PowerShell) 가상환경 활성화
# .\venv\Scripts\Activate.ps1
```

### 2) 필수 의존성 패키지 설치
```bash
pip install --upgrade pip
pip install -r requirements.txt
```

> **주요 설치 패키지 목록**:
> - `Django`: 백엔드 코어 웹 프레임워크
> - `python-dotenv`: `.env` 환경 변수 자동 로더
> - `slack-sdk`: Slack API 커뮤니케이션
> - `xhtml2pdf`: 피드백 결과 PDF 리포트 자동 생성
> - `python-pptx`: 피드백 결과 PPTX 리포트 자동 생성
> - `openpyxl`: 팀원 및 평가 엑셀 파일 데이터 파싱

---

## 3. 환경 변수 설정 (`.env`)

프로젝트 루트 디렉토리에 `.env` 파일을 생성하거나 `.env.example`을 복사하여 설정합니다.

```bash
cp .env.example .env
```

### `.env` 파일 예시:
```env
# Django 시크릿 키 및 디버그 설정
SECRET_KEY=django-insecure-peerflow-secret-key-change-in-production
DEBUG=True

# Slack API 설정 (테스트 시 MOCK_SLACK_MODE=True 사용 가능)
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token-here
SLACK_SIGNING_SECRET=your-slack-signing-secret-here
MOCK_SLACK_MODE=True
```

- `MOCK_SLACK_MODE=True` 설정 시: 실제 Slack API를 호출하지 않고 **터미널 콘솔/서버 로그에 6자리 PIN 코드 및 DM 메시지가 출력**되어 외부 연동 없이 개발 및 시험 운용이 가능합니다.

---

## 4. 데이터베이스 마이그레이션 & 관리자 계정 생성

### 1) DB 마이그레이션 적용
```bash
python manage.py makemigrations core
python manage.py migrate
```

### 2) 관리자(Superuser) 계정 생성
관리자 센터(`/admin-panel/`)에 로그인하기 위한 슈퍼유저 계정을 생성합니다.

```bash
python manage.py createsuperuser
```
- **아이디 (Username)**: `admin`
- **이메일 (Email)**: `admin@example.com`
- **비밀번호 (Password)**: `password123` (개발용)

---

## 5. 개발 서버 구동 (Running the Dev Server)

```bash
python manage.py runserver
```

서버 구동 성공 시 아래 주소로 접속할 수 있습니다:

- 🌐 **리뷰어 메인 페이지 (PIN 로그인)**: `http://127.0.0.1:8000/login`
- 🔑 **Django 어드민 로그인 페이지**: `http://127.0.0.1:8000/admin/login/`
- 🛡️ **커스텀 관리자 센터 (Admin Panel)**: `http://127.0.0.1:8000/admin-panel/`

---

## 6. 콘솔 로그를 통한 6자리 PIN 코드 확인

`MOCK_SLACK_MODE=True` 환경에서 회차가 시작되면 리뷰어에게 핀코드가 생성되어 서버 실행 터미널에 아래와 같이 표시됩니다:

```text
===========================================================
🔑 [AUTH PIN CODE LOG] Member: 앨리스 (alice@soongsil.ac.kr)
🔑 [AUTH PIN CODE]: 849201
===========================================================
```

위 6자리 핀코드를 `http://127.0.0.1:8000/login`에 입력하여 리뷰어 로그인 및 작성을 진행할 수 있습니다.

---

## 7. 자동화 테스트 스위트 실행 (Running Unit Tests)

백엔드의 모든 기능(권한 분리, 임시 저장, 질문 잠금, 12가지 검수 기능 등)에 대한 단체 테스트 스위트를 구동합니다.

```bash
python manage.py test core
```

**정상 결과 예시**:
```text
Ran 4 tests in 0.698s

OK
```
