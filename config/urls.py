from django.contrib import admin
from django.urls import path, include, re_path
from django.conf import settings
from django.conf.urls.static import static
from django.views.static import serve
from django.http import JsonResponse
from django.shortcuts import redirect

from core.views import setup_views

def health_check(request):
    return JsonResponse({'status': 'ok'})

def admin_root_view(request):
    if request.user.is_authenticated and request.user.is_superuser:
        return redirect('admin_dashboard')
    return redirect('/admin/login/?next=/admin-panel/')

urlpatterns = [
    path('health/', health_check, name='health_check'),
    path('setup/', setup_views.setup_wizard, name='setup_wizard'),
    path('admin/', admin_root_view, name='admin_root'),
    path('admin/', admin.site.urls),
    path('', include('core.urls')),
    re_path(r'^media/(?P<path>.*)$', serve, {'document_root': settings.MEDIA_ROOT}),
]

if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0])
