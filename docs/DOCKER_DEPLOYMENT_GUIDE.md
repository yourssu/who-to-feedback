# PeerFlow 피어리뷰 시스템 Docker 컨테이너 배포 & Cloudflare HTTPS 연동 가이드

본 문서는 **PeerFlow(who-to-feedback)** 시스템을 Docker 컨테이너로 빌드/실행하고, 호스트의 Nginx 및 **Cloudflare HTTPS (SSL/TLS)**를 연동하는 배포 지침서입니다.

---

## 1. 사전 준비 사항 (Prerequisites)

1. 서버 호스트에 **Docker** 및 **Docker Compose**가 설치되어 있어야 합니다.
2. 서버 호스트에 **Nginx**가 설치되어 있어야 합니다 (`sudo apt install nginx`).
3. 본인 도메인이 **Cloudflare DNS**에 등록되어 있어야 합니다.
4. 프로젝트 루트의 `.env` 파일에 환경 변수가 올바르게 설정되어 있어야 합니다.

```env
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SECRET_KEY=your-django-secret-key
DEBUG=False
ALLOWED_HOSTS=*
```

---

## 2. Docker 컨테이너 빌드 및 실행

프로젝트 루트 디렉토리에서 아래 명령어로 Docker 컨테이너를 빌드하고 백그라운드로 실행합니다.

```bash
# 1. 컨테이너 빌드 및 구동
docker-compose up -d --build

# 2. 컨테이너 구동 상태 확인
docker-compose ps

# 3. 애플리케이션 로그 확인
docker-compose logs -f web
```

---

## 3. Cloudflare HTTPS (SSL/TLS) 연동 설정

Cloudflare를 경유하여 보안 HTTPS 커넥션을 구축하는 3단계 설정입니다.

### Step 1. Cloudflare DNS 설정 (Proxy Mode 켜기)
1. [Cloudflare Dashboard](https://dash.cloudflare.com/) 진입 ➔ 해당 도메인 선택 ➔ **DNS** 탭으로 이동.
2. `A` 레코드 생성:
   - **Name**: `peerflow` (또는 `@`)
   - **IPv4 address**: 사용자 호스트 서버의 공인 IP 주소
   - **Proxy status**: **Proxied** (주황색 구름 ☁️) 설정 ➔ SSL/TLS 자동 보호 및 DDoS 방어 활성화.

---

### Step 2. Cloudflare SSL/TLS 암호화 모드 설정
1. **SSL/TLS** 탭 ➔ **Overview** 이동.
2. 암호화 모드를 **Full** 또는 **Full (Strict)**로 선택합니다.
   - **Flexible**: Cloudflare ➔ Nginx 간 HTTP (80) 연결 (인증서 미설치 시)
   - **Full**: Cloudflare ➔ Nginx 간 자체 서명 SSL / HTTP (443) 연결 (권장)
   - **Full (Strict)**: Cloudflare Origin CA 인증서 설치 시 (최고 보안)

---

### Step 3. Cloudflare Origin CA 인증서 생성 (Full / Full Strict 선택 시)
1. **SSL/TLS** ➔ **Origin Server** 탭 클릭.
2. **Create Certificate** 클릭 ➔ RSA 2048, 유효기간 설정 후 생성.
3. 서버 호스트의 `/etc/ssl/certs/` 디렉토리에 생성된 파일 저장:
   - Certificate 내용 ➔ `/etc/ssl/certs/cloudflare_origin.pem`
   - Private Key 내용 ➔ `/etc/ssl/private/cloudflare_origin.key`
4. 권한 설정:
   ```bash
   sudo chmod 600 /etc/ssl/private/cloudflare_origin.key
   ```

---

## 4. 호스트 Nginx 설정 (Cloudflare + Docker Nginx Configuration)

호스트 Nginx에서 Cloudflare 헤더를 수신하고 Docker 컨테이너(`127.0.0.1:8000`)로 프록시 패스를 연동합니다.

### 4.1 Nginx 설정 파일 작성 (`/etc/nginx/sites-available/peerflow`)

```nginx
# 1. HTTP ➔ HTTPS 자동 리다이렉트
server {
    listen 80;
    server_name peerflow.yourdomain.com;
    return 301 https://$host$request_uri;
}

# 2. HTTPS 메인 서버 설정
server {
    listen 443 ssl http2;
    server_name peerflow.yourdomain.com;

    # Cloudflare Origin CA 인증서 경로 (Flexible 모드 시 ssl 항목 생략 가능)
    ssl_certificate /etc/ssl/certs/cloudflare_origin.pem;
    ssl_certificate_key /etc/ssl/private/cloudflare_origin.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 업로드 용량 제한 해제
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

    # 1. 정적 파일 (Static Files) 호스트 다이렉트 서빙
    location /static/ {
        alias /Users/yoon/who-to-feedback/staticfiles/;
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    # 2. 미디어 파일 (Media Files - 질문 이미지, PDF 리포트 등)
    location /media/ {
        alias /Users/yoon/who-to-feedback/media/;
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

        # 타임아웃 확장 (6K PDF 생성 시간 고려)
        proxy_connect_timeout 120s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

### 4.2 Nginx 설정 적용 및 재시작

```bash
# 심볼릭 링크 생성
sudo ln -s /etc/nginx/sites-available/peerflow /etc/nginx/sites-enabled/

# Nginx 문법 검사
sudo nginx -t

# Nginx 재시작
sudo systemctl reload nginx
```

---

## 5. 데이터 영속성 및 백업 (Data Persistence)

- **SQLite DB**: 호스트의 `./db.sqlite3` 파일이 컨테이너 내부 `/app/db.sqlite3`로 볼륨 마운트되어 데이터가 보존됩니다.
- **미디어 파일**: 호스트의 `./media/` 폴더가 컨테이너 내부 `/app/media`로 볼륨 마운트되어 질문 첨부 이미지 및 생성된 PDF/PPT 결과지가 안전하게 보존됩니다.

---

## 6. 컨테이너 재배포 및 업데이트

```bash
git pull origin main
docker-compose up -d --build
```
