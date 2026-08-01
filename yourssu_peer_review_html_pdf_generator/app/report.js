"use strict";

const VALUE_CONFIG = [
  {
    key: "active",
    number: "①",
    title: "Active Ownership",
    subtitle: "스스로 만드는 기회, 주도적인 실행",
    color: "#2B2D6E",
    start: 0,
    items: [
      ["주도성", "맡은 역할에 국한되지 않고, 팀이나 서비스에 필요한 문제를 스스로 발견한다."],
      ["도전", "업무와 관련된 아이디어를 적극적으로 제안한다."],
      ["실행력", "제안한 아이디어를 실제 실행까지 이어가려고 노력한다."],
      ["책임감", "맡은 일에 대해 끝까지 높은 책임감을 가지고 임한다."]
    ]
  },
  {
    key: "deep",
    number: "②",
    title: "Deep Immersion",
    subtitle: "끝까지 파고드는 집요한 몰입",
    color: "#8B7CE8",
    start: 4,
    items: [
      ["본질적 사고", "단순히 주어진 업무만 수행하는 것이 아니라, 그 맥락과 목적까지 이해하려 한다."],
      ["분석력", "문제의 근본 원인과 구조를 깊이 있게 분석하려고 노력한다."],
      ["탐색 능력", "어려운 상황에서도 문제를 해결하기 위해 다양한 방법을 끝까지 탐색한다."],
      ["메타적 몰입", "프로젝트에 필요한 지식과 기술을 스스로 학습한다."]
    ]
  },
  {
    key: "mutual",
    number: "③",
    title: "Mutual Growth",
    subtitle: "서로가 동력이 되는 유기적인 성장",
    color: "#C99410",
    start: 8,
    items: [
      ["조직적 사고", "팀 전체의 성장을 위해 주변을 돕거나 함께 성장할 수 있는 행동을 한다."],
      ["피드백 제공", "더 나은 협업과 성장을 위해 적절한 피드백을 주도적으로 제공한다."],
      ["피드백 수용", "피드백을 방어적으로 받아들이지 않고 성장의 기회로 활용한다."],
      ["소통·시너지", "협업 과정에서 원활하게 소통하며 긍정적인 시너지를 만든다."]
    ]
  }
];

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[ch]);
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}

function fmtScore(value) {
  const num = Number(value || 0);
  return (Math.round(num * 10) / 10).toFixed(1);
}

function visualLength(value) {
  return Array.from(String(value || "")).reduce((sum, ch) => {
    if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch)) return sum + 1;
    if (/\s/.test(ch)) return sum + 0.4;
    return sum + 0.62;
  }, 0);
}

function coverSize(value) {
  const length = visualLength(value);
  if (length > 30) return 42;
  if (length > 24) return 48;
  if (length > 19) return 54;
  return 62;
}

function teamLabel(member) {
  const raw = String(member.infoTeam || "").trim();
  if (!raw) return "";
  return raw.endsWith("팀") ? raw : `${raw}팀`;
}

function coverTitle(member) {
  const team = teamLabel(member);
  return team ? `${team} ${member.name}` : String(member.name || "");
}

function pageShell({ section, number = "", extraClass = "", content, pageId }) {
  return `<section class="report-page ${extraClass}" data-page-id="${escapeHtml(pageId || section)}">
    ${content}
    <footer class="page-footer" data-safe-container>
      <span>Yourssu HR · 2026 Peer Review</span>
      <span>${escapeHtml(section)}</span>
      <span class="page-number">${escapeHtml(number)}</span>
    </footer>
  </section>`;
}

function coverPage(member) {
  const title = coverTitle(member);
  return pageShell({
    section: "Cover",
    pageId: "cover",
    extraClass: "cover-page lavender-page",
    content: `<div class="cover-content" data-safe-container>
      <div class="cover-kicker safe-element">2026 YOURSSU PEER-REVIEW REPORT</div>
      <div class="cover-report-pill safe-element">PERSONAL REPORT</div>
      <div class="brand-mark safe-element" aria-hidden="true">
        <span class="brand-circle brand-circle-indigo"></span>
        <span class="brand-circle brand-circle-purple"></span>
        <span class="brand-triangle"></span>
      </div>
      <div class="cover-copy safe-element">
        <h1 style="font-size:${coverSize(title)}px">${escapeHtml(title)}</h1>
        <p>동료의 시선으로 돌아보는 나의 강점과 성장 방향</p>
        <span class="cover-accent" aria-hidden="true"></span>
      </div>
      <nav class="cover-index safe-element" aria-label="리포트 구성">
        <span>KEYWORDS</span><span>CORE VALUES</span><span>CONTINUE</span>
        <span>IMPROVE / START</span><span>MESSAGE</span>
      </nav>
      <div class="cover-confidential safe-element">CONFIDENTIAL</div>
    </div>`
  });
}

