export const LLAMA_CPP_TOOLS = [
  {
    id: 'read_file',
    label: '读取文件',
    description: '允许模型读取指定的本机文件内容。',
    risk: '中',
  },
  {
    id: 'file_glob_search',
    label: '文件通配搜索',
    description: '允许模型按路径通配符查找文件，例如查找某类后缀或目录下的文件。',
    risk: '中',
  },
  {
    id: 'grep_search',
    label: '文本搜索',
    description: '允许模型在文件内容里搜索关键词或正则匹配。',
    risk: '中',
  },
  {
    id: 'exec_shell_command',
    label: '执行命令',
    description: '允许模型运行本机 shell 命令，可能影响系统或项目文件。',
    risk: '高',
  },
  {
    id: 'write_file',
    label: '写入文件',
    description: '允许模型创建或覆盖文件。',
    risk: '高',
  },
  {
    id: 'edit_file',
    label: '编辑文件',
    description: '允许模型按指令修改已有文件。',
    risk: '高',
  },
  {
    id: 'apply_diff',
    label: '应用补丁',
    description: '允许模型把 diff 补丁应用到文件。',
    risk: '高',
  },
  {
    id: 'get_datetime',
    label: '获取时间',
    description: '允许模型读取当前日期和时间。',
    risk: '低',
  },
] as const;

export type LlamaCppToolId = typeof LLAMA_CPP_TOOLS[number]['id'];

export function toolLabel(toolId: string) {
  return LLAMA_CPP_TOOLS.find((tool) => tool.id === toolId)?.label ?? toolId;
}
