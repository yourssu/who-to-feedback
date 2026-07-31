from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from core.models import ReviewCycle
from core.services.slack_service import SlackService


class Command(BaseCommand):
    help = "관리자 검토를 마친 피어리뷰 결과 PDF 리포트를 Reviewee들의 Slack DM으로 최종 배포합니다."

    def add_arguments(self, parser):
        parser.add_argument('--cycle-id', type=int, required=True, help="피어리뷰 회차 ID")

    def handle(self, *args, **options):
        cycle_id = options['cycle_id']
        try:
            cycle = ReviewCycle.objects.get(id=cycle_id)
        except ReviewCycle.DoesNotExist:
            raise CommandError(f"ReviewCycle with ID {cycle_id} does not exist.")

        reports = cycle.reports.all()
        if not reports.exists():
            self.stdout.write(self.style.WARNING(f"No reports found for cycle '{cycle.title}'. Please run generate_reports first."))
            return

        slack = SlackService()
        sent_count = 0

        for r in reports:
            if r.pdf_file and not r.is_sent:
                success, _ = slack.send_pdf_report_dm(
                    member=r.reviewee,
                    pdf_file_path=r.pdf_file.path,
                    cycle_title=cycle.title
                )
                if success:
                    r.is_sent = True
                    r.sent_at = timezone.now()
                    r.save()
                    sent_count += 1

        cycle.status = 'CLOSED'
        cycle.save()

        self.stdout.write(self.style.SUCCESS(
            f"Successfully published {sent_count} PDF reports to Reviewees via Slack DM for cycle '{cycle.title}'."
        ))
