这个目录随安装包分发，用于放置「解压辅助程序」。

NiNfer 引擎的发行包只有 .rar 格式，Windows 自带的解压不支持 RAR，
所以需要完整的 7-Zip 命令行程序：

  tools\7z.exe
  tools\7z.dll

获取方式：安装 7-Zip 后，从安装目录把 7z.exe 与 7z.dll 复制到这里。
注意不能用 7zr.exe —— 它是精简版，不支持 RAR 解码。

缺少这两个文件时，NiNfer 的更新会给出明确提示并中止，
其余组件（llama.cpp / Pi / Strata / ffmpeg）不受影响。
