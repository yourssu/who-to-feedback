(function (root) {
  "use strict";

  function cleanText(value) {
    return String(value == null ? "" : value)
      .normalize("NFKC")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function semanticKey(value) {
    return cleanText(value).toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
  }

  function hasSemanticContent(value) {
    return /[\p{L}\p{N}]/u.test(cleanText(value));
  }

  function isReactionOnly(value) {
    const compact = cleanText(value).replace(/\s+/g, "");
    if (!compact) return true;

    // Standalone punctuation, emoticons, emoji, laughter and crying reactions do
    // not carry review content. Keep the same characters when they accompany an
    // actual sentence, but discard them when nothing semantic remains.
    const withoutVisualReactions = compact
      .replace(/[ㅋㅎㅠㅜᄏ휴ᅮ]+/gu, "")
      .replace(/(?:\^+[_-]?\^+|[;:]?[-'`^]?[()DPpOo/\\]+)/gu, "")
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
      .replace(/[\p{P}\p{S}_~…·]+/gu, "");

    if (!withoutVisualReactions || !/[\p{L}\p{N}]/u.test(withoutVisualReactions)) return true;
    return /^(?:[ㅋㅎㅠㅜᄏ휴ᅮ]+|(?:크+|흐+|하+){1,3})$/u.test(compact);
  }

  const EXACT_EMPTY = new Set([
    "없음", "없습니다", "없어요", "없다", "해당없음", "해당사항없음", "무응답", "패스", "스킵",
    "모름", "모르겠음", "모르겠습니다", "잘모르겠음", "잘모르겠습니다", "답변어려움", "답변하기어려움",
    "판단어려움", "평가어려움", "말하기어려움", "크게없음", "딱히없음", "별로없음", "특별히없음",
    "별다른내용없음", "별다른내용이없음", "생각나는게없음", "생각나는것이없음", "생각하지않음",
    "개선점없음", "개선할점없음", "보완할점없음", "아쉬운점없음", "없을것같아요", "없을것같습니다",
    "없는것같아요", "없는것같습니다", "없는거같아요", "없는거같습니다", "없을거같아요", "없을거같습니다",
    "없다고생각합니다", "현재도잘하고있습니다", "지금도잘하고있어요",
    "잘하고있습니다", "잘하고있어요", "같습니다", "그런것같아요", "그런것같습니다",
    "크게없어요", "딱히없어요", "특별히없어요", "아직은없음", "아직은없습니다",
    "x", "xx", "xxx", "na", "none", "null"
  ]);

  const NO_EXPERIENCE_PATTERNS = [
    /(?:함께|같이).{0,12}(?:프로젝트|협업|작업|업무).{0,18}(?:경험|진행).{0,16}(?:없|부족)/,
    /(?:프로젝트|협업|작업|업무).{0,18}(?:경험|진행).{0,16}(?:없|부족).{0,18}(?:판단|답변|평가|말).{0,12}(?:어렵|못|모르)/,
    /(?:함께|같이).{0,12}(?:일한|활동한|진행한).{0,16}(?:경험|적).{0,12}(?:없|부족)/,
    /(?:판단|평가)할만큼.{0,18}(?:업무|협업|프로젝트).{0,12}경험.{0,12}(?:없|부족)/,
    /아직.{0,18}(?:협업|프로젝트|작업|업무).{0,18}(?:해보지|진행하지|경험하지).{0,18}(?:못|않)/,
    /(?:잘|자세히).{0,8}(?:알지|모르).{0,16}(?:판단|답변|평가|말).{0,12}(?:어렵|못)/
  ];

  const EMPTY_SENTENCE_PATTERNS = [
    /^(?:딱히|크게|별로|특별히|아직)?(?:생각나는|떠오르는)?(?:내용|부분|점|개선점|보완점|아쉬운점)?(?:이|은|는)?(?:없|모르)(?:어요|습니다|네요|음|다)?$/,
    /^(?:현재|지금)?(?:도)?(?:충분히)?잘(?:하고|해주고)(?:있|계시)(?:어요|습니다|네요)?$/,
    /^(?:잘|자세히)모르(?:겠|는)(?:어요|습니다|네요|음)?$/,
    /^(?:답변|판단|평가|말)(?:하기|드리기)?(?:가)?어렵(?:습니다|네요|다|음)?$/,
    /^(?:정말|사실|딱히|크게|별다른|특별히|아직)?(?:쓸|드릴|말할)?(?:내용|부분|점|개선점|보완점|아쉬운점)?(?:이|은|는|을)?(?:없|모르).{0,28}(?:지금|현재)?(?:도)?(?:너무|정말)?잘(?:하고|해주고)(?:있|계시)(?:어요|습니다|네요)?$/
  ];

  function isMeaningless(value, sectionKey) {
    const text = cleanText(value);
    if (!text || isReactionOnly(text)) return true;
    const key = semanticKey(text);
    if (!key || EXACT_EMPTY.has(key)) return true;
    if (EMPTY_SENTENCE_PATTERNS.some(function (pattern) { return pattern.test(key); })) return true;
    if (key.length <= 120 && NO_EXPERIENCE_PATTERNS.some(function (pattern) { return pattern.test(key); })) return true;

    if (sectionKey === "improveTexts" || sectionKey === "grow") {
      if (key.length <= 120 && /^(?:현재|지금|아직)?(?:도)?(?:충분히)?(?:잘하고|잘해주고|좋은모습을보이고).{0,20}(?:개선|보완|바꿀|고칠).{0,18}(?:점|부분|필요).{0,18}(?:없|못찾|보이지않|발견하지못)/.test(key)) return true;
      if (key.length <= 120 && /(?:특별히|딱히|크게).{0,14}(?:개선|보완|고칠).{0,18}(?:점|부분|필요).{0,18}(?:없|못찾|보이지않)/.test(key)) return true;
    }
    return false;
  }

  function splitKeywords(value) {
    return cleanText(value)
      .split(/[,，、\n/]+/g)
      .map(cleanText)
      .filter(function (keyword) { return keyword && !isReactionOnly(keyword); });
  }

  root.YourssuTextRules = {
    cleanText: cleanText,
    semanticKey: semanticKey,
    hasSemanticContent: hasSemanticContent,
    isMeaningless: isMeaningless,
    splitKeywords: splitKeywords
  };
})(window);
