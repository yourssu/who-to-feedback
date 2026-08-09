from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.models import User
from django.http import Http404
from django.shortcuts import render, redirect

from core.models import Member


def setup_wizard(request):
    """최초 구동 시 1회만 동작하는 웹 기반 관리자 계정 생성 위저드"""
    has_superuser = User.objects.filter(is_superuser=True).exists()
    has_admin_member = Member.objects.filter(role='ADMIN').exists()

    # 이미 관리자가 1명이라도 존재하는 경우 위저드 영구 차단 (404)
    if has_superuser or has_admin_member:
        raise Http404("이미 시스템 초기 설정이 완료되었습니다.")

    if request.method == 'POST':
        username = request.POST.get('username', '').strip()
        email = request.POST.get('email', '').strip()
        password = request.POST.get('password', '').strip()
        password_confirm = request.POST.get('password_confirm', '').strip()

        if not username or not email or not password:
            messages.error(request, "모든 필수 항목을 입력해 주세요.")
            return render(request, 'auth/setup.html', {'username': username, 'email': email})

        if password != password_confirm:
            messages.error(request, "비밀번호가 일치하지 않습니다. 다시 확인해 주세요.")
            return render(request, 'auth/setup.html', {'username': username, 'email': email})

        if len(password) < 6:
            messages.error(request, "비밀번호는 최소 6자 이상이어야 합니다.")
            return render(request, 'auth/setup.html', {'username': username, 'email': email})

        # 1. Django Superuser 생성
        superuser = User.objects.create_superuser(username=username, email=email, password=password)

        # 2. 관리자 Member 모델 생성 (팀원 목록 및 리뷰어 관리 연동)
        member, _ = Member.objects.get_or_create(
            email=email,
            defaults={
                'name': username,
                'slack_user_id': f"U_{username.upper()}",
                'department': '최고관리자',
                'role': 'ADMIN'
            }
        )
        member.role = 'ADMIN'
        member.save()

        # 3. 로그인 및 세션 처리
        login(request, superuser)
        request.session['member_id'] = member.id
        request.session['member_name'] = member.name
        request.session['member_email'] = member.email

        messages.success(request, f"환영합니다! 최초 관리자('{username}') 계정이 성공적으로 생성되었습니다.")
        return redirect('admin_dashboard')

    return render(request, 'auth/setup.html')
