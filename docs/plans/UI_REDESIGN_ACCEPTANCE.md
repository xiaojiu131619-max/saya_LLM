# 界面重排：执行与回滚记录

日期：2026-10-12

## 结论

按 `UI_REDESIGN_DS_EXECUTION.md` 第 7 节执行的整体界面重排，**已按用户要求全部回滚**。
当前工作区不包含本次重排的任何改动。

## 回滚范围与验证

回滚后逐文件核对了 `git diff --numstat` 与「本次会话开始时的基线 diffstat」，全部一致：

| 文件 | 基线 | 回滚后 |
|---|---|---|
| `components/ChatBubble.tsx` | 61 | 61 ✓ |
| `components/MarkdownRenderer.tsx` | 56 | 56 ✓ |
| `features/apiStatus/ApiStatusPage.tsx` | 675 | 675 ✓ |
| `features/apiStatus/ExternalApiSection.tsx` | 44 | 44 ✓ |
| `features/chat/ChatSidebar.tsx` | 54 | 54 ✓ |
| `features/chat/chatUtils.ts` | 104 | 104 ✓ |
| `features/model/ModelWorkspace.tsx` | 76 | 76 ✓ |
| `features/workspace/SystemStatusStrip.tsx` | 20 | 20 ✓ |
| `hooks/useEngineStatuses.ts` | 186 | 186 ✓ |
| `index.css` | 66 | 66 ✓ |
| `pages/agent/AgentWebUiPanel.tsx` | 3 | 3 ✓ |
| `CHANGELOG.md` | 19 | 19 ✓ |

回滚方式：会话开始时未修改的 27 个文件用 `git checkout --` 精确还原；会话开始时已有未提交改动的
12 个文件逐个手工还原（含 `ChatBubble` / `MarkdownRenderer` 中 8 行被误还原的圆角令牌，
已从回滚前的构建产物 `dist/` 中比对取回原值）。本次新增的
`features/workspace/WorkspaceNavigation.tsx` 已删除。

前端检查回到基线：`npm run lint` → 8 problems (4 errors, 4 warnings)，与改造前完全一致；
`npm run build` 通过；`npm run desktop:build` 通过，
产物 `app/src-tauri/target/release/agent-llm.exe` 已用回滚后的源码重新构建。

## 回滚时工作区里的**并行改动**（非本次重排，已原样保留）

回滚过程中发现工作区还有一路与本任务无关、正在进行的改动，全部保持原样、未被触碰：

- `app/src/workspace-design.css`（新增）
- `app/src/main.tsx`（`import './workspace-design.css'`）
- `app/src/components/PageHeader.tsx`（`workspace-page-header`、`eyebrow`）
- `app/src/components/SettingSection.tsx`（`workspace-setting-section`）
- `app/src/components/PageLayout.tsx`（新增，未被任何文件引用；引用 `page-layout` / `page-band` 两个类，
  这两个类目前不在 `index.css` 中）
- `app/src/pages/HomePage.tsx`（`model-library-header`、`model-library-count` 等）
- `app/src/pages/ChatPage.tsx`（比基线多 8 行，属该路改动的 `ChatSidebar` 属性调整）

## 如果后续要重做这次重排

原执行计划里的公共框架思路（全局功能栏 / 统一页头 / 按需辅助栏 / 状态栏）与上面那路
`workspace-*` 方案是两套互不相容的排版体系，同时存在会互相打架（两套页头、两套内容宽度上限）。
重做前需要先决定保留哪一套。

需要留意的一处功能性发现：模型工作区的侧栏被移除时，挂在它上面的
**主服务存活轮询（`getDesktopServerStatus`，2 秒）** 会失去唯一调用点，服务崩溃时界面不再察觉。
无论采用哪套方案，只要删除该侧栏，就必须把这段轮询迁移到常驻组件里。
