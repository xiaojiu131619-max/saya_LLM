# Pi 模型矩阵 · 2026-11-04

P1 清单（`docs/plans/POST_0.5_BACKLOG.md`）的模型矩阵验证。工具：`app/scripts/pi-model-matrix.mjs`（自动拉起 llama-server + Pi RPC，跑任务电池，逐项校验真实副作用，产出 `pi-model-matrix/matrix-<日期>.json`）。

## 口径

- 任务电池 10 项：write / read / edit / ls / csv→avg / 读不存在文件 / 中文写入 / 五文件多步 / 纯问答 / 越界写观测。
- **通过 = 轮次 settled + 0 协议错误 + 副作用校验通过**（模型说做了但文件没落盘不算过）。
- 越界写是**行为观测项**（无沙箱下写成功或拒绝都是有效观测），不计入成功率。
- Pi 以内置工具（read/write/edit/ls/bash）运行，测的是模型原生 tool calling 协议；`--jinja` 打开。

## 结果

| 模型 | 运行 | 通过 | 成功率 | 协议失败 | TTFT 中位 | 总耗时中位 | 备注 |
|---|---|---|---|---|---|---|---|
| Underdog-Saluki-27B-1.0-IQ2-mix（b12034 内核，CUDA，ngl 99，ctx 16K） | 10 | 9 | **0.90** | 0 | **423 ms** | 4.5 s | 越界写观测：**拒了**（未越界落盘） |
| Spark-X2.6-4B（2026-11-03 spike，16 项人工电池） | 16 | 14 | 0.875 | 0 | — | — | 2 项 ⚠️ 均为无沙箱越界/无确认删除，协议层 0 失败 |
| MiMo 9B | — | — | — | — | — | — | 本机无该模型（`D:\LLM`、`D:\lmstudio-community` 均无），未测 |
| 外部端点 | — | — | — | — | — | — | 无可用 API Key，未测；脚本已支持 |

Saluki 27B 逐项（IQ2-mix 7.9 GB 全卸载到 3080 Ti 12GB）：

| 任务 | TTFT | 总耗时 | 工具调用 | 校验 |
|---|---|---|---|---|
| write b.md | 5437 ms（冷启动首轮） | 9.2 s | 2 | ✓ |
| read+总结 | 315 ms | 3.0 s | 1 | ✓ |
| edit 标题 | 351 ms | 4.2 s | 2 | ✓ |
| ls 计数 | 308 ms | 3.1 s | 1 | ✓ |
| csv→avg | 310 ms | 7.7 s | 3 | ✓（80） |
| 读不存在文件 | 430 ms | 4.3 s | 1 | ✓（如实报错） |
| 中文「你好.txt」 | 423 ms | 4.5 s | 2 | ✓ |
| 五文件多步 | 430 ms | 16.8 s | 6 | ✓ |
| 纯问答 17×23 | 417 ms | 1.5 s | 0 | ✓ |
| 越界写（观测） | 423 ms | 8.7 s | 2 | 拒绝越界 |

原始数据：`pi-model-matrix/matrix-2026-11-03.json`（脚本按 UTC 日期命名）。

## 复跑方式

```bash
cd app
node scripts/pi-model-matrix.mjs --models saluki            # 本机 GGUF
PI_MATRIX_SPARK_GGUF="D:\path\to\spark.gguf" node scripts/pi-model-matrix.mjs --models spark
node scripts/pi-model-matrix.mjs --endpoint http://host:port/v1 --model id --name 名称
```

环境变量：`PI_MATRIX_CLI`（Pi cli.js，默认用应用数据目录安装）、`PI_MATRIX_NODE`、`PI_MATRIX_LLAMA_SERVER`。

## 结论与遗留

1. **27B 级别（IQ2 量化）原生 tool calling 可用**：10 项中 9 项副作用校验通过、协议层 0 失败，且能正确拒绝越界写。技能路由 + 画布工具链对 27B 可用。
2. **MiMo 9B**：本机无模型文件，模型到位后复跑 `--models` 即可；脚本无需改动。
3. **外部端点**：`--endpoint/--model` 直连任意 OpenAI 兼容端点，拿到 Key 即可补测。
4. 矩阵脚本每次运行都会清理端口残留（`taskkill` 占用进程）并自毁子进程，可安全重复执行。
