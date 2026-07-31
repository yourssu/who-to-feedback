from django.core.management.base import BaseCommand, CommandError
from core.models import ReviewCycle, Member, ReviewAuthCode
from core.services.slack_service import SlackService


class Command(BaseCommand):
    help = "피어리뷰 회차를 시작하고 각 리뷰어에게 6자리 PIN 코드 Slack DM을 발송합니다."

    def add_arguments(self, parser):
        parser.add_argument('--cycle-id', type=int, required=True, help="피어리뷰 회차 ID")

    def handle(self, *args, **options):
        cycle_id = options['cycle_id']
        try:
            cycle = ReviewCycle.objects.get(id=cycle_id)
        except ReviewCycle.DoesNotExist:
            raise CommandError(f"ReviewCycle with ID {cycle_id} does not exist.")

        cycle.status = 'ACTIVE'
        cycle.save()

        slack = SlackService()
        reviewers = Member.objects.filter(given_reviews__cycle=cycle).distinct()
        sent_count = 0

        for reviewer in reviewers:
            auth_code = ReviewAuthCode.generate_code_for(reviewer, cycle)
            success, _ = slack.send_auth_code_dm(reviewer, auth_code.code)
            if success:
                sent_count += 1

        self.stdout.write(self.style.SUCCESS(
            f"Successfully started ReviewCycle '{cycle.title}'. Sent auth code DMs to {sent_count}/{reviewers.count()} reviewers."
        ))
