# docs/ 文档目录索引

本目录按文档用途分为三类子目录，根目录不再散放文件。

## guides/ —— 指南与报告（长期维护）

| 文档 | 内容 |
| --- | --- |
| [DEVELOPMENT_GUIDE.md](guides/DEVELOPMENT_GUIDE.md) | 本地开发、构建、测试和故障排查 |
| [TECHNICAL_REPORT.md](guides/TECHNICAL_REPORT.md) | 当前架构、数据流与模块清单 |
| [BEELLAMA_DLC_GUIDE.md](guides/BEELLAMA_DLC_GUIDE.md) | Beellama DLC 完整指南（硬件前提、离线包、自编译工具链） |
| [NINFER_DLC_GUIDE.md](guides/NINFER_DLC_GUIDE.md) | Ninfer DLC 完整指南（离线包校验、CMake 配方、hf-mirror 下载） |
| [SWIFT27B_TUNING.md](guides/SWIFT27B_TUNING.md) | Swift-27B 模型调优依据、A/B 实测数据与已知坑 |
| [PUSH_REPORT_2026-10-08.md](guides/PUSH_REPORT_2026-10-08.md) | 2026-10-08 fast-27b、API 状态、Token、Chat 与 MCP 推送报告 |

## plans/ —— 计划与设计稿（按版本推进，完成后归档）

| 文档 | 内容 |
| --- | --- |
| [ROADMAP.md](plans/ROADMAP.md) | 项目路线图 0.3.0 → 1.0.0 |
| [DSH_AGENT_0.4_PLAN.md](plans/DSH_AGENT_0.4_PLAN.md) | DSH Agent 0.4 计划书 |
| [DSH_SPIKE_RECORD.md](plans/DSH_SPIKE_RECORD.md) | DSH Phase 0 技术验证记录（多份代码注释引用其结论） |
| [COMFY_IMAGE_WORKSPACE_PLAN.md](plans/COMFY_IMAGE_WORKSPACE_PLAN.md) | ComfyUI 生图工作区计划 |
| [DYNAMIC_GGUF_DRAFTER_PLAN.md](plans/DYNAMIC_GGUF_DRAFTER_PLAN.md) | 动态 GGUF Drafter 计划 |
| [WIN7_REPLICA_PLAN.md](plans/WIN7_REPLICA_PLAN.md) | Windows 7 复刻落地计划书 |

## archive/ —— 已完成/过时文档（仅作历史参考）

| 文档 | 内容 |
| --- | --- |
| [tech-spec.md](archive/tech-spec.md) | 早期前端原型设计意图 |
| [ui-redesign-plan.md](archive/ui-redesign-plan.md) | UI 重设计计划（已落地） |

桌面应用源码在 `app/` 目录，完整启动与构建说明见根目录 [README.md](../README.md)。
