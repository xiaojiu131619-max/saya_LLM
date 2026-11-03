import type { AgentArtifact, AgentArtifactKind } from '@/types';
import type { PiResolvedArtifact } from '@/lib/ipc/pi';
import { attachmentMediaMime, fileExtension } from './chatUtils';

/**
 * Pi 工具步骤产物的契约归一化。
 *
 * 兼容两代载荷：
 * - 旧：`string[]`，只有文件名；
 * - 新：`{ name, kind?, title? }[]`，kind 可显式声明。
 *
 * 推断只做 image / file / mindmap：`link` 必须显式声明；`mindmap` 只认
 * `.mmd` / `.mermaid` / `.mindmap` 这类明确表示导图的扩展名，不靠普通
 * `.json` 猜。链接还必须是 http/https，避免把 `file:` / `javascript:`
 * 之类的值送进 `open_external_url`。
 */

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'svg',
]);

const MINDMAP_EXTENSIONS = new Set(['mmd', 'mermaid', 'mindmap']);

const EXPLICIT_KINDS: AgentArtifactKind[] = ['image', 'file', 'link', 'mindmap'];

export interface NormalizedPiArtifact {
  /** 文件名（文件类）或 http(s) 地址（link）。 */
  name: string;
  kind: AgentArtifactKind;
  title: string;
  /** kind=link 时的 http(s) 地址。 */
  url?: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isHttpUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function explicitKind(value: unknown): AgentArtifactKind | null {
  return typeof value === 'string' && EXPLICIT_KINDS.includes(value as AgentArtifactKind)
    ? value as AgentArtifactKind
    : null;
}

/** 按扩展名推断 image / mindmap，其余归 file；link 必须显式声明。 */
export function inferArtifactKind(name: string): 'image' | 'file' | 'mindmap' {
  const lower = name.toLowerCase();
  // 普通 .json 不当导图，只有显式的 *.mindmap.json 才推断。
  if (lower.endsWith('.mindmap.json')) return 'mindmap';
  const extension = fileExtension(lower);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (MINDMAP_EXTENSIONS.has(extension)) return 'mindmap';
  return 'file';
}

export function normalizePiArtifacts(raw: unknown): NormalizedPiArtifact[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedPiArtifact[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    let name = '';
    let kind: AgentArtifactKind | null = null;
    let title = '';
    let url = '';

    if (typeof item === 'string') {
      name = item.trim();
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      name = readString(record.name) || readString(record.path) || readString(record.url);
      kind = explicitKind(record.kind);
      title = readString(record.title);
      url = readString(record.url);
    }

    if (!name) continue;
    const resolvedKind = kind ?? inferArtifactKind(name);

    if (resolvedKind === 'link') {
      // 显式 link：优先用 url 字段，其次把 name 当链接；都不是 http(s) 就丢弃。
      const link = isHttpUrl(url) ? url : isHttpUrl(name) ? name : '';
      if (!link) continue;
      const key = `link:${link}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'link', name: link, title: title || name || link, url: link });
      continue;
    }

    const key = `${resolvedKind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: resolvedKind, name, title: title || name });
  }

  return out;
}

/**
 * 把归一化结果与宿主解析结果合并成可持久化的消息产物。
 *
 * 只写相对路径与元数据，绝不写 base64。图片由 ArtifactPanel 在渲染时
 * 调 `pi_read_artifact` 按需读取。
 */
export function buildAgentArtifacts(
  artifacts: NormalizedPiArtifact[],
  resolved: PiResolvedArtifact[],
): AgentArtifact[] {
  const byName = new Map<string, PiResolvedArtifact>();
  for (const item of resolved) {
    const key = item.name.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, item);
  }

  return artifacts.map((artifact) => {
    if (artifact.kind === 'link') {
      return {
        kind: 'link',
        title: artifact.title,
        url: artifact.url,
      };
    }

    const match = byName.get(artifact.name.trim().toLowerCase());
    if (!match?.exists) {
      return {
        kind: artifact.kind,
        title: artifact.title,
        duplicate: match?.duplicate,
      };
    }

    const mime = attachmentMediaMime(match.name, '');
    return {
      kind: artifact.kind,
      title: artifact.title,
      path: match.relPath,
      size: match.size,
      mtime: match.mtime,
      duplicate: match.duplicate,
      ...(match.magic ? { magic: match.magic } : {}),
      magicOk: match.magicOk,
      ...(mime !== 'application/octet-stream' ? { mime } : {}),
    };
  });
}
