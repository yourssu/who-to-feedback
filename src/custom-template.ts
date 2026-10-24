import type { Row } from "./repository";
type Node =
  | { type: "text"; value: string }
  | { type: "value"; value: string }
  | { type: "if" | "for"; value: string; children: Node[]; alternate: Node[] };
function parse(source: string): Node[] {
  if (new TextEncoder().encode(source).length > 1024 * 1024)
    throw new Error("HTML 양식은 최대 1MB입니다.");
  const root: Node[] = [],
    stack: {
      node: Extract<Node, { children: Node[] }>;
      parent: Node[];
      elseSeen: boolean;
    }[] = [];
  let current = root;
  for (const token of source.split(
    /({{[\s\S]*?}}|{%[\s\S]*?%}|{#[\s\S]*?#})/g,
  )) {
    if (token.startsWith("{#")) continue;
    if (!token.startsWith("{{") && !token.startsWith("{%")) {
      current.push({ type: "text", value: token });
      continue;
    }
    const value = token.slice(2, -2).trim();
    if (
      /[()[\]{};`\\]|__|\b(?:constructor|prototype|attr|safe|range|cycler|joiner|self|super)\b/.test(
        value,
      )
    )
      throw new Error("지원하지 않는 템플릿 표현식입니다.");
    if (token.startsWith("{{")) {
      if (!/^[\w.]+$/.test(value)) throw new Error("변수 표현식만 지원합니다.");
      current.push({ type: "value", value });
      continue;
    }
    if (/^(for\s+\w+\s+in\s+[\w.]+|if\s+(?:not\s+)?[\w.]+)$/.test(value)) {
      if (stack.length >= 32) throw new Error("양식 중첩 한도를 초과했습니다.");
      const node = {
        type: value.startsWith("for ") ? ("for" as const) : ("if" as const),
        value,
        children: [],
        alternate: [],
      };
      current.push(node);
      stack.push({ node, parent: current, elseSeen: false });
      current = node.children;
    } else if (value === "else") {
      const frame = stack.at(-1);
      if (!frame || frame.elseSeen) throw new Error("잘못된 else 구문입니다.");
      frame.elseSeen = true;
      current = frame.node.alternate;
    } else if (value === "endif" || value === "endfor") {
      const frame = stack.pop();
      if (!frame || value !== `end${frame.node.type}`)
        throw new Error("양식 닫기 구문이 일치하지 않습니다.");
      current = frame.parent;
    } else throw new Error("양식은 변수, 단순 if/for 문법만 지원합니다.");
  }
  if (
    stack.length ||
    /{{|{%|{#/.test(
      source.replace(/{{[\s\S]*?}}|{%[\s\S]*?%}|{#[\s\S]*?#}/g, ""),
    )
  )
    throw new Error("닫히지 않은 양식 구문입니다.");
  return root;
}
const lookup = (context: Row, path: string): any => {
  if (path === "true") return true;
  if (path === "false") return false;
  if (/^\d+$/.test(path)) return Number(path);
  return path
    .split(".")
    .reduce(
      (value, key) =>
        value != null && Object.hasOwn(Object(value), key)
          ? value[key]
          : undefined,
      context as any,
    );
};
export function validateCustomTemplate(source: string) {
  parse(source);
}
export function renderCustom(source: string, context: Row) {
  let size = 0,
    steps = 0;
  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  function render(nodes: Node[], scope: Row): string {
    const chunks: string[] = [];
    for (const node of nodes) {
      if (++steps > 100_000) throw new Error("양식 반복 한도를 초과했습니다.");
      if (node.type === "text" || node.type === "value") {
        const text =
          node.type === "text"
            ? node.value
            : escape(String(lookup(scope, node.value) ?? ""));
        size += new TextEncoder().encode(text).byteLength;
        if (size > 32 * 1024 * 1024)
          throw new Error("결과지는 최대 32MB입니다.");
        chunks.push(text);
      } else if (node.type === "if") {
        const expression = node.value.slice(3).trim(),
          negate = expression.startsWith("not ");
        const truth = !!lookup(
          scope,
          negate ? expression.slice(4) : expression,
        );
        chunks.push(
          render(
            (negate ? !truth : truth) ? node.children : node.alternate,
            scope,
          ),
        );
      } else {
        const [, name, path] = node.value.match(
          /^for\s+(\w+)\s+in\s+([\w.]+)$/,
        )!;
        const value = lookup(scope, path),
          values =
            Array.isArray(value) || typeof value === "string"
              ? Array.from(value)
              : [];
        if (!values.length) chunks.push(render(node.alternate, scope));
        values.forEach((item, index) =>
          chunks.push(
            render(node.children, {
              ...scope,
              [name]: item,
              loop: {
                index: index + 1,
                index0: index,
                first: index === 0,
                last: index === values.length - 1,
                length: values.length,
              },
            }),
          ),
        );
      }
    }
    return chunks.join("");
  }
  return render(parse(source), context);
}
