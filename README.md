# Flow Canvas

独立的本地项目关系画布。节点描述项目或产物的输入、输出、结论、处理方式和参考；连线描述节点之间的自然语言处理意图。

## 工作区

桌面版顶部可随时切换工作区。选定目录后，应用会在该目录内创建：

- `.flow-canvas/flow.json`：节点、连线和画布位置
- `.flow-canvas/logs/`：运行日志目录
- `.flow-canvas/artifacts/`：Flow 产物目录

首次打开工作区时，Flow Canvas 会同时创建可复用的分析框架目录。目录按“模块 × 阶段”组织：

```text
research/{design,processing,analysis,results,presentation}/
test/{design,processing,analysis,results,presentation}/
excute/{design,processing,analysis,results,presentation}/
conclusion/{design,processing,analysis,results,presentation}/
```

画布会生成五个基础模块（设计、处理、分析、结果整理、呈现）。模块之间依次串联；每个模块内部由模块目标同时分叉到调研、测试、执行三个并行节点，再共同汇入结果与结论节点。节点可以填写目标、输入、输出和结论，并单独选择 AI 模式：关闭、辅助或自动执行。点击节点执行时，Flow Canvas 会创建节点目录、保存当前 Flow，并把模块上下文和前后节点关系发送到该节点的独立终端。`result.md` 与 `conclusion.md` 可由 AI 或人工写入节点目录，再通过节点详情中的“读取目录结果”回填到 Flow。

Flow Canvas 会定期扫描工作区文件，并把新增/修改文件记录到 `flow.json` 的 `files` 与 `activities` 字段。扫描会忽略 `.flow-canvas`、`.git`、`node_modules`、`target` 和 `dist`。

编辑会自动保存到当前工作区。外部插件以工作区为当前目录启动，工作区外的节点路径不能执行。也可以把文件夹拖到 EXE，或执行 `"Flow Canvas.exe" E:\path\to\workspace` 直接打开。

## AI 会话

画布工具栏选择 `Codex · WSL codex_micu` 后，在节点详情中填写目标并启用“节点 AI”，再点击节点卡片的播放按钮。新框架的 AI 默认关闭，可分别选择辅助或执行。辅助模式通过节点提示限制任务为调研与建议；实际文件访问仍使用工作区沙箱。每个节点拥有独立的持续 WSL PTY 终端，并以当前工作区运行：

```text
codex_micu -C "$PWD" -s workspace-write -a never --no-alt-screen
```

Windows 端读取 Flow、拼接节点上下文并调度。节点提示包含 `flow.json` 路径、模块目标、前后节点关系、输入及参考；未填写输入时使用前置节点输出。AI 输出显示在底部节点终端。检测到独立行 `NEED_USER_INPUT:` 或中断后可在终端回复；独立行 `FLOW_NODE_DONE` 标记完成，并触发读取节点目录中的 `result.md` 和 `conclusion.md`。完成标记依赖 AI 输出，仍需复核结果。会话可持续复用；要调整 AI 模式或工作目录，先点击“关闭节点会话”。

关闭 AI 时，可以手工填写结果与结论，再点击“记录完成”；手工填写内容保存到 `flow.json`。剪枝保留节点及文件，阻止节点通过播放按钮执行，剪枝整个模块会同时停用其阶段节点。旧工作区打开时会保留原图，并补充基础框架；“补齐基础框架”也可再次添加缺失项。

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

前端框架逻辑检查：`node scripts/check-framework.mjs`。后端测试：`cargo test --manifest-path src-tauri/Cargo.toml --lib`（需要对应平台的 Tauri 系统依赖）。

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
