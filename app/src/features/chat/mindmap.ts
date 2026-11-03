import type { MindMapNode } from '@/types';

/**
 * 思维导图文本解析。
 *
 * 产物卡不引入 mermaid / 图形库，只把常见的三种来源还原成树：
 * - 嵌套 JSON：`{ "label": "根", "children": [...] }`，也接受 `title` /
 *   `name` / `topic` 和 `nodes` / `topics` / `subtopics` 等别名；
 * - mermaid `mindmap` 语法：按缩进还原层级，剥掉 `id((label))` 这类形状外壳；
 * - Markdown 标题 / 无序列表：按 `#` 级别或缩进还原层级。
 *
 * 解析失败时返回 `root: null` 和中文原因，界面降级成文件卡，不抛出。
 */

export type MindMapFormat = 'json' | 'mermaid' | 'outline';

export interface ParsedMindMap {
  root: MindMapNode | null;
  format: MindMapFormat | null;
  nodeCount: number;
  truncated: boolean;
  error: string;
}

const MAX_NODES = 500;
const MAX_DEPTH = 10;
const MAX_LABEL_CHARS = 200;

interface BuildState {
  count: number;
  truncated: boolean;
}

function makeNode(label: string, state: BuildState, depth: number): MindMapNode | null {
  if (state.count >= MAX_NODES || depth > MAX_DEPTH) {
    state.truncated = true;
    return null;
  }
  const text = label.trim().slice(0, MAX_LABEL_CHARS);
  state.count += 1;
  return { label: text || '未命名' };
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

const LABEL_KEYS = ['label', 'title', 'name', 'text', 'topic', 'value'];
const CHILD_KEYS = ['children', 'nodes', 'topics', 'subtopics', 'branches', 'items'];

function readChildren(record: Record<string, unknown>): unknown[] {
  for (const key of CHILD_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeJsonNode(value: unknown, state: BuildState, depth: number): MindMapNode | null {
  if (typeof value === 'string') return makeNode(value, state, depth);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const children = readChildren(record);
  const label = readString(record, LABEL_KEYS);
  if (!label && children.length === 0) return null;

  const node = makeNode(label || '未命名', state, depth);
  if (!node) return null;
  for (const child of children) {
    const normalized = normalizeJsonNode(child, state, depth + 1);
    if (normalized) (node.children ??= []).push(normalized);
  }
  return node;
}

function parseJson(text: string): ParsedMindMap {
  const state: BuildState = { count: 0, truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      root: null,
      format: null,
      nodeCount: 0,
      truncated: false,
      error: 'JSON 解析失败，文件可能不是合法的思维导图数据。',
    };
  }

  const rootValue = Array.isArray(parsed)
    ? { label: '导图', children: parsed }
    : (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).root !== undefined)
      ? (parsed as Record<string, unknown>).root
      : parsed;

  const root = normalizeJsonNode(rootValue, state, 0);
  if (!root) {
    return {
      root: null,
      format: 'json',
      nodeCount: 0,
      truncated: false,
      error: 'JSON 里没有找到 label / title 与 children 组成的导图结构。',
    };
  }
  return { root, format: 'json', nodeCount: state.count, truncated: state.truncated, error: '' };
}

function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/** 去掉 mermaid 节点 id / 形状外壳和 `:::class`。 */
export function cleanMermaidLabel(raw: string): string {
  let text = raw.replace(/:::.*$/, '').trim();
  const shell = text.match(/^[^([{]*[([{]{1,2}(.*?)[)\]}{]{1,2}$/);
  if (shell) text = shell[1];
  return text.replace(/^["']|["']$/g, '').trim();
}

function parseMermaid(text: string): ParsedMindMap {
  const state: BuildState = { count: 0, truncated: false };
  const lines = text.split(/\r?\n/);
  let root: MindMapNode | null = null;
  const stack: Array<{ indent: number; node: MindMapNode }> = [];

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('%%')) continue;
    const trimmed = rawLine.trim();
    if (root === null && /^mindmap\b/i.test(trimmed)) continue;
    if (/^::/.test(trimmed)) continue;

    const label = cleanMermaidLabel(trimmed);
    if (!label) continue;
    const indent = indentWidth(rawLine);
    const node = makeNode(label, state, stack.length);
    if (!node) break;

    if (!root) {
      root = node;
      stack.push({ indent, node });
      continue;
    }

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    if (stack.length === 0) {
      // 缩进回退到根节点以下：仍然挂到根上，避免丢节点。
      (root.children ??= []).push(node);
      stack.push({ indent, node: root });
      stack.push({ indent: indent, node });
      continue;
    }
    const parent = stack[stack.length - 1].node;
    (parent.children ??= []).push(node);
    stack.push({ indent, node });
  }

  if (!root) {
    return {
      root: null,
      format: 'mermaid',
      nodeCount: 0,
      truncated: false,
      error: '没有从 mermaid mindmap 内容里读到任何节点。',
    };
  }
  return { root, format: 'mermaid', nodeCount: state.count, truncated: state.truncated, error: '' };
}

function parseOutline(text: string): ParsedMindMap {
  const state: BuildState = { count: 0, truncated: false };
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim());

  const headingLines = lines.filter((line) => /^#{1,6}\s+/.test(line));
  if (headingLines.length > 0) {
    let root: MindMapNode | null = null;
    const stack: Array<{ level: number; node: MindMapNode }> = [];
    for (const line of headingLines) {
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (!match) continue;
      const level = match[1].length;
      const node = makeNode(match[2], state, stack.length);
      if (!node) break;
      while (stack.length > 0 && level <= stack[stack.length - 1].level) stack.pop();
      if (!root) {
        root = node;
      } else if (stack.length === 0) {
        (root.children ??= []).push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        (parent.children ??= []).push(node);
      }
      stack.push({ level, node });
    }
    if (root) {
      return { root, format: 'outline', nodeCount: state.count, truncated: state.truncated, error: '' };
    }
  }

  const bulletLines = lines.filter((line) => /^\s*([-*+]|\d+[.)])\s+/.test(line));
  if (bulletLines.length > 0) {
    let root: MindMapNode | null = null;
    const stack: Array<{ indent: number; node: MindMapNode }> = [];
    for (const line of bulletLines) {
      const label = line
        .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        .trim();
      if (!label) continue;
      const indent = indentWidth(line);
      const node = makeNode(label, state, stack.length);
      if (!node) break;
      while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
      if (!root) {
        root = node;
      } else if (stack.length === 0) {
        (root.children ??= []).push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        (parent.children ??= []).push(node);
      }
      stack.push({ indent, node });
    }
    if (root) {
      return { root, format: 'outline', nodeCount: state.count, truncated: state.truncated, error: '' };
    }
  }

  const plain = lines.map((line) => line.trim()).filter(Boolean);
  if (plain.length === 1) {
    const root = makeNode(plain[0], state, 0);
    if (root) {
      return { root, format: 'outline', nodeCount: state.count, truncated: false, error: '' };
    }
  }

  return {
    root: null,
    format: null,
    nodeCount: 0,
    truncated: false,
    error: '没有识别到导图结构；支持嵌套 JSON、mermaid mindmap、Markdown 标题或列表。',
  };
}

/** 根据内容自动选择解析器；扩展名只作为 mermaid 的提示，不参与强判。 */
export function parseMindMap(text: string, extension = ''): ParsedMindMap {
  const body = (text ?? '').trim();
  if (!body) {
    return { root: null, format: null, nodeCount: 0, truncated: false, error: '导图文件是空的。' };
  }

  if (body.startsWith('{') || body.startsWith('[')) {
    return parseJson(body);
  }
  const ext = extension.toLowerCase();
  if (ext === 'mmd' || ext === 'mermaid' || /^mindmap\b/im.test(body)) {
    return parseMermaid(body);
  }
  return parseOutline(body);
}
