from django.core.management.base import BaseCommand, CommandError
from core.models import ReviewCycle
from core.services.report_service import HTMLReportService


class Command(BaseCommand):
    help = "100% 전원 작성 완료된 회차의 피어리뷰 결과 HTML 리포트를 일괄 생성합니다."

    def add_arguments(self, parser):
        parser.add_argument('--cycle-id', type=int, required=True, help="피어리뷰 회차 ID")

    def handle(self, *args, **options):
        cycle_id = options['cycle_id']
        try:
            cycle = ReviewCycle.objects.get(id=cycle_id)
        except ReviewCycle.DoesNotExist:
            raise CommandError(f"ReviewCycle with ID {cycle_id} does not exist.")

        if not cycle.is_all_submitted:
            self.stdout.write(self.style.WARNING(
                f"Cannot generate reports: Cycle '{cycle.title}' is not 100% completed yet ({cycle.completion_rate}%)."
            ))
            return

        reports = PDFReportService.generate_all_reports_for_cycle(cycle)
        cycle.status = 'COMPLETED'
        cycle.save()

        self.stdout.write(self.style.SUCCESS(
            f"Successfully generated {len(reports)} PDF reports for cycle '{cycle.title}'. Status is now 'COMPLETED' (Admin Review Pending)."
        ))
