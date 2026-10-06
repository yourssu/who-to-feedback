import type { CycleView } from "../models";
export type DashboardViewModel =
  | {
      history_mode: true;
      cycle: CycleView;
      version_logs: {
        version: string;
        changed_summary: string;
        created_at: string;
      }[];
      cycles_data: [];
    }
  | {
      history_mode?: false;
      cycles_data: {
        cycle: CycleView;
        unsubmitted_reviewers_count: number;
      }[];
    };
export type TemplateName =
  | "admin_custom/dashboard.html"
  | "admin_custom/members.html"
  | "admin_custom/questions.html"
  | "admin_custom/assignments.html"
  | "admin_custom/status.html"
  | "admin_custom/reports.html"
  | "admin_custom/validation.html"
  | "admin_custom/send_message.html"
  | "auth/setup.html"
  | "auth/login.html"
  | "admin/login.html"
  | "review/dashboard.html"
  | "review/form.html";
