import time

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import logout as django_logout
from django.shortcuts import render, redirect

from core.models import ReviewAuthCode

MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCK_SECONDS = 15 * 60


def _is_login_locked(request):
    """연속 로그인 실패 잠금 상태 확인 (잠금이 만료되면 세션 키 정리)"""
    lock_until = request.session.get('login_lock_until')
    if not lock_until:
        return False
    if time.time() < lock_until:
        return True
    request.session.pop('login_lock_until', None)
    request.session.pop('login_fail_count', None)
    return False


def login_view(request):
    """6자리 핀코드 입력 기반 패스워드리스 로그인 (ACTIVE 회차 PIN만 유효)"""
    if request.method == 'POST':
        if _is_login_locked(request):
            return render(request, 'auth/login.html', {'is_locked_out': True})

        code_input = request.POST.get('code', '').strip()
        auth_code = ReviewAuthCode.objects.select_related('member', 'cycle').filter(
            code=code_input,
            cycle__status='ACTIVE',
        ).first()

        if auth_code:
            # 세션에 로그인 정보 저장
            request.session['member_id'] = auth_code.member.id
            request.session['member_name'] = auth_code.member.name
            request.session['cycle_id'] = auth_code.cycle.id
            request.session.pop('login_fail_count', None)
            request.session.pop('login_lock_until', None)

            messages.success(request, f"환영합니다, {auth_code.member.name}님! 피어리뷰 작성을 시작하세요.")
            return redirect('review_dashboard')

        fail_count = request.session.get('login_fail_count', 0) + 1
        if fail_count >= MAX_LOGIN_ATTEMPTS:
            request.session['login_lock_until'] = time.time() + LOGIN_LOCK_SECONDS
            request.session['login_fail_count'] = 0
            return render(request, 'auth/login.html', {'is_locked_out': True})

        request.session['login_fail_count'] = fail_count
        messages.error(request, "유효하지 않거나 만료된 인증번호입니다. 다시 확인해 주세요.")

    return render(request, 'auth/login.html', {'is_locked_out': _is_login_locked(request)})


def logout_view(request):
    """세션 파기, Django 인증 해제 및 브라우저 쿠키 강제 삭제 (DB draft_data는 보존)"""
    django_logout(request)
    request.session.flush()

    response = redirect('login')
    session_cookie_name = getattr(settings, 'SESSION_COOKIE_NAME', 'sessionid')
    response.delete_cookie(session_cookie_name, path='/')
    response.delete_cookie('csrftoken', path='/')

    messages.info(request, "성공적으로 로그아웃되었습니다.")
    return response
