from django.urls import path
from core.views import auth_views, review_views, admin_views

urlpatterns = [
    # User Auth & Review Form
    path('login/', auth_views.login_view, name='login'),
    path('logout/', auth_views.logout_view, name='logout'),
    path('', review_views.review_dashboard, name='review_dashboard'),
    path('review/<int:assignment_id>/', review_views.review_form, name='review_form'),

    # 6 Custom Admin Web Pages (/admin-panel/)
    path('admin-panel/', admin_views.admin_dashboard, name='admin_dashboard'),
    path('admin-panel/cycles/create/', admin_views.admin_create_cycle, name='admin_create_cycle'),

    # PAGE 1: 팀원 관리
    path('admin-panel/members/', admin_views.admin_members, name='admin_members'),
    path('admin-panel/members/add/', admin_views.admin_add_member, name='admin_add_member'),
    path('admin-panel/members/<int:member_id>/delete/', admin_views.admin_delete_member, name='admin_delete_member'),

    # PAGE 2: 질문지 제작
    path('admin-panel/cycles/<int:cycle_id>/questions/', admin_views.admin_questions, name='admin_questions'),
    path('admin-panel/cycles/<int:cycle_id>/questions/add/', admin_views.admin_add_question, name='admin_add_question'),
    path('admin-panel/questions/<int:question_id>/delete/', admin_views.admin_delete_question, name='admin_delete_question'),
    path('admin-panel/questions/<int:question_id>/options/add/', admin_views.admin_add_option, name='admin_add_option'),

    # PAGE 3: 매칭 관리 (ACTIVE 진행 중 상태에서도 수정 지원)
    path('admin-panel/cycles/<int:cycle_id>/assignments/', admin_views.admin_assignments, name='admin_assignments'),
    path('admin-panel/cycles/<int:cycle_id>/assignments/add/', admin_views.admin_add_assignment, name='admin_add_assignment'),
    path('admin-panel/assignments/<int:assignment_id>/delete/', admin_views.admin_delete_assignment, name='admin_delete_assignment'),
    path('admin-panel/cycles/<int:cycle_id>/assignments/auto/', admin_views.admin_auto_match, name='admin_auto_match'),

    # PAGE 4: 진행 상태 대시보드 & 리마인더
    path('admin-panel/cycles/status/', admin_views.admin_status, name='admin_status'),
    path('admin-panel/cycles/<int:cycle_id>/status/', admin_views.admin_status_detail, name='admin_status_detail'),
    path('admin-panel/cycles/<int:cycle_id>/start/', admin_views.admin_start_cycle_action, name='admin_start_cycle_action'),
    path('admin-panel/cycles/<int:cycle_id>/reminder/', admin_views.admin_send_reminder_action, name='admin_send_reminder_action'),
    path('admin-panel/cycles/<int:cycle_id>/generate-reports/', admin_views.admin_generate_reports_action, name='admin_generate_reports_action'),

    # PAGE 5: HTML/PDF 결과 검토 및 배포
    path('admin-panel/cycles/<int:cycle_id>/reports/', admin_views.admin_reports, name='admin_reports'),
    path('admin-panel/cycles/<int:cycle_id>/publish/', admin_views.admin_publish_reports_action, name='admin_publish_reports_action'),

    # PAGE 6: Slack DM 커스텀 메시지 전송
    path('admin-panel/messages/send/', admin_views.admin_send_message, name='admin_send_message'),
]
