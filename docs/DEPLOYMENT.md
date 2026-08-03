# PeerFlow (who-to-feedback) Docker + Host Nginx + Cloudflare 배포 가이드

본 문서는 **Cloudflare DNS/Edge Proxy → Host Nginx → Docker Container (Gunicorn/WhiteNoise/Django)** 3단 아키텍처 환경에서 피어리뷰 웹 서비스를 안정적으로 운영하고 배포하기 위한 통합 지침서입니다.

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
        ├── /media/   ➔ Host ./media/ (Direct Serve)
        ├── /static/  ➔ Gunicorn Container (WhiteNoise Serve)
        └── /         ➔ Gunicorn Container
        │
        ▼ (HTTP 127.0.0.1:8000)
[ Docker Container : peerflow_web ]
   ├── Gunicorn (--workers 2 --threads 4)
   ├── Django App (WhiteNoise Compressed Static Engine)
   ├── SQLite DB (./data/db.sqlite3)
   └── HTML 정적 리포트 서빙 엔진
```

---

## 📋 2. 사전 준비 사항 (Prerequisites)

1. 서버 호스트에 **Docker** 및 **Docker Compose**가 설치되어 있어야 합니다.
2. 서버 호스트에 **Nginx**가 설치되어 있어야 합니다 (`sudo apt install nginx`).
3. 도메인이 **Cloudflare DNS**에 등록되어 있어야 합니다.
4. 프로젝트 루트의 `.env` 파일에 필요한 환경 변수가 올바르게 설정되어 있어야 합니다.

---

## 🔑 3. Django 환경변수 및 보안 설정 (`.env`)

프로덕션 서버의 `.env` 파일 예시:

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

# 4. 앱 기본 URL
SITE_URL=https://yourdomain.com
```

> **참고**: `config/settings.py`에는 `ALLOWED_HOSTS`에 지정된 도메인으로부터 `CSRF_TRUSTED_ORIGINS`(`https://` 및 `http://`)를 자동으로 추론하는 안전장치가 반영되어 있습니다.

---

## 🐳 4. Docker 컨테이너 실행 및 데이터 영속성

### 4.1 영속 볼륨 (Data & Media Persistence)
정적 파일(`staticfiles`)은 Django의 **WhiteNoise** 미들웨어가 컨테이너 내부에서 직접 gzip 압축/캐싱하여 서빙하므로 별도의 호스트 마운트가 필요하지 않습니다. 호스트와 공유해야 하는 데이터만 마운트합니다:
* **SQLite DB**: `./data` ➔ `/app/data` (`./data/db.sqlite3`)
* **미디어 파일**: `./media` ➔ `/app/media` (질문 이미지, HTML 결과지 리포트)

### 4.2 컨테이너 구동 명령어
```bash
# 1. 최신 코드 반영 후 Docker 이미지 빌드 및 구동
docker compose up -d --build

# 2. 헬스체크 및 컨테이너 구동 상태 확인
docker compose ps

# 3. 애플리케이션 로그 확인
docker compose logs -f web
```

---

## ☁️ 5. Cloudflare HTTPS (SSL/TLS) 연동 설정

### Step 1. Cloudflare DNS 설정 (Proxy Mode 켜기)
1. [Cloudflare Dashboard](https://dash.cloudflare.com/) ➔ 해당 도메인 ➔ **DNS** 이동.
2. `A` 레코드 생성:
   * **Name**: `@` (또는 서브도메인)
   * **IPv4 address**: 사용자 호스트 서버의 공인 IP 주소
   * **Proxy status**: **Proxied** (주황색 구름 ☁️) 설정.

### Step 2. Cloudflare SSL/TLS 암호화 모드 설정
* **SSL/TLS** ➔ **Overview** ➔ 암호화 모드를 **Full** 또는 **Full (Strict)**로 선택 (Flexible 사용 시 Infinite 301 Redirect Loop 유발 위험).

### Step 3. Origin CA 인증서 생성 (Full / Full Strict 선택 시)
1. **SSL/TLS** ➔ **Origin Server** ➔ **Create Certificate** 클릭 후 생성.
2. 서버 호스트에 인증서 파일 저장:
   * Certificate ➔ `/etc/ssl/certs/cloudflare_origin.pem`
   * Private Key ➔ `/etc/ssl/private/cloudflare_origin.key`
3. 권한 설정: `sudo chmod 600 /etc/ssl/private/cloudflare_origin.key`

---

## 🌐 6. Host Nginx 설정

호스트 Nginx 설정 파일 (`/etc/nginx/sites-available/peerflow`) 예시:

```nginx
# 1. HTTP ➔ HTTPS 자동 리다이렉트
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;
    return 301 https://$host$request_uri;
}

# 2. HTTPS 메인 서버 설정
server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    # Cloudflare Origin CA 인증서 경로
    ssl_certificate /etc/ssl/certs/cloudflare_origin.pem;
    ssl_certificate_key /etc/ssl/private/cloudflare_origin.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 업로드 용량 제한 확장 (기본 1MB 제한 해제)
    client_max_body_size 50M;

    # Cloudflare 실제 사용자 IP 복원 헤더
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 162.158.0.0/15;
    real_ip_header CF-Connecting-IP;

    # 1. 정적 파일 (Static Files - WhiteNoise 서빙 컨테이너 프록시)
    location /static/ {
        proxy_pass http://127.0.0.1:8000/static/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    # 2. 미디어 파일 (Media Files - 질문 이미지, HTML 결과지 리포트 등)
    location /media/ {
        alias /path/to/who-to-feedback/media/;
        expires 7d;
        add_header Cache-Control "public, no-transform";
    }

    # 3. Gunicorn Docker 컨테이너 프록시 패스
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # 타임아웃 확장 (안정적 요청 처리 고려)
        proxy_connect_timeout 120s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### Nginx 설정 적용 및 재시작
```bash
sudo ln -sf /etc/nginx/sites-available/peerflow /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 🔄 7. 컨테이너 재배포 및 업데이트

```bash
git pull origin main
docker compose up -d --build
```
