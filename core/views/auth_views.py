from django.shortcuts import render, redirect
from django.contrib import messages
from core.models import ReviewAuthCode


def login_view(request):
    """6자리 핀코드 입력 기반 패스워드리스 로그인"""
    if request.method == 'POST':
        code_input = request.POST.get('code', '').strip()
        auth_code = ReviewAuthCode.objects.filter(code=code_input).first()

        if auth_code:
            # 세션에 로그인 정보 저장
            request.session['member_id'] = auth_code.member.id
            request.session['member_name'] = auth_code.member.name
            request.session['cycle_id'] = auth_code.cycle.id

            messages.success(request, f"환영합니다, {auth_code.member.name}님! 피어리뷰 작성을 시작하세요.")
            return redirect('review_dashboard')
        else:
            messages.error(request, "유효하지 않거나 만료된 인증번호입니다. 다시 확인해 주세요.")

    # GET 요청 시 혹은 자동 핀코드 파라미터 링크(?code=123456)
    code_param = request.GET.get('code', '')
    if code_param:
        auth_code = ReviewAuthCode.objects.filter(code=code_param).first()
        if auth_code:
            request.session['member_id'] = auth_code.member.id
            request.session['member_name'] = auth_code.member.name
            request.session['cycle_id'] = auth_code.cycle.id
            messages.success(request, f"환영합니다, {auth_code.member.name}님! 피어리뷰 작성을 시작하세요.")
            return redirect('review_dashboard')

    return render(request, 'auth/login.html')


def logout_view(request):
    """세션 로그아웃"""
    request.session.flush()
    messages.info(request, "성공적으로 로그아웃되었습니다.")
    return redirect('login')
