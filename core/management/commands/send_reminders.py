from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from core.models import ReviewCycle, Member
from core.services.slack_service import SlackService


class Command(BaseCommand):
    help = "피어리뷰 미작성자에게 미작성 대상 동료 이름을 명시하여 Slack DM 독촉 리마인더를 보냅니다."

    def add_arguments(self, parser):
        parser.add_argument('--cycle-id', type=int, required=True, help="피어리뷰 회차 ID")

    def handle(self, *args, **options):
        cycle_id = options['cycle_id']
        try:
            cycle = ReviewCycle.objects.get(id=cycle_id)
        except ReviewCycle.DoesNotExist:
            raise CommandError(f"ReviewCycle with ID {cycle_id} does not exist.")

        unsubmitted_assignments = cycle.assignments.filter(is_submitted=False)
        if not unsubmitted_assignments.exists():
            self.stdout.write(self.style.SUCCESS(f"All reviews in cycle '{cycle.title}' are already submitted! No reminders needed."))
            return

        reviewers = set(a.reviewer for a in unsubmitted_assignments)
        slack = SlackService()
        sent_count = 0

        for r in reviewers:
            unsubmitted_reviewees = [a.reviewee for a in unsubmitted_assignments if a.reviewer == r]
            success, _ = slack.send_reminder_dm(r, unsubmitted_reviewees)
            if success:
                sent_count += 1
                # 마인드 시각 갱신
                cycle.assignments.filter(reviewer=r, is_submitted=False).update(last_reminded_at=timezone.now())

        self.stdout.write(self.style.SUCCESS(
            f"Sent reminder DMs (with unsubmitted reviewee names) to {sent_count} reviewers in cycle '{cycle.title}'."
        ))
