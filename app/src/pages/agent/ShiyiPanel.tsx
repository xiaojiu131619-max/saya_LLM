/**
 * 拾一 · 空界面。
 * 这一格故意留白：Agent 页去掉 dsh 之后，先把位置空出来，
 * 后续要放什么再往里填，不要在这里预埋任何假数据。
 */
export default function ShiyiPanel() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center" aria-label="拾一">
      <span className="select-none text-[length:var(--font-display)] font-semibold tracking-[0.4em] text-[var(--text-tertiary)] opacity-25">
        拾一
      </span>
    </div>
  );
}
