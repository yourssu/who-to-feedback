# Playwright Python 공식 베이스 이미지 (Ubuntu Noble 기반, Chromium 무인 브라우저 라이브러리 탑재)
FROM mcr.microsoft.com/playwright/python:v1.49.0-noble

# 작업 디렉토리 설정
WORKDIR /app

# 컨테이너 내 한글 폰트 패키지 및 유틸리티 설치
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-nanum \
    fonts-noto-cjk \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 의존성 패키지 설치
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 소스 복사
COPY . /app/

# 환경 변수 설정
ENV PYTHONUNBUFFERED=1 \
    PORT=8000

# Django 정적 파일 모으기
RUN python manage.py collectstatic --noinput || true

# 외부 노출 포트
EXPOSE 8000

# Gunicorn WSGI 서버 실행 (워커 3개, 타임아웃 120초)
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "120", "config.wsgi:application"]
