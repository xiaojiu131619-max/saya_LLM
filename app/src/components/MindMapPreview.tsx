import type { MindMapNode } from '@/types';

/**
 * 纯 CSS 思维导图预览：不引入 mermaid / 图形库，只把解析后的树渲染成
 * 可滚动的层级列表。层级用左边框表达，节点数量最多 500（解析层已截断）。
 */
export default function MindMapPreview({ root }: { root: MindMapNode }) {
  return (
    <div className="max-h-[360px] overflow-auto px-3 py-3">
      <ul className="space-y-1">
        <TreeItem node={root} depth={0} />
      </ul>
    </div>
  );
}

function TreeItem({ node, depth }: { node: MindMapNode; depth: number }) {
  const children = node.children ?? [];
  const isRoot = depth === 0;

  return (
    <li className="relative min-w-0">
      <div
        className={
          isRoot
            ? 'inline-block max-w-full truncate rounded-[var(--radius-field)] bg-[var(--accent-subtle)] px-2.5 py-1 text-[length:var(--font-body)] font-semibold text-[var(--accent)]'
            : 'inline-block max-w-full truncate rounded-[var(--radius-field)] bg-black/[0.04] px-2 py-0.5 text-[length:var(--font-caption)] text-[var(--text-primary)] dark:bg-white/[0.06]'
        }
        title={node.label}
      >
        {node.label}
      </div>
      {children.length > 0 && (
        <ul className="ml-2.5 mt-1 space-y-1 border-l border-[var(--border)] pl-3">
          {children.map((child, index) => (
            <TreeItem key={`${index}-${child.label}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
