# PeerFlow 피어리뷰 시스템 Docker 컨테이너 배포 & 호스트 Nginx 연결 가이드

본 문서는 **PeerFlow(who-to-feedback)** 시스템을 Docker 컨테이너로 빌드/실행하고, 서버 호스트의 Nginx와 연동하는 배포 지침서입니다.

---

## 1. 사전 준비 사항 (Prerequisites)

1. 서버 호스트에 **Docker** 및 **Docker Compose**가 설치되어 있어야 합니다.
2. 서버 호스트에 **Nginx**가 설치되어 있어야 합니다 (`sudo apt install nginx`).
3. 프로젝트 루트의 `.env` 파일에 환경 변수(Slack Bot Token, Django Secret Key 등)가 올바르게 설정되어 있어야 합니다.

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

## 3. 호스트 Nginx 설정 (Host Nginx Configuration)

호스트 서버의 Nginx에서 PeerFlow Docker 컨테이너(`127.0.0.1:8000`)로 리버스 프록시를 연결합니다.

### 3.1 Nginx 설정 파일 작성 (`/etc/nginx/sites-available/peerflow`)

```nginx
server {
    listen 80;
    server_name peerflow.yourdomain.com; # 사용자 도메인 또는 IP

    # 업로드 파일 용량 제한 해제 (결과지/이미지 업로드용)
    client_max_body_size 50M;

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
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 타임아웃 확장 (6K PDF 생성 시간 고려)
        proxy_connect_timeout 120s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

### 3.2 Nginx 설정 심볼릭 링크 및 재시작

```bash
# 심볼릭 링크 생성
sudo ln -s /etc/nginx/sites-available/peerflow /etc/nginx/sites-enabled/

# Nginx 문법 검사
sudo nginx -t

# Nginx 재시작
sudo systemctl reload nginx
```

---

## 4. 데이터 영속성 및 백업 (Data Persistence)

- **SQLite DB**: 호스트의 `./db.sqlite3` 파일이 컨테이너 내부 `/app/db.sqlite3`로 볼륨 마운트되어 데이터가 보존됩니다.
- **미디어 파일**: 호스트의 `./media/` 폴더가 컨테이너 내부 `/app/media`로 볼륨 마운트되어 질문 첨부 이미지 및 생성된 PDF/PPT 결과지가 안전하게 보존됩니다.

---

## 5. 컨테이너 재배포 및 업데이트

새로운 코드를 업데이트한 후 배포할 때는 아래 명령어를 실행합니다.

```bash
git pull origin main
docker-compose up -d --build
```
