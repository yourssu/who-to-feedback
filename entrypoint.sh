#!/bin/sh
set -e

# data 디렉토리 확보 및 마운트 처리
mkdir -p /app/data

# 레거시 /app/db.sqlite3 파일이 존재하고 /app/data/db.sqlite3 가 없으면 이관
if [ -f "/app/db.sqlite3" ] && [ ! -f "/app/data/db.sqlite3" ]; then
    echo "==> Migrating legacy /app/db.sqlite3 to /app/data/db.sqlite3..."
    mv /app/db.sqlite3 /app/data/db.sqlite3
elif [ -d "/app/db.sqlite3" ]; then
    rm -rf /app/db.sqlite3
fi

if [ ! -f "/app/data/db.sqlite3" ]; then
    touch /app/data/db.sqlite3
fi

chmod -R 755 /app/data 2>/dev/null || true

echo "==> Running database migrations..."
python manage.py migrate --noinput

echo "==> Collecting static files..."
python manage.py collectstatic --noinput

echo "==> Starting application..."
exec "$@"
