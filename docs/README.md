# docs/ 文档目录索引

本目录按**文档生命周期**分四层：

| 目录 | 收录标准 |
| --- | --- |
| `guides/` | 长期维护、随代码持续更新的指南与架构文档 |
| `plans/` | 仍在推进或部分未完成的计划书与设计稿 |
| `reports/` | 一次性专题报告与验证记录 |
| `archive/` | 已完成、已放弃或已回滚的文档，仅作历史参考，**不删除** |

> 归档只做移动、不做删除。计划为什么被放弃、方案为什么被回滚，这类决策记录本身有价值。

## guides/ —— 指南与长期维护文档

| 文档 | 内容 |
| --- | --- |
| [DEVELOPMENT_GUIDE.md](guides/DEVELOPMENT_GUIDE.md) | 本地开发、构建、测试和故障排查 |
| [UI_DESIGN_GUIDE.md](guides/UI_DESIGN_GUIDE.md) | UI/UX 设计边界与实现规则：分层、令牌、字体、图标、动效、组件、布局、禁止清单 |
| [CANVAS_MODULE.md](guides/CANVAS_MODULE.md) | 无限画布外挂模块：端口/数据目录、Node 复用、画布包构建与发布 |
| [TECHNICAL_REPORT.md](guides/TECHNICAL_REPORT.md) | 当前架构、数据流与模块清单 |
| [SWIFT27B_TUNING.md](guides/SWIFT27B_TUNING.md) | Swift-27B 模型调优依据、A/B 实测数据与已知坑 |
| [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | Agent 阶段 3 的 stdio JSON 行协议契约（本轮仅留档） |

## plans/ —— 进行中的计划

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [ROADMAP.md](plans/ROADMAP.md) | 项目路线图 0.3.1 → 1.0.0 | 持续更新 |
| [COMFY_IMAGE_WORKSPACE_PLAN.md](plans/COMFY_IMAGE_WORKSPACE_PLAN.md) | ComfyUI 生图工作区 | 待执行 |
| [CANVAS_AGENT_LINKAGE_PLAN.md](plans/CANVAS_AGENT_LINKAGE_PLAN.md) | 无限画布 × Pi Agent 联动（只读 → 生图 → 画布续编 → 解释） | 仅规划，未实施 |
| [POST_0.5_BACKLOG.md](plans/POST_0.5_BACKLOG.md) | 0.5 之后完成清单：Chat 接入、会话自动启动、产物门、技能雷达、模型矩阵、Pi 分发 | 待排期 |
| [DYNAMIC_GGUF_DRAFTER_PLAN.md](plans/DYNAMIC_GGUF_DRAFTER_PLAN.md) | 动态 GGUF Drafter（MTP / DSpark / DFlash） | Phase 1-3 已实施，Phase 4 待做 |
| [WIN7_REPLICA_PLAN.md](plans/WIN7_REPLICA_PLAN.md) | Windows 7 复刻落地计划 | 未执行 |

## reports/ —— 专题报告与验证记录

| 文档 | 内容 |
| --- | --- |
| [PI_AGENT_SPIKE_2026-11-03.md](reports/PI_AGENT_SPIKE_2026-11-03.md) | Pi阶段 1–3：RPC 管道、宿主工具代理、权限三档、会话隔离、技能路由与安全验证 |
| [AGENT_KERNEL_LAYOUT_2026-11-02.md](reports/AGENT_KERNEL_LAYOUT_2026-11-02.md) | Agent 设置双列、核心更新双列与更新流程优化 |
| [GITHUB_UPLOAD_2026-11-01.md](reports/GITHUB_UPLOAD_2026-11-01.md) | 2026-11-01 上传记录：提交范围、审查修复清单与验证结果 |
| [AUTOTUNE_OPTIMIZATION_2026-10-15.md](reports/AUTOTUNE_OPTIMIZATION_2026-10-15.md) | 自动调参优化与验证记录 |
| [CHAT_ATTACHMENT_INPUT_2026-10-15.md](reports/CHAT_ATTACHMENT_INPUT_2026-10-15.md) | 对话附件输入（粘贴与跨应用拖放）实现记录 |
| [FAST27B_ATTACHMENTS_2026-10-15.md](reports/FAST27B_ATTACHMENTS_2026-10-15.md) | fast-27b 附件支持记录 |
| [PUSH_REPORT_2026-10-08.md](reports/PUSH_REPORT_2026-10-08.md) | 2026-10-08 fast-27b、API 状态、Token、Chat 与 MCP 推送报告 |
| [ui-layout-review-2026-10-13/](reports/ui-layout-review-2026-10-13/) | 界面布局评审报告、修复记录与前后对比截图 |

## archive/ —— 已完成 / 已放弃（仅作历史参考）

| 文档 | 内容 | 终结原因 |
| --- | --- | --- |
| [DSH_AGENT_0.4_PLAN.md](archive/DSH_AGENT_0.4_PLAN.md) | v0.4 计划书：DeepSeek Harness 接入 | 已实现并随 v0.4.0 发布；dsh 已于 2026-11-06 整体下线 |
| [DSH_SPIKE_RECORD.md](archive/DSH_SPIKE_RECORD.md) | dsh Phase 0 技术验证记录（包版本锁定、pnpm 提速、Node 托管） | 同上；托管 Node 能力已迁到 `services/node_installer.rs` 供画布复用 |
| [UI_LAYOUT_REDESIGN_PLAN.md](archive/UI_LAYOUT_REDESIGN_PLAN.md) | 界面重新排版计划 | 关联的整套重排最终回滚 |
| [UI_REDESIGN_DS_EXECUTION.md](archive/UI_REDESIGN_DS_EXECUTION.md) | 界面重排执行计划书 | 同上 |
| [UI_REDESIGN_ACCEPTANCE.md](archive/UI_REDESIGN_ACCEPTANCE.md) | 界面重排执行与回滚记录 | 结论：全部回滚，工作区未保留改动 |
| [model-load-ui-review.md](archive/model-load-ui-review.md) | 模型加载页界面评审 | 建议已落地（动作组收为三项、运行记录与调参日志合并） |
| [model-load-layout.html](archive/model-load-layout.html) | 上述评审的配套布局原型 | 已实施，原型完成使命 |
| [api-prototype/](archive/api-prototype/) | API 状态页网页原型（独立 HTML） | 排版结构已引入实现 |
| [tech-spec.md](archive/tech-spec.md) | 早期前端原型设计意图 | 已被现行实现取代 |
| [ui-redesign-plan.md](archive/ui-redesign-plan.md) | 2026-08 UI 重设计执行报告 | 已完成（克制毛玻璃 + 原生主题） |

> 归档文档正文里的旧相对路径属于历史快照，未改写；仅修正了仍会点击失效的链接。

---

桌面应用源码在 `app/` 目录。安装、运行、配置与常见问题见根目录 [README.md](../README.md)，开发流程见 [guides/DEVELOPMENT_GUIDE.md](guides/DEVELOPMENT_GUIDE.md)。
