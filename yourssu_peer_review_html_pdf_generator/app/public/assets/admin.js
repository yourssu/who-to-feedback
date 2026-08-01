(function () {
  "use strict";

  const TextRules = window.YourssuTextRules;

  const state = {
    dataRows: [],
    infoRows: [],
    dataHeaders: [],
    infoHeaders: [],
    mapping: null,
    infoMapping: null,
    connectionErrors: [],
    members: [],
    activeJob: null,
    pollTimer: null
  };

  const $ = function (id) { return document.getElementById(id); };

  function cleanText(value) {
    return TextRules.cleanText(value);
  }

  function normalizeKey(value) {
    return cleanText(value).toLowerCase().replace(/\s+/g, "").replace(/[\n\r_\-()[\]{}.,/\\:;'"~!@#$%^&*+=|?<>]/g, "");
  }

  function normalizeName(value) {
    return cleanText(value).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  function findColumn(headers, candidates, fallbackIndex) {
    const normalized = headers.map(normalizeKey);
    const wanted = candidates.map(normalizeKey).filter(Boolean);
    for (const candidate of wanted) {
      const exactIndex = normalized.indexOf(candidate);
      if (exactIndex >= 0) return headers[exactIndex];
    }
    for (let index = 0; index < normalized.length; index += 1) {
      for (const candidate of wanted) {
        if (candidate.length >= 2 && normalized[index].includes(candidate)) return headers[index];
      }
    }
    return typeof fallbackIndex === "number" && headers[fallbackIndex] ? headers[fallbackIndex] : "";
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  async function readSheet(file) {
    const buffer = await readFile(file);
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  }

  function defaultMapping(headers) {
    const scores = [];
    for (let index = 5; index < 17; index += 1) scores.push(headers[index] || "");
    return {
      team: findColumn(headers, ["팀명", "소속팀", "팀", "파트", "team"], 1),
      name: findColumn(headers, ["닉네임", "이름", "성명", "name", "대상자", "리뷰대상"], 2),
      keyword: findColumn(headers, ["키워드", "keyword"], 4),
      continueText: findColumn(headers, ["keep", "continue", "앞으로도유지", "유지하면좋을", "좋은강점", "강점"], 17),
      improveText: findColumn(headers, ["grow", "improve", "start", "새롭게시도", "시도하면좋을", "성장제안", "개선제안", "보완할점", "아쉬운점"], 18),
      messageText: findColumn(headers, ["message", "메시지", "한마디", "전하는말", "응원"], 19),
      scores: scores
    };
  }

  function infoMapping(headers) {
    return {
      name: findColumn(headers, ["닉네임", "닉네임(발음)", "이름", "성명", "name"], null),
      team: findColumn(headers, ["팀명", "소속팀", "팀", "파트", "team"], null),
      role: findColumn(headers, ["역할", "role", "직무", "포지션"], null)
    };
  }

  function parseScore(value) {
    const number = Number(String(value == null ? "" : value).replace(/[^\d.\-]/g, ""));
    return Number.isFinite(number) ? Math.max(0, Math.min(5, number)) : null;
  }

  function average(values) {
    const numbers = values.map(parseScore).filter(function (value) { return value != null; });
    return numbers.length ? numbers.reduce(function (sum, value) { return sum + value; }, 0) / numbers.length : 0;
  }

  function legacyMeaningful(text, field) {
    const raw = cleanText(text);
    if (!raw) return false;
    const compact = raw.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
    if (!compact || !/[\p{L}\p{N}]/u.test(compact)) return false;

    const exactEmptyAnswers = new Set([
      "없음", "없습니다", "없어요", "없다", "아직없음", "아직없습니다",
      "해당없음", "해당사항없음", "무응답", "패스", "스킵",
      "모름", "모르겠음", "모르겠습니다", "잘모르겠음", "잘모르겠습니다",
      "답변어려움", "답변이어렵습니다", "크게없음", "딱히없음", "별로없음",
      "특별히없음", "별다른내용없음", "별다른내용은없음", "생각나는게없음",
      "생각나지않음", "개선점없음", "개선할점없음", "보완할점없음",
      "아쉬운점없음", "없을것같아요", "없을것같습니다", "없는것같아요",
      "없는것같습니다", "잘모르겠어요", "생각나지않아요", "생각나는것없음",
      "특별히생각나는것없음", "특별히생각나는게없음", "별로없어요",
      "크게없어요", "딱히없어요", "아직은없음", "아직은없습니다",
      "x", "xx", "xxx"
    ]);
    if (exactEmptyAnswers.has(compact)) return false;

    const shortNoContent = compact.length <= 70 && [
      /^(딱히|크게|특별히|별로|아직)?(생각나는|떠오르는)?(내용|점|부분|의견|개선점|보완점|아쉬운점)?(이|은|는)?없/,
      /^(잘)?모르(겠|겠습|겠어|겠네)/,
      /^(답변|판단)(이)?어렵/,
      /^(특별히|딱히|크게)?보이지않/,
      /^현재도?충분히잘하고있어.*없/
    ].some(function (pattern) { return pattern.test(compact); });
    if (shortNoContent) return false;

    const noExperiencePatterns = [
      /함께프로젝트를진행한경험이부족/,
      /같이프로젝트를진행한경험이부족/,
      /함께협업한경험이부족/,
      /같이협업한경험이부족/,
      /함께일한경험이부족/,
      /같이일한경험이부족/,
      /판단할만큼.*(업무|협업|프로젝트)경험이없/,
      /(업무|협업|프로젝트)경험이(없|부족).*(답변|판단).*(어렵|못)/,
      /아직.*(협업|프로젝트|업무).*(해보지못|하지못).*(답변|판단|말씀)/,
      /잘알지못.*(답변|판단).*(어렵|못)/
    ];
    if (noExperiencePatterns.some(function (pattern) { return pattern.test(compact); })) return false;

    if (field === "grow") {
      if (compact.length <= 105 && /^(아직)?(특별히|딱히|크게)?(개선|보완).*(없|못찾|보이지않|발견하지못|느끼지못)/.test(compact)) return false;
      if (compact.length <= 105 && /(특별히|딱히|크게)?.{0,12}(개선|보완).{0,20}(필요|지점|부분).{0,20}(못찾|발견하지못|느끼지못|보이지않|없)/.test(compact)) return false;
      if (compact.length <= 105 && /아직.{0,20}(협업|프로젝트|업무).{0,24}(해보지못|하지못|경험이없).{0,24}(개선|답변|판단|말씀)/.test(compact)) return false;
    }
    return true;
  }

  function meaningful(text, field) {
    const sectionKey = field === "grow" ? "improveTexts" : field;
    return !TextRules.isMeaningless(text, sectionKey);
  }

  function splitKeywords(value) {
    return TextRules.splitKeywords(value);
  }

  function keywordRanking(rows, column) {
    const counts = new Map();
    rows.forEach(function (row) {
      splitKeywords(row[column]).forEach(function (keyword) { counts.set(keyword, (counts.get(keyword) || 0) + 1); });
    });
    return Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0], "ko"); }).map(function (pair) { return pair[0]; });
  }

  function buildInfoMap() {
    const mapping = infoMapping(state.infoHeaders);
    state.infoMapping = mapping;
    const map = new Map();
    const duplicateNames = new Set();
    const errors = [];
    if (!state.infoRows.length) errors.push("info.xlsx가 비어 있습니다.");
    if (!mapping.name) errors.push("info.xlsx에서 닉네임 열을 찾지 못했습니다.");
    if (!mapping.team) errors.push("info.xlsx에서 팀명 열을 찾지 못했습니다.");
    if (errors.length) return { map: map, duplicateNames: duplicateNames, errors: errors, mapping: mapping };
    let lastTeam = "";
    let lastRole = "";
    state.infoRows.forEach(function (row) {
      const name = cleanText(row[mapping.name]);
      const team = cleanText(row[mapping.team]) || lastTeam;
      const role = mapping.role ? (cleanText(row[mapping.role]) || lastRole) : "";
      if (cleanText(row[mapping.team])) lastTeam = cleanText(row[mapping.team]);
      if (mapping.role && cleanText(row[mapping.role])) lastRole = cleanText(row[mapping.role]);
      if (!name) return;
      const key = normalizeName(name);
      if (map.has(key)) duplicateNames.add(key);
      map.set(key, { name: name, team: team, role: role, source: `info.xlsx · ${mapping.team}` });
    });
    duplicateNames.forEach(function (key) {
      errors.push(`info.xlsx에 동일한 닉네임이 중복되어 있습니다: ${map.get(key).name}`);
    });
    return { map: map, duplicateNames: duplicateNames, errors: errors, mapping: mapping };
  }

  function readMapping() {
    const fields = ["team", "name", "keyword", "continueText", "improveText", "messageText"];
    fields.forEach(function (field) { state.mapping[field] = $("map-" + field).value; });
    state.mapping.scores = Array.from({ length: 12 }, function (_, index) { return $("map-score" + index).value; });
  }

  function buildMembers() {
    readMapping();
    const infoResult = buildInfoMap();
    const infoMap = infoResult.map;
    const groups = new Map();
    state.dataRows.forEach(function (row) {
      const rawName = cleanText(row[state.mapping.name]);
      if (!rawName) return;
      const key = normalizeName(rawName);
      if (!groups.has(key)) groups.set(key, { rawName: rawName, rows: [] });
      groups.get(key).rows.push(row);
    });
    state.members = Array.from(groups.entries()).map(function (entry) {
      const key = entry[0];
      const group = entry[1];
      const rows = group.rows;
      const info = infoMap.get(key) || {};
      const connectionErrors = [];
      if (infoResult.duplicateNames.has(key)) connectionErrors.push("info.xlsx에 동일한 닉네임이 두 번 이상 있습니다.");
      if (!info.name) connectionErrors.push("info.xlsx에서 대상자를 찾지 못했습니다.");
      if (info.name && !cleanText(info.team)) connectionErrors.push("info.xlsx의 대상자 팀명이 비어 있습니다.");
      const scores = state.mapping.scores.map(function (column) { return average(rows.map(function (row) { return row[column]; })); });
      return {
        name: info.name || group.rawName,
        dataTeam: cleanText(rows[0][state.mapping.team]),
        infoTeam: info.team || "",
        infoRole: info.role || "",
        connectionSource: info.source || "",
        connectionStatus: connectionErrors.length ? "error" : "ok",
        connectionErrors: connectionErrors,
        reviewCount: rows.length,
        keywords: keywordRanking(rows, state.mapping.keyword),
        scores: scores,
        valueScores: [average(scores.slice(0, 4)), average(scores.slice(4, 8)), average(scores.slice(8, 12))],
        continueTexts: rows.map(function (row) { return cleanText(row[state.mapping.continueText]); }).filter(function (text) { return meaningful(text, "continue"); }),
        improveTexts: rows.map(function (row) { return cleanText(row[state.mapping.improveText]); }).filter(function (text) { return meaningful(text, "grow"); }),
        messageTexts: rows.map(function (row) { return cleanText(row[state.mapping.messageText]); }).filter(function (text) { return meaningful(text, "message"); })
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, "en", { sensitivity: "base" }); });
    state.connectionErrors = infoResult.errors.concat(state.members.flatMap(function (member) {
      return member.connectionErrors.map(function (error) { return `${member.name}: ${error}`; });
    }));
    renderMembers();
  }

  function teamLabel(member) {
    const raw = cleanText(member.infoTeam || "");
    return raw ? (raw.endsWith("팀") ? raw : raw + "팀") : "";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch];
    });
  }

  function renderMembers() {
    const tbody = $("memberRows");
    tbody.innerHTML = state.members.map(function (member, index) {
      const invalid = member.connectionStatus !== "ok";
      const status = invalid ? member.connectionErrors.join(" ") : `연결 완료 · ${member.connectionSource}`;
      return `<tr data-member-index="${index}"><td>${escapeHtml(teamLabel(member) || "확인 필요")}</td><td><strong>${escapeHtml(member.name)}</strong></td><td>${member.reviewCount}건</td><td class="member-keywords">${escapeHtml(member.keywords.slice(0, 6).join(", "))}</td><td class="member-state ${invalid ? "state-error" : "state-ok"}" title="${escapeHtml(status)}">${invalid ? "연결 오류" : "연결 완료"}</td><td><button class="small-button preview-button" data-index="${index}"${invalid ? " disabled" : ""}>미리보기</button><button class="small-button one-button" data-index="${index}"${invalid ? " disabled" : ""}>PDF 재생성</button></td></tr>`;
    }).join("");
    const errorCount = state.connectionErrors.length;
    $("memberSummary").textContent = errorCount
      ? `총 ${state.members.length}명 · 연결 오류 ${errorCount}건. 오류를 해결하기 전에는 생성할 수 없습니다.`
      : `총 ${state.members.length}명 · 모든 대상자가 info.xlsx의 팀명과 연결되었습니다.`;
    $("memberSummary").classList.toggle("connection-error", errorCount > 0);
    $("buildAllBtn").disabled = !state.members.length || errorCount > 0;
    $("memberSection").hidden = false;
    tbody.querySelectorAll(".preview-button").forEach(function (button) { button.addEventListener("click", previewMember); });
    tbody.querySelectorAll(".one-button").forEach(function (button) { button.addEventListener("click", buildOne); });
  }

  function mappingField(id, label, selected) {
    const options = ["<option value=\"\">선택 안 함</option>"].concat(state.dataHeaders.map(function (header) {
      return `<option value="${escapeHtml(header)}"${header === selected ? " selected" : ""}>${escapeHtml(header)}</option>`;
    }));
    const sample = cleanText((state.dataRows[0] || {})[selected]).slice(0, 80);
    return `<div class="mapping-field"><label for="map-${id}">${label}</label><select id="map-${id}">${options.join("")}</select><div class="mapping-sample" id="sample-${id}">${escapeHtml(sample)}</div></div>`;
  }

  function renderMapping() {
    const fields = [
      ["team", "작성자/기본 팀", state.mapping.team], ["name", "대상자 이름", state.mapping.name],
      ["keyword", "키워드", state.mapping.keyword], ["continueText", "Continue", state.mapping.continueText],
      ["improveText", "Improve/Start", state.mapping.improveText], ["messageText", "Message", state.mapping.messageText]
    ];
    const html = fields.map(function (item) { return mappingField(item[0], item[1], item[2]); });
    for (let index = 0; index < 12; index += 1) html.push(mappingField("score" + index, "점수 문항 " + (index + 1), state.mapping.scores[index]));
    $("mappingGrid").innerHTML = html.join("");
    const detectedInfo = infoMapping(state.infoHeaders);
    $("infoMappingSummary").innerHTML = detectedInfo.name && detectedInfo.team
      ? `<strong>info.xlsx 연결 기준</strong><span>이름: ${escapeHtml(detectedInfo.name)}</span><span>팀: ${escapeHtml(detectedInfo.team)}</span><span>빈 팀 셀은 위 값을 이어받습니다.</span>`
      : `<strong>info.xlsx 연결 오류</strong><span>닉네임과 팀명 열을 확인해 주세요.</span>`;
    $("infoMappingSummary").classList.toggle("error", !(detectedInfo.name && detectedInfo.team));
    $("mappingSection").hidden = false;
    $("mappingGrid").querySelectorAll("select").forEach(function (select) {
      select.addEventListener("change", function () {
        const sampleId = select.id.replace("map-", "sample-");
        $(sampleId).textContent = cleanText((state.dataRows[0] || {})[select.value]).slice(0, 80);
        buildMembers();
      });
    });
  }

  function fileNameChanged(input, output) {
    $(output).textContent = input.files[0] ? input.files[0].name : "파일 선택";
    $("analyzeBtn").disabled = !$("dataFile").files[0] || !$("infoFile").files[0];
  }

  async function analyzeFiles() {
    $("analyzeBtn").disabled = true;
    $("analyzeStatus").textContent = "엑셀을 읽는 중입니다.";
    try {
      if (!$("infoFile").files[0]) throw new Error("정확한 팀 연결을 위해 info.xlsx가 반드시 필요합니다.");
      state.dataRows = await readSheet($("dataFile").files[0]);
      state.infoRows = await readSheet($("infoFile").files[0]);
      state.dataHeaders = state.dataRows.length ? Object.keys(state.dataRows[0]) : [];
      state.infoHeaders = state.infoRows.length ? Object.keys(state.infoRows[0]) : [];
      if (!state.dataHeaders.length) throw new Error("data.xlsx에서 헤더를 찾지 못했습니다.");
      if (!state.infoHeaders.length) throw new Error("info.xlsx에서 헤더를 찾지 못했습니다.");
      state.mapping = defaultMapping(state.dataHeaders);
      renderMapping();
      buildMembers();
      $("analyzeStatus").textContent = state.connectionErrors.length
        ? `응답 ${state.dataRows.length}건 · 연결 오류 ${state.connectionErrors.length}건`
        : `응답 ${state.dataRows.length}건 · 대상자 팀 연결 완료`;
    } catch (error) {
      showToast(error.message);
      $("analyzeStatus").textContent = "분석 실패";
    } finally {
      $("analyzeBtn").disabled = false;
    }
  }

  async function api(path, options) {
    const response = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "요청을 처리하지 못했습니다.");
    return data;
  }

  async function previewMember(event) {
    const member = state.members[Number(event.currentTarget.dataset.index)];
    if (!member || member.connectionStatus !== "ok") return showToast("info.xlsx 팀 연결 오류를 먼저 해결해 주세요.");
    const previewWindow = window.open("about:blank", "_blank");
    try {
      const result = await api("/api/preview", { method: "POST", body: JSON.stringify({ member: member }) });
      previewWindow.location.href = result.url;
    } catch (error) {
      if (previewWindow) previewWindow.close();
      showToast(error.message);
    }
  }

  async function buildOne(event) {
    const index = Number(event.currentTarget.dataset.index);
    await startJob([state.members[index]], true);
  }

  async function buildAll() {
    if (state.connectionErrors.length) return showToast("대상자 팀 연결 오류를 모두 해결한 뒤 생성해 주세요.");
    await startJob(state.members, false);
  }

  function setRowState(name, text, className) {
    const index = state.members.findIndex(function (member) { return member.name === name; });
    if (index < 0) return;
    const cell = document.querySelector(`tr[data-member-index="${index}"] .member-state`);
    cell.textContent = text;
    cell.className = "member-state " + className;
  }

  async function startJob(members, individual) {
    if (state.activeJob) return;
    const invalid = members.filter(function (member) { return member.connectionStatus !== "ok" || !cleanText(member.infoTeam); });
    if (invalid.length) return showToast(`팀 연결이 확인되지 않은 대상자가 있습니다: ${invalid.map(function (member) { return member.name; }).join(", ")}`);
    $("buildAllBtn").disabled = true;
    $("cancelBtn").hidden = false;
    $("progressWrap").hidden = false;
    members.forEach(function (member) { setRowState(member.name, "생성 대기", "state-running"); });
    try {
      const result = await api("/api/jobs", { method: "POST", body: JSON.stringify({ members: members, individual: individual }) });
      state.activeJob = result.jobId;
      pollJob(result.jobId);
    } catch (error) {
      resetJobUi();
      showToast(error.message);
    }
  }

  async function pollJob(jobId) {
    try {
      const job = await api("/api/jobs/" + encodeURIComponent(jobId));
      const total = Math.max(1, job.total);
      const percent = Math.round(job.completed / total * 100);
      $("progressBar").style.width = percent + "%";
      $("progressText").textContent = job.message || `${job.completed} / ${job.total}`;
      (job.results || []).forEach(function (result) {
        setRowState(result.name, result.ok ? "검증 완료" : "오류", result.ok ? "state-ok" : "state-error");
      });
      if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
        renderValidation(job);
        if (job.status === "complete" && job.downloadUrl) {
          const link = document.createElement("a");
          link.href = job.downloadUrl;
          link.download = "";
          document.body.appendChild(link);
          link.click();
          link.remove();
        }
        if (job.status === "failed") showToast(job.error || "생성에 실패했습니다.");
        resetJobUi();
        return;
      }
      state.pollTimer = setTimeout(function () { pollJob(jobId); }, 700);
    } catch (error) {
      showToast(error.message);
      resetJobUi();
    }
  }

  function renderValidation(job) {
    $("validationSection").hidden = false;
    const results = job.results || [];
    const ok = results.filter(function (item) { return item.ok; }).length;
    const failed = results.length - ok;
    $("validationSummary").innerHTML = `<span class="summary-chip">성공 ${ok}명</span><span class="summary-chip">오류 ${failed}명</span><span class="summary-chip">PDF ${results.reduce(function (sum, item) { return sum + (item.pageCount || 0); }, 0)}페이지</span>`;
    $("validationList").innerHTML = results.map(function (result) {
      const errors = (result.errors || []).map(function (error) { return `${error.type}${error.page ? " · " + error.page + "페이지" : ""}`; }).join(", ");
      return `<div class="validation-item${result.ok ? "" : " error"}"><strong>${escapeHtml(result.name)}</strong>${result.ok ? `HTML/PDF 검증 완료 · ${result.pageCount}페이지` : escapeHtml(errors || "생성 실패")}</div>`;
    }).join("");
  }

  async function cancelJob() {
    if (!state.activeJob) return;
    try { await api("/api/jobs/" + encodeURIComponent(state.activeJob) + "/cancel", { method: "POST", body: "{}" }); }
    catch (error) { showToast(error.message); }
  }

  function resetJobUi() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.activeJob = null;
    $("buildAllBtn").disabled = !state.members.length || state.connectionErrors.length > 0;
    $("cancelBtn").hidden = true;
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, 5000);
  }

  $("dataFile").addEventListener("change", function () { fileNameChanged($("dataFile"), "dataFileName"); });
  $("infoFile").addEventListener("change", function () { fileNameChanged($("infoFile"), "infoFileName"); });
  $("analyzeBtn").addEventListener("click", analyzeFiles);
  $("buildAllBtn").addEventListener("click", buildAll);
  $("cancelBtn").addEventListener("click", cancelJob);
})();
