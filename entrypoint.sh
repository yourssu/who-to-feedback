#!/bin/sh
set -e

# db.sqlite3가 디렉토리로 자동 생성된 경우(Docker bind mount 이슈) 감지 및 파일로 전환
if [ -d "/app/db.sqlite3" ]; then
    echo "==> Warning: /app/db.sqlite3 was mounted as a directory by Docker. Converting to file..."
    rm -rf /app/db.sqlite3
fi

if [ ! -f "/app/db.sqlite3" ]; then
    touch /app/db.sqlite3
fi

chmod 666 /app/db.sqlite3 2>/dev/null || true

echo "==> Running database migrations..."
python manage.py migrate --noinput

echo "==> Collecting static files..."
python manage.py collectstatic --noinput

echo "==> Starting application..."
exec "$@"