function keywordPills(keywords) {
  return (keywords || []).map((keyword, index) => {
    const length = visualLength(keyword);
    const fontSize = length > 18 ? 14 : length > 13 ? 15 : 17;
    const width = Math.max(130, Math.min(360, Math.round(length * fontSize + 62)));
    const tone = ["indigo", "soft", "purple", "gold"][index % 4];
    return `<span class="keyword-pill keyword-${tone}" style="width:${width}px;font-size:${fontSize}px" data-check-overflow>${escapeHtml(keyword)}</span>`;
  }).join("");
}

function keywordPage(member) {
  const name = escapeHtml(member.name);
  return pageShell({
    section: "Keywords",
    pageId: "keywords",
    content: `<div class="page-heading" data-safe-container>
      <div class="eyebrow safe-element">01. KEYWORDS</div>
      <h2 class="safe-element">멤버들이 바라본, 나를 표현하는 키워드</h2>
      <p class="heading-subtitle safe-element">핵심 키워드 요약</p>
    </div>
    <div class="keyword-zone" data-safe-container data-check-overflow>
      ${keywordPills(member.keywords)}
    </div>
    <div class="keyword-message" data-safe-container data-check-overflow>
      <p><span aria-hidden="true">🎯</span> ${name}은 동료들에게 유기적인 성장의 원동력이자 든든한 시너지를 전하는 유어슈의 핵심 멤버입니다.<br>
      팀원들이 남겨준 소중한 키워드를 원동력 삼아 다음 학기에도 더 큰 성장의 발자국을 함께 만들어가기를 기대합니다.</p>
    </div>`
  });
}

function point(cx, cy, radius, angle, value) {
  const distance = radius * Math.max(0, Math.min(5, Number(value || 0))) / 5;
  const rad = angle * Math.PI / 180;
  return [cx + Math.cos(rad) * distance, cy + Math.sin(rad) * distance];
}

