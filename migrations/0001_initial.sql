PRAGMA foreign_keys = ON;

-- 1. 관리자 계정
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE CHECK (length(trim(username)) BETWEEN 1 AND 50),
    email TEXT NOT NULL UNIQUE CHECK (length(trim(email)) BETWEEN 3 AND 254),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 2. 팀원 (리뷰어 및 피평가자)
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 50),
    email TEXT NOT NULL UNIQUE CHECK (length(trim(email)) BETWEEN 3 AND 254),
    department TEXT NOT NULL DEFAULT '' CHECK (length(department) <= 100),
    slack_user_id TEXT NOT NULL DEFAULT '' CHECK (length(slack_user_id) <= 50),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 3. 피어리뷰 회차
CREATE TABLE IF NOT EXISTS cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'CLOSED')),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    reviewer_notice_message TEXT NOT NULL DEFAULT '본인에게 배정된 리뷰만 표시되며 관리자 기능에는 접근할 수 없습니다.' CHECK (length(reviewer_notice_message) <= 5000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_at > start_at)
);

-- 4. 설문 문항
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL CHECK (display_order BETWEEN 1 AND 1000),
    question_type TEXT NOT NULL CHECK (question_type IN ('RATING', 'TEXT', 'SINGLE_CHOICE', 'MULTIPLE_CHOICE')),
    scale_type TEXT NOT NULL DEFAULT 'NUMERIC_5' CHECK (scale_type IN ('NUMERIC_5', 'TEXT_5')),
    category TEXT NOT NULL DEFAULT '기본 역량' CHECK (length(trim(category)) BETWEEN 1 AND 100),
    content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 5000),
    image_r2_key TEXT,
    created_at TEXT NOT NULL
);

-- 5. 객관식 문항 선택지
CREATE TABLE IF NOT EXISTS question_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL CHECK (display_order >= 1),
    option_text TEXT NOT NULL CHECK (length(trim(option_text)) BETWEEN 1 AND 200),
    UNIQUE (question_id, option_text)
);

-- 6. 리뷰 매칭 (배정)
CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
    reviewee_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
    is_submitted INTEGER NOT NULL DEFAULT 0 CHECK (is_submitted IN (0, 1)),
    submitted_at TEXT,
    draft_data TEXT CHECK (draft_data IS NULL OR length(draft_data) <= 102400),
    draft_saved_at TEXT,
    last_reminded_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (cycle_id, reviewer_id, reviewee_id),
    CHECK (reviewer_id <> reviewee_id)
);

-- 7. 제출된 답변
CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    rating_value INTEGER CHECK (rating_value IS NULL OR (rating_value BETWEEN 1 AND 5)),
    answer_text TEXT CHECK (answer_text IS NULL OR length(answer_text) <= 2000),
    created_at TEXT NOT NULL,
    UNIQUE (assignment_id, question_id)
);

-- 8. 제출된 객관식 선택 답변 매핑
CREATE TABLE IF NOT EXISTS answer_options (
    answer_id INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES question_options(id) ON DELETE CASCADE,
    PRIMARY KEY (answer_id, option_id)
);

-- 9. 리뷰어 회차별 6자리 인증 PIN
CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (length(code) = 6),
    code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (cycle_id, member_id)
);

-- 10. 피평가자별 결과 리포트 메타데이터
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    reviewee_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    generation_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (generation_status IN ('PENDING', 'READY', 'FAILED')),
    approval_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW' CHECK (approval_status IN ('NEEDS_REVIEW', 'APPROVED', 'SENT')),
    html_r2_key TEXT,
    pdf_r2_key TEXT,
    content_hash TEXT,
    approved_hash TEXT,
    error_message TEXT NOT NULL DEFAULT '',
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cycle_id, reviewee_id)
);

-- 11. Slack DM 발송 작업 및 이력
CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
    delivery_type TEXT NOT NULL CHECK (delivery_type IN ('PIN_ISSUE', 'REMINDER', 'REPORT')),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
    dedupe_key TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error_message TEXT NOT NULL DEFAULT '',
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 12. 인증 세션
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'REVIEWER')),
    admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
    member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
    cycle_id INTEGER REFERENCES cycles(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
        (role = 'ADMIN' AND admin_id IS NOT NULL AND member_id IS NULL AND cycle_id IS NULL) OR
        (role = 'REVIEWER' AND member_id IS NOT NULL AND cycle_id IS NOT NULL AND admin_id IS NULL)
    )
);

-- 13. 로그인 시도 제한 (Rate Limit)
CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

-- 인덱스 정의
CREATE INDEX IF NOT EXISTS idx_questions_cycle_order ON questions(cycle_id, display_order, id);
CREATE INDEX IF NOT EXISTS idx_question_options_question_order ON question_options(question_id, display_order, id);
CREATE INDEX IF NOT EXISTS idx_assignments_cycle_reviewer ON assignments(cycle_id, reviewer_id);
CREATE INDEX IF NOT EXISTS idx_assignments_cycle_reviewee ON assignments(cycle_id, reviewee_id);
CREATE INDEX IF NOT EXISTS idx_answers_assignment ON answers(assignment_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_reports_cycle_status ON reports(cycle_id, generation_status, approval_status);
CREATE INDEX IF NOT EXISTS idx_deliveries_cycle_status ON deliveries(cycle_id, status, delivery_type);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
