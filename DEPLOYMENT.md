# Cloudflare + Host Nginx + Docker Django 배포 가이드

본 문서는 **Cloudflare DNS/Edge Proxy → Host Nginx → Docker Container (Gunicorn/Django)** 3단 아키텍처 환경에서 피어리뷰 웹 서비스를 문제없이 안정적으로 운영하기 위한 배포 가이드입니다.

---

## 🏗️ 1. 전체 배포 아키텍처

```
[ 클라이언트 브라우저 ]
        │
        ▼ (HTTPS / 443)
[ Cloudflare Edge Proxy ]
        │
        ▼ (HTTP 80 / HTTPS 443)
[ Host Nginx (Reverse Proxy) ]
        │
        ▼ (HTTP 127.0.0.1:8000)
[ Docker Container : peerflow_web ]
   ├── Gunicorn (--workers 2 --threads 4)
   ├── Django App (SQLite: ./data/db.sqlite3)
   └── Playwright Chromium (PDF 엔진)
```

---

## 🔑 2. Django 환경변수 및 보안 설정 (`.env`)

프로덕션 서버의 `.env` 파일에 아래 환경 변수를 반드시 설정해야 합니다.

```ini
# 1. Django 보안 설정
DJANGO_SECRET_KEY=your-production-ultra-secure-secret-key-here
DEBUG=False

# 2. 도메인 및 CSRF 허용 목록 (★ 필수 ★)
ALLOWED_HOSTS=yourdomain.com,www.yourdomain.com
CSRF_TRUSTED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com

# 3. Slack 연동 설정
SLACK_BOT_TOKEN=xoxb-your-real-slack-bot-token
MOCK_SLACK_MODE=False
```

> **참고**: `config/settings.py`에는 `ALLOWED_HOSTS`에 지정된 도메인으로부터 `CSRF_TRUSTED_ORIGINS`(`https://` 및 `http://`)를 자동으로 추론하는 안전장치가 반영되어 있습니다.

---

## 🌐 3. Host Nginx 설정

호스트 서버에 설치된 Nginx의 설정 파일(`/etc/nginx/sites-available/who-to-feedback.conf`)에 샘플 설정 파일[`docs/nginx.conf.sample`](file:///Users/yoon/who-to-feedback/docs/nginx.conf.sample)을 적용합니다.

### 핵심 설정 항목:
1. **CSRF 및 HTTPS 프록시 헤더 전송**:
   ```nginx
   proxy_set_header Host $host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   ```
2. **Cloudflare 접속자 실제 IP 복원**:
   - Nginx의 `real_ip_header CF-Connecting-IP;` 및 Cloudflare IP 서브넷 등록 적용.
3. **파일 업로드 용량 늘리기**:
   - `client_max_body_size 50M;` (기본 1MB 제한 해제).
4. **타임아웃 보장**:
   - `proxy_read_timeout 300s;` (PDF 생성 작업 시 Nginx 504 Timeout 에러 예방).

---

## ☁️ 4. Cloudflare 대시보드 설정

1. **SSL/TLS 암호화 모드**:
   - Cloudflare 대시보드 → **SSL/TLS** → **Full** 또는 **Full (strict)**로 설정합니다.
   - (*Flexible 사용 시 301 Infinite Redirect Loop 유발 위험*)
2. **100초 타임아웃 안내 (Cloudflare 524 Error)**:
   - Cloudflare Free/Pro 요금제는 **100초 HTTP 타임아웃**이 고정되어 있습니다.
   - 관리자 센터에서 전체 인원의 PDF 리포트를 한꺼번에 생성할 경우 100초 초과 시 524 에러 화면이 나타날 수 있으나, 백그라운드 Gunicorn 스레드는 정상 실행됩니다.
   - 대량 리포트 생성 시에는 10~20명 단위로 나누어 실행하는 것을 권장합니다.

---

## 🐳 5. Docker 컨테이너 배포 및 검증 명령어

```bash
# 1. 최신 코드 반영 후 Docker 이미지 빌드
docker compose build --no-cache

# 2. 백그라운드 컨테이너 실행
docker compose up -d

# 3. 헬스체크 및 컨테이너 상태 확인 (healthy 확인)
docker compose ps

# 4. 엔드포인트 수동 헬스체크 테스트
curl -f http://localhost:8000/health/
# 응답: {"status":"ok"}

# 5. 애플리케이션 로그 확인
docker compose logs -f web
```