function radarSvg(member) {
  const values = member.valueScores || [0, 0, 0];
  const cx = 320, cy = 235, radius = 185;
  const angles = [-90, 150, 30];
  const rings = [1, 2, 3, 4, 5].map((level) => {
    const pts = angles.map((angle) => point(cx, cy, radius, angle, level).map((n) => n.toFixed(1)).join(",")).join(" ");
    return `<polygon points="${pts}" fill="none" stroke="#D8D3F3" stroke-width="1.5"/>`;
  }).join("");
  const dataPoints = angles.map((angle, index) => point(cx, cy, radius, angle, values[index]));
  const polygon = dataPoints.map((pt) => pt.map((n) => n.toFixed(1)).join(",")).join(" ");
  const dots = dataPoints.map((pt) => `<circle cx="${pt[0].toFixed(1)}" cy="${pt[1].toFixed(1)}" r="6" fill="#2B2D6E" stroke="#FFFFFF" stroke-width="3"/>`).join("");
  return `<svg class="radar-svg" viewBox="0 0 640 470" role="img" aria-label="핵심 가치 점수 삼각형">
    ${rings}
    <line x1="320" y1="235" x2="320" y2="50" stroke="#E3E0F5"/>
    <line x1="320" y1="235" x2="159.8" y2="327.5" stroke="#E3E0F5"/>
    <line x1="320" y1="235" x2="480.2" y2="327.5" stroke="#E3E0F5"/>
    <polygon points="${polygon}" fill="#8B7CE8" fill-opacity="0.18" stroke="#2B2D6E" stroke-width="4" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

function radarPage(member) {
  const values = member.valueScores || [0, 0, 0];
  return pageShell({
    section: "Core Values",
    pageId: "radar",
    content: `<div class="page-heading" data-safe-container>
      <div class="eyebrow safe-element">02. CORE VALUES</div>
      <h2 class="safe-element">유어슈 핵심 가치와의 정합성</h2>
    </div>
    <div class="radar-panel" data-safe-container>
      <div class="radar-label radar-label-top" data-check-overflow><strong>Active Ownership</strong><span>${fmtScore(values[0])}</span></div>
      ${radarSvg(member)}
      <div class="radar-label radar-label-left" data-check-overflow><strong>Deep Immersion</strong><span>${fmtScore(values[1])}</span></div>
      <div class="radar-label radar-label-right" data-check-overflow><strong>Mutual Growth</strong><span>${fmtScore(values[2])}</span></div>
    </div>`
  });
}

function metricRows(config, scores) {
  return config.items.map((item, index) => {
    const value = Number(scores[config.start + index] || 0);
    const width = Math.max(0, Math.min(100, value / 5 * 100));
    return `<div class="metric-row" style="--metric-color:${config.color}" data-safe-container>
      <div class="metric-copy" data-check-overflow>
        <strong>${escapeHtml(item[0])}</strong><span>${escapeHtml(item[1])}</span>
      </div>
      <div class="metric-line">
        <div class="metric-track" aria-label="5점 만점 중 ${fmtScore(value)}점">
          <span class="metric-fill" style="width:${width}%"></span>
          <i style="left:20%"></i><i style="left:40%"></i><i style="left:60%"></i><i style="left:80%"></i>
        </div>
        <span class="metric-score">${fmtScore(value)}</span>
      </div>
    </div>`;
  }).join("");
}

function metricPage(config, member) {
  return pageShell({
    section: config.title,
    pageId: `metric-${config.key}`,
    content: `<div class="metric-heading" data-safe-container>
      <div class="metric-kicker safe-element">2026-1 YOURSSU PEER-REVIEW</div>
      <h2 class="safe-element">핵심가치 지표 ${config.number} <span style="color:${config.color}">${config.title}</span></h2>
      <p class="safe-element">${config.subtitle}</p>
    </div>
    <div class="metrics-panel" data-safe-container>
      ${metricRows(config, member.scores || [])}
    </div>`
  });
}

function closingPage(member) {
  const name = escapeHtml(member.name);
  return pageShell({
    section: "Closing",
    pageId: "closing",
    extraClass: "closing-page lavender-page",
    content: `<div class="closing-top"><span>2026-1 YOURSSU PEER-REVIEW</span><span>END</span></div>
      <div class="closing-card" data-safe-container>
        <div class="closing-accent"></div>
        <div class="closing-pill">Letter to ${name}</div>
        <h2>“하나의 학기 동안 유어슈(YOURSSU)에 새겨주신<br>뜨거운 열정과 아낌없는 헌신에 깊이 감사드립니다.”</h2>
        <p>우리가 마주했던 수많은 치열한 고민의 순간들을 동아리를 넘어<br>${name} 자신을 한 단계 더 단단하게 채워줄 소중한 자산이 되었을 것입니다.</p>
        <p>동료들이 마음을 다해 전해온 솔직하고 따뜻한 시선들을 디딤돌 삼아,<br>앞으로 펼쳐질 여정에서도 언제나 멋지게 빛나기를 유어슈가 늘 응원하겠습니다.</p>
        <strong>YOURSSU HR TEAM</strong>
      </div>`
  });
}

function renderReportHtml(member) {
  const reportData = {
    member: {
      name: member.name,
      continueTexts: member.continueTexts || [],
      improveTexts: member.improveTexts || [],
      messageTexts: member.messageTexts || []
    }
  };
  const fixedPages = [
    coverPage(member),
    keywordPage(member),
    radarPage(member),
    ...VALUE_CONFIG.map((config) => metricPage(config, member)),
    `<div id="comment-pages-anchor"></div>`,
    closingPage(member)
  ].join("\n");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(member.name)} · Yourssu Peer Review</title>
  <link rel="stylesheet" href="assets/report.css">
</head>
<body>
  <main id="report-root">${fixedPages}</main>
  <script id="report-data" type="application/json">${jsonForScript(reportData)}</script>
  <script src="assets/text-rules.js"></script>
  <script src="assets/report-runtime.js"></script>
</body>
</html>`;
}

module.exports = { renderReportHtml, VALUE_CONFIG };
