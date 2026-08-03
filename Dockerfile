# 경량 Python 3.12 Slim 베이스 이미지 (초기 풀링 속도 5배 이상 단축)
FROM python:3.12-slim-bookworm

# 작업 디렉토리 설정
WORKDIR /app

# 환경 변수 설정
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

# 기본 유틸리티 및 한글 폰트 패키지 설치
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-nanum \
    fonts-noto-cjk \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 의존성 패키지 설치 (소축적 레이어 캐싱)
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Playwright Chromium 브라우저 및 필수 의존성 패키지만 핀포인트 설치 (Firefox/WebKit 미설치로 용량/시간 절감)
RUN playwright install --with-deps chromium

# 애플리케이션 소스 복사
COPY . /app/

# entrypoint 스크립트 실행 권한 부여
RUN chmod +x /app/entrypoint.sh

# 외부 노출 포트
EXPOSE 8000

# 엔트리포인트 및 Gunicorn WSGI 서버 실행 (워커 2개, 스레드 4개, 타임아웃 120초)
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "--timeout", "120", "config.wsgi:application"]


