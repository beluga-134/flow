# Flow Canvas

独立的本地项目关系画布。节点描述项目或产物的输入、输出、结论、处理方式和参考；连线描述节点之间的自然语言处理意图。

## 工作区

桌面版顶部可随时切换工作区。选定目录后，应用会在该目录内创建：

- `.flow-canvas/flow.json`：节点、连线和画布位置
- `.flow-canvas/logs/`：运行日志目录
- `.flow-canvas/artifacts/`：Flow 产物目录

Flow Canvas 会定期扫描工作区文件，并把新增/修改文件记录到 `flow.json` 的 `files` 与 `activities` 字段。扫描会忽略 `.flow-canvas`、`.git`、`node_modules`、`target` 和 `dist`。

编辑会自动保存到当前工作区。外部插件以工作区为当前目录启动，工作区外的节点路径不能执行。也可以把文件夹拖到 EXE，或执行 `"Flow Canvas.exe" E:\path\to\workspace` 直接打开。

## AI 会话

画布工具栏选择 `Codex · WSL codex_micu` 后，直接点击任意节点卡片内的播放按钮即可执行。每个节点拥有独立的持续 PTY 会话，并以当前工作区运行：

```text
codex_micu -C "$PWD" -s workspace-write -a never --no-alt-screen
```

节点提示会包含完整 `flow.json`、前置/后续节点关系，以及前置节点输出文件。前置输出会自动继承为当前节点输入。AI 输出显示在节点内部；检测到 `NEED_USER_INPUT:` 或中断会让节点红色闪烁，此时可在节点输入框回复。切换工作区会关闭旧节点会话。

## 开发

```bash
npm install
npm run dev
```

浏览器预览地址：`http://127.0.0.1:1422/`。

```bash
npm run build
npm run tauri dev
```

Windows 环境已安装 Node.js、Rust MSVC 工具链和 Visual Studio Build Tools 后，可生成单个便携 EXE：

```batch
package.cmd
```

输出位置为 `release\Flow Canvas.exe`。

## 外部插件

Flow Canvas 不包含 Research Reader、SQL Viewer 或终端工具。`plugins/` 下的 JSON 只是插件清单示例；实际 EXE 路径由部署环境配置。插件启动通过 Tauri Rust 命令传递两个独立参数：可执行文件路径和目标项目路径，不拼接 shell 命令。

当前内置动作：

- 系统文件夹：使用系统默认工具打开节点路径。
- Research Reader：把文档或源码路径交给外部阅读器。
- SQL Viewer：把 CSV、Parquet、JSON 或 DuckDB 路径交给外部查看器。

## Flow 文件

“保存”会生成带 `schemaVersion: 1` 的 `.flow.json` 文件。文件只保存画布结构、自然语言说明和路径，不保存外部工具二进制，也不会自动执行连接上的命令。
