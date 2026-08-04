from core.models import ReviewCycle


def admin_context(request):
    """관리자 사이드바 및 공통 템플릿용 최신 회차(latest_cycle) 컨텍스트 제공"""
    try:
        latest_cycle = ReviewCycle.objects.first()
    except Exception:
        latest_cycle = None
    return {
        'latest_cycle': latest_cycle,
    }
