import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Pi 宿主工具代理扩展。
 *
 * Pi 自带 read/write/edit/bash 全部禁用；模型只能调用这里的工具，
 * 每个动作都通过本地回环 HTTP 回到 Rust 宿主，由宿主做沙箱与权限判定。
 *
 * 桥地址/token 由宿主在 spawn 时注入环境变量；不要把它们写进日志或文件。
 */

const BRIDGE_URL = process.env.PI_HOST_BRIDGE_URL ?? "";
const BRIDGE_TOKEN = process.env.PI_HOST_BRIDGE_TOKEN ?? "";

const HOST_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "run_command",
  "save_memory",
  "canvas_status",
  "canvas_list_workflows",
  "canvas_get_workflow",
  "canvas_run",
  "canvas_cancel",
] as const;

type HostResult = {
  ok?: boolean;
  data?: string;
  error?: string;
  denied?: boolean;
  meta?: unknown;
};

async function callHost(
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return {
      content: [{ type: "text" as const, text: "ERROR: 宿主工具桥未配置" }],
      isError: true,
      details: {},
    };
  }
  try {
    const response = await fetch(`${BRIDGE_URL}/tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pi-Token": BRIDGE_TOKEN,
      },
      body: JSON.stringify({ tool, args }),
      signal,
    });
    const payload = (await response.json().catch(() => ({}))) as HostResult;
    if (!response.ok || !payload.ok) {
      const detail = payload.error ?? `HTTP ${response.status}`;
      return {
        content: [{ type: "text" as const, text: `ERROR: ${detail}` }],
        isError: true,
        details: {
          denied: Boolean(payload.denied),
          ...(payload.meta ? { meta: payload.meta } : {}),
        },
      };
    }
    return {
      content: [{ type: "text" as const, text: String(payload.data ?? "") }],
      details: payload.meta ?? {},
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `ERROR: 宿主工具桥不可达：${String(error)}`,
        },
      ],
      isError: true,
      details: {},
    };
  }
}

export default function (pi: ExtensionAPI) {
  // 强制只保留宿主代理工具。即使 builtin 被别的配置重新打开，这里也会踢掉。
  pi.on("session_start", async () => {
    pi.setActiveTools([...HOST_TOOLS]);
  });

  // 双保险：任何非宿主工具调用直接阻断。
  pi.on("tool_call", async (event) => {
    if (!HOST_TOOLS.includes(event.toolName as (typeof HOST_TOOLS)[number])) {
      return {
        block: true,
        reason: `工具 ${event.toolName} 已被宿主禁用；只能使用 ${HOST_TOOLS.join(" / ")}`,
      };
    }
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n\n工具说明：所有文件与命令都通过宿主代理执行。文件路径必须在工作区内；auto 档的覆盖/删除/命令会请求用户确认，full 档仍会拦截危险命令。长期记忆跨会话共享：需要记住用户偏好、任务结论或踩过的坑时，用 save_memory 写入；每轮任务开头收到的【长期记忆】就是之前存下的内容。\n\n画布（无限画布生图）：需要生成/修改图片时先 canvas_status 确认画布在线，再 canvas_list_workflows 拿真实工作流 ID，最后 canvas_run 提交（参数 workflow/prompt/negative/size/output_name）。不要编造工作流 ID，不要把工作流 JSON 复制出来假装生成；产物会自动存到工作区 canvas/ 目录。",
  }));

  pi.registerTool({
    name: "read_file",
    label: "读取文件",
    description: "读取工作区内的文本文件。路径必须位于工作区。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区的路径" }),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost("read_file", { path: params.path }, signal);
    },
  });

  pi.registerTool({
    name: "write_file",
    label: "写入文件",
    description: "把文本写入工作区内的文件；覆盖已有文件会按权限档请求确认。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区的路径" }),
      content: Type.String({ description: "文件内容" }),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost(
        "write_file",
        { path: params.path, content: params.content },
        signal,
      );
    },
  });

  pi.registerTool({
    name: "edit_file",
    label: "修改文件",
    description:
      "在工作区文件里把唯一一处 old 替换成 new；0 处或多处匹配都会拒绝。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区的路径" }),
      old: Type.String({ description: "要替换的原文，必须唯一匹配" }),
      new: Type.String({ description: "替换后的文本" }),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost(
        "edit_file",
        { path: params.path, old: params.old, new: params.new },
        signal,
      );
    },
  });

  pi.registerTool({
    name: "list_dir",
    label: "列出目录",
    description: "列出工作区内目录的文件名、类型和大小。",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "相对工作区的目录，默认 ." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost("list_dir", { path: params.path ?? "." }, signal);
    },
  });

  pi.registerTool({
    name: "run_command",
    label: "执行命令",
    description:
      "在工作区内执行 PowerShell 命令；auto 档会请求用户确认，full 档仍拦截危险命令。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的 PowerShell 命令" }),
      timeout: Type.Optional(
        Type.Number({ description: "超时秒数，默认 30，最大 300" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost(
        "run_command",
        { command: params.command, timeout: params.timeout },
        signal,
      );
    },
  });

  pi.registerTool({
    name: "save_memory",
    label: "记住一件事",
    description:
      "把一句话事实写进跨会话的长期记忆（用户偏好、任务结论、踩过的坑）。下一轮任务的【长期记忆】里会出现这条内容。一次只写一件事，写事实，不写过程。",
    parameters: Type.Object({
      content: Type.String({ description: "要记住的一句话事实" }),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost("save_memory", { content: params.content }, signal);
    },
  });

  pi.registerTool({
    name: "canvas_status",
    label: "画布状态",
    description:
      "只读：确认无限画布 / ComfyUI / 网关是否就绪。生图前先调它。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return callHost("canvas_status", {}, signal);
    },
  });

  pi.registerTool({
    name: "canvas_list_workflows",
    label: "列出画布工作流",
    description:
      "只读：列出画布里已安装/可用的生图工作流 ID 与可用性。canvas_run 只接受这里的 ID。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return callHost("canvas_list_workflows", {}, signal);
    },
  });

  pi.registerTool({
    name: "canvas_get_workflow",
    label: "查看工作流参数",
    description:
      "只读：看某个画布工作流的参数 schema（截断版）。用于确认某工作流吃哪些参数。",
    parameters: Type.Object({
      workflow: Type.String({ description: "工作流 ID（来自 canvas_list_workflows）" }),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost("canvas_get_workflow", { workflow: params.workflow }, signal);
    },
  });

  pi.registerTool({
    name: "canvas_run",
    label: "提交画布生图",
    description:
      "把生图/改图交给无限画布执行；产物自动保存到工作区 canvas/ 目录并出现在产物卡。workflow 必须来自 canvas_list_workflows。给 input_images（工作区相对路径，最多 4 张）走改图/放大，不给则文生图。",
    parameters: Type.Object({
      workflow: Type.String({ description: "工作流 ID" }),
      prompt: Type.String({ description: "画面描述，写全主体+风格+光线+构图；改图时写要改成什么样" }),
      negative: Type.Optional(Type.String({ description: "负面提示词" })),
      size: Type.Optional(Type.String({ description: "尺寸，如 1024x1024；以工作流 schema 为准" })),
      input_images: Type.Optional(
        Type.Array(Type.String(), {
          description: "输入图（工作区相对路径，最多 4 张），改图/重绘/放大时提供",
        }),
      ),
      output_name: Type.Optional(Type.String({ description: "输出文件名（不含扩展名）" })),
      timeout: Type.Optional(
        Type.Number({ description: "等待秒数，默认 300，最大 600" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      return callHost(
        "canvas_run",
        {
          workflow: params.workflow,
          prompt: params.prompt,
          negative: params.negative,
          size: params.size,
          input_images: params.input_images,
          output_name: params.output_name,
          timeout: params.timeout,
        },
        signal,
      );
    },
  });

  pi.registerTool({
    name: "canvas_cancel",
    label: "取消画布任务",
    description: "中断 ComfyUI 正在执行的画布任务。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return callHost("canvas_cancel", {}, signal);
    },
  });
}
