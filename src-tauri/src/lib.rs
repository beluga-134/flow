use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, Response};
use tauri::State;

const MAX_FLOW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_NODE_RESULT_BYTES: u64 = 2 * 1024 * 1024;
const WORKSPACE_DATA_DIRECTORY: &str = ".flow-canvas";
const WORKSPACE_FLOW_FILE: &str = "flow.json";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CODEX_MICU_COMMAND: &str = r#"if ! type nvm >/dev/null 2>&1; then case "$(node -v 2>/dev/null)" in v22.*) nvm() { return 0; } ;; *) printf 'codex_micu requires Node 22 or nvm\n' >&2; exit 127 ;; esac; fi; codex_micu -C "$PWD" -s workspace-write -a never --no-alt-screen; printf '\n[Flow Canvas] Codex 会话已结束，已返回终端。退出终端请按 Ctrl-D。\n' >&2; exec bash -i"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowDocument {
    schema_version: u8,
    name: String,
    nodes: serde_json::Value,
    edges: serde_json::Value,
    #[serde(default)]
    files: Option<serde_json::Value>,
    #[serde(default)]
    activities: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileRecord {
    path: String,
    size: u64,
    modified_at: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    root: String,
    name: String,
    flow_path: String,
    document: Option<FlowDocument>,
}

#[derive(Debug, Serialize)]
struct NodeResults {
    result: Option<String>,
    conclusion: Option<String>,
}

struct AgentSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct AgentState {
    sessions: Arc<Mutex<HashMap<u64, AgentSession>>>,
    next_id: AtomicU64,
}

impl Drop for AgentState {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentOpenResult {
    session_id: u64,
    workspace: String,
    agent: String,
    opened_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexSessionResult {
    session_id: String,
    resume_command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentExit {
    session_id: u64,
    exit_code: Option<u32>,
    error: Option<String>,
}

fn validate_flow(document: &FlowDocument) -> Result<(), String> {
    if document.schema_version != 1 {
        return Err("不支持的 Flow 文件版本".into());
    }
    if document.name.trim().is_empty() || document.name.chars().count() > 160 {
        return Err("Flow 名称无效".into());
    }
    if !document.nodes.is_array() || !document.edges.is_array() {
        return Err("Flow 文件缺少节点或连接数组".into());
    }
    Ok(())
}

#[tauri::command]
fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        return value.strip_prefix(r"\\?\").unwrap_or(&value).to_string();
    }
    #[cfg(not(target_os = "windows"))]
    value.into_owned()
}

fn resolve_workspace(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.chars().count() > 4096 || path.chars().any(char::is_control) {
        return Err("工作区路径无效".into());
    }
    let requested = PathBuf::from(path);
    if !requested.is_dir() {
        return Err("工作区不存在或不是文件夹".into());
    }
    fs::canonicalize(requested).map_err(|error| format!("无法解析工作区路径：{error}"))
}

fn workspace_data_directory(workspace: &Path) -> PathBuf {
    workspace.join(WORKSPACE_DATA_DIRECTORY)
}

fn workspace_flow_path(workspace: &Path) -> PathBuf {
    workspace_data_directory(workspace).join(WORKSPACE_FLOW_FILE)
}

fn initialize_workspace_directories(workspace: &Path) -> Result<(), String> {
    for directory in [
        ".flow-canvas",
        ".flow-canvas/logs",
        ".flow-canvas/artifacts",
    ] {
        prepare_workspace_directory(workspace, directory)?;
    }
    Ok(())
}

fn prepare_workspace_directory(workspace: &Path, path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.chars().count() > 4096 || path.chars().any(char::is_control) {
        return Err("节点目录路径无效".into());
    }
    let normalized = path.replace('\\', "/");
    if normalized.split('/').any(|part| part == "..") {
        return Err("节点目录不能包含上级路径".into());
    }
    let requested = PathBuf::from(&normalized);
    let visible_workspace = PathBuf::from(display_path(workspace));
    let relative = if requested.is_absolute() {
        requested
            .strip_prefix(workspace)
            .or_else(|_| requested.strip_prefix(&visible_workspace))
            .map_err(|_| "节点目录必须位于当前工作区内".to_string())?
    } else {
        requested.as_path()
    };
    let mut directory = workspace.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            if component == Component::CurDir {
                continue;
            }
            return Err("节点目录必须使用工作区内路径".into());
        };
        if name.to_string_lossy().contains(':') {
            return Err("节点目录名称无效".into());
        }
        directory.push(name);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "节点目录不能是符号链接或文件：{}",
                        display_path(&directory)
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&directory).map_err(|error| {
                    format!("无法创建节点目录 {}：{error}", display_path(&directory))
                })?;
            }
            Err(error) => return Err(format!("无法访问节点目录：{error}")),
        }
        let canonical =
            fs::canonicalize(&directory).map_err(|error| format!("无法解析节点目录：{error}"))?;
        if !canonical.starts_with(workspace) {
            return Err("节点目录位于当前工作区之外".into());
        }
        directory = canonical;
    }
    Ok(directory)
}

#[derive(Deserialize)]
struct FrameworkTemplate {
    modules: Vec<FrameworkModule>,
    stages: Vec<FrameworkStage>,
}

#[derive(Deserialize)]
struct FrameworkModule {
    id: String,
}

#[derive(Deserialize)]
struct FrameworkStage {
    directory: String,
}

fn initialize_framework_directories(workspace: &Path) -> Result<(), String> {
    let template: FrameworkTemplate =
        serde_json::from_str(include_str!("../../src/framework-template.json"))
            .map_err(|error| format!("分析框架定义无效：{error}"))?;
    for stage in template.stages {
        for module in &template.modules {
            prepare_workspace_directory(workspace, &format!("{}/{}", stage.directory, module.id))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn initialize_framework(workspace: String) -> Result<(), String> {
    let workspace = resolve_workspace(&workspace)?;
    initialize_framework_directories(&workspace)
}

#[tauri::command]
fn prepare_node_directory(workspace: String, path: String) -> Result<String, String> {
    let workspace = resolve_workspace(&workspace)?;
    prepare_workspace_directory(&workspace, &path).map(|directory| display_path(&directory))
}

fn read_node_result_file(
    workspace: &Path,
    directory: &Path,
    name: &str,
) -> Result<Option<String>, String> {
    let requested = directory.join(name);
    let metadata = match fs::symlink_metadata(&requested) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法访问节点结果 {name}：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("节点结果 {name} 必须是普通文件"));
    }
    if metadata.len() > MAX_NODE_RESULT_BYTES {
        return Err(format!("节点结果 {name} 超过 2 MB"));
    }
    let target = workspace_target(workspace, &display_path(&requested))?;
    let file =
        fs::File::open(target).map_err(|error| format!("无法打开节点结果 {name}：{error}"))?;
    let mut content = String::new();
    file.take(MAX_NODE_RESULT_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|error| format!("无法读取节点结果 {name}，请使用 UTF-8 文本：{error}"))?;
    if content.len() as u64 > MAX_NODE_RESULT_BYTES {
        return Err(format!("节点结果 {name} 超过 2 MB"));
    }
    Ok(Some(content))
}

#[tauri::command]
fn read_node_results(workspace: String, path: String) -> Result<NodeResults, String> {
    let workspace = resolve_workspace(&workspace)?;
    let normalized = path.replace('\\', "/");
    if normalized.split('/').any(|part| part == "..") {
        return Err("节点目录不能包含上级路径".into());
    }
    let directory = workspace_target(&workspace, &normalized)?;
    if !directory.is_dir() {
        return Err("节点结果目录不是文件夹".into());
    }
    Ok(NodeResults {
        result: read_node_result_file(&workspace, &directory, "result.md")?,
        conclusion: read_node_result_file(&workspace, &directory, "conclusion.md")?,
    })
}

fn load_flow_file(requested: &Path) -> Result<FlowDocument, String> {
    let metadata =
        fs::metadata(&requested).map_err(|error| format!("无法读取 Flow 文件：{error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_FLOW_BYTES {
        return Err("Flow 文件不存在或超过 16 MB".into());
    }
    let content =
        fs::read_to_string(&requested).map_err(|error| format!("无法读取 Flow 文件：{error}"))?;
    let document: FlowDocument =
        serde_json::from_str(&content).map_err(|error| format!("Flow 文件格式无效：{error}"))?;
    validate_flow(&document)?;
    Ok(document)
}

fn save_flow_file(requested: &Path, document: &FlowDocument) -> Result<(), String> {
    validate_flow(&document)?;
    let parent = requested
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| "无法确定 Flow 文件所在目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 Flow 文件目录：{error}"))?;
    let serialized = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("无法生成 Flow 文件：{error}"))?;
    if serialized.len() as u64 > MAX_FLOW_BYTES {
        return Err("Flow 文件超过 16 MB".into());
    }
    let temporary = requested.with_extension("json.tmp");
    let backup = requested.with_extension("json.bak");
    fs::write(&temporary, serialized).map_err(|error| format!("无法写入 Flow 文件：{error}"))?;
    if requested.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| format!("无法清理 Flow 备份：{error}"))?;
        }
        fs::rename(requested, &backup).map_err(|error| format!("无法备份旧 Flow 文件：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, requested) {
        if backup.exists() {
            let _ = fs::rename(&backup, requested);
        }
        return Err(format!("无法完成 Flow 文件保存：{error}"));
    }
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|error| format!("Flow 已保存，但无法清理备份：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn open_workspace(path: String) -> Result<WorkspaceSnapshot, String> {
    let workspace = resolve_workspace(&path)?;
    initialize_workspace_directories(&workspace)?;
    initialize_framework_directories(&workspace)?;
    let flow_path = workspace_flow_path(&workspace);
    let document = if flow_path.exists() {
        Some(load_flow_file(&flow_path)?)
    } else {
        None
    };
    let name = workspace
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("工作区")
        .to_string();
    Ok(WorkspaceSnapshot {
        root: display_path(&workspace),
        name,
        flow_path: display_path(&flow_path),
        document,
    })
}

#[tauri::command]
fn startup_workspace() -> Result<Option<WorkspaceSnapshot>, String> {
    let Some(path) = std::env::args_os().nth(1) else {
        return Ok(None);
    };
    let path = path.to_string_lossy().into_owned();
    open_workspace(path).map(Some)
}

#[tauri::command]
fn save_workspace_flow(workspace: String, document: FlowDocument) -> Result<String, String> {
    let workspace = resolve_workspace(&workspace)?;
    initialize_workspace_directories(&workspace)?;
    let flow_path = workspace_flow_path(&workspace);
    save_flow_file(&flow_path, &document)?;
    Ok(display_path(&flow_path))
}

fn scan_directory(
    root: &Path,
    current: &Path,
    files: &mut Vec<WorkspaceFileRecord>,
) -> Result<(), String> {
    if files.len() >= 5000 {
        return Ok(());
    }
    let entries = fs::read_dir(current).map_err(|error| format!("无法读取工作区文件：{error}"))?;
    for entry in entries {
        if files.len() >= 5000 {
            break;
        }
        let entry = entry.map_err(|error| format!("无法读取工作区目录：{error}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if matches!(
                name.as_str(),
                ".flow-canvas" | ".git" | "node_modules" | "target" | "dist"
            ) {
                continue;
            }
            scan_directory(root, &path, files)?;
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("无法读取文件元数据：{error}"))?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        files.push(WorkspaceFileRecord {
            path: relative,
            size: metadata.len(),
            modified_at,
        });
    }
    Ok(())
}

#[tauri::command]
fn scan_workspace(workspace: String) -> Result<Vec<WorkspaceFileRecord>, String> {
    let workspace = resolve_workspace(&workspace)?;
    let mut files = Vec::new();
    scan_directory(&workspace, &workspace, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn workspace_target(workspace: &Path, path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.chars().count() > 4096 || path.chars().any(char::is_control) {
        return Err("目标路径无效".into());
    }
    let requested = PathBuf::from(path);
    let requested = if requested.is_absolute() {
        requested
    } else {
        workspace.join(requested)
    };
    let target = fs::canonicalize(&requested)
        .map_err(|error| format!("目标路径不存在或无法访问：{error}"))?;
    if !target.starts_with(workspace) {
        return Err("目标路径位于当前工作区之外，请先切换工作区".into());
    }
    Ok(target)
}

#[tauri::command]
fn validate_workspace_target(workspace: String, path: String) -> Result<String, String> {
    let workspace = resolve_workspace(&workspace)?;
    workspace_target(&workspace, &path).map(|target| display_path(&target))
}

#[cfg(target_os = "windows")]
fn agent_command(workspace: &Path, agent: &str) -> Result<CommandBuilder, String> {
    if agent != "codex_micu" {
        return Err("不支持的 AI 会话".into());
    }
    let mut command = CommandBuilder::new("wsl.exe");
    command.args([
        "--cd",
        &display_path(workspace),
        "--exec",
        "bash",
        "-lic",
        CODEX_MICU_COMMAND,
    ]);
    Ok(command)
}

#[cfg(not(target_os = "windows"))]
fn agent_command(workspace: &Path, agent: &str) -> Result<CommandBuilder, String> {
    if agent != "codex_micu" {
        return Err("不支持的 AI 会话".into());
    }
    let mut command = CommandBuilder::new("bash");
    command.args(["-lic", CODEX_MICU_COMMAND]);
    command.cwd(workspace);
    Ok(command)
}

#[tauri::command(async)]
fn agent_open(
    workspace: String,
    agent: String,
    rows: u16,
    cols: u16,
    on_data: Channel<Response>,
    on_exit: Channel<AgentExit>,
    state: State<'_, AgentState>,
) -> Result<AgentOpenResult, String> {
    let workspace = resolve_workspace(&workspace)?;
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().saturating_sub(2))
        .unwrap_or_default();
    let mut command = agent_command(&workspace, &agent)?;
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(4),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("无法创建 AI 终端：{error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("无法启动 {agent}：{error}"))?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("无法读取 AI 终端：{error}"))?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|error| format!("无法写入 AI 终端：{error}"))?,
    ));
    let master = Arc::new(Mutex::new(pair.master));
    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .sessions
        .lock()
        .map_err(|_| "AI 会话状态不可用".to_string())?
        .insert(
            session_id,
            AgentSession {
                master,
                writer,
                killer,
            },
        );

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if on_data
                        .send(Response::new(buffer[..count].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    let sessions = Arc::clone(&state.sessions);
    thread::spawn(move || {
        let result = child.wait();
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&session_id);
        }
        let payload = match result {
            Ok(status) => AgentExit {
                session_id,
                exit_code: Some(status.exit_code()),
                error: None,
            },
            Err(error) => AgentExit {
                session_id,
                exit_code: None,
                error: Some(error.to_string()),
            },
        };
        let _ = on_exit.send(payload);
    });

    Ok(AgentOpenResult {
        session_id,
        workspace: display_path(&workspace),
        agent,
        opened_at,
    })
}

fn codex_session_query(opened_at: u64) -> String {
    format!(
        r#"find "$HOME/.codex/sessions" -type f -name 'rollout-*.jsonl' -newermt "@{opened_at}" -print0 2>/dev/null | xargs -0 -r ls -t | head -n 1 | xargs -r sed -n '1s/.*"session_id":"\([^"]*\)".*/\1/p'"#
    )
}

#[tauri::command(async)]
fn agent_codex_session(
    workspace: String,
    opened_at: u64,
) -> Result<Option<CodexSessionResult>, String> {
    let workspace = resolve_workspace(&workspace)?;
    let query = codex_session_query(opened_at);
    #[cfg(target_os = "windows")]
    let output = {
        let mut command = Command::new("wsl.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .args([
                "--cd",
                &display_path(&workspace),
                "--exec",
                "bash",
                "-lic",
                &query,
            ])
            .output()
            .map_err(|error| format!("无法查询 WSL Codex 会话：{error}"))?
    };
    #[cfg(not(target_os = "windows"))]
    let output = Command::new("bash")
        .args(["-lic", &query])
        .current_dir(&workspace)
        .output()
        .map_err(|error| format!("无法查询 Codex 会话：{error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let session_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if session_id.is_empty()
        || session_id.len() < 20
        || session_id
            .chars()
            .any(|value| !(value.is_ascii_hexdigit() || value == '-'))
    {
        return Ok(None);
    }
    Ok(Some(CodexSessionResult {
        resume_command: format!("codex_micu resume {session_id}"),
        session_id,
    }))
}

#[tauri::command]
fn agent_write(session_id: u64, data: Vec<u8>, state: State<'_, AgentState>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let writer = state
        .sessions
        .lock()
        .map_err(|_| "AI 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|session| Arc::clone(&session.writer))
        .ok_or_else(|| "AI 会话已结束".to_string())?;
    let mut writer = writer.lock().map_err(|_| "AI 会话写入不可用".to_string())?;
    writer
        .write_all(&data)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("无法写入 AI 会话：{error}"))
}

#[tauri::command]
fn agent_resize(
    session_id: u64,
    rows: u16,
    cols: u16,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let master = state
        .sessions
        .lock()
        .map_err(|_| "AI 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|session| Arc::clone(&session.master))
        .ok_or_else(|| "AI 会话已结束".to_string())?;
    let result = master
        .lock()
        .map_err(|_| "AI 会话大小不可用".to_string())?
        .resize(PtySize {
            rows: rows.max(4),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("无法调整 AI 终端：{error}"));
    result
}

#[tauri::command]
fn agent_close(session_id: u64, state: State<'_, AgentState>) -> Result<(), String> {
    let mut session = state
        .sessions
        .lock()
        .map_err(|_| "AI 会话状态不可用".to_string())?
        .remove(&session_id)
        .ok_or_else(|| "AI 会话已结束".to_string())?;
    session
        .killer
        .kill()
        .map_err(|error| format!("无法关闭 AI 会话：{error}"))
}

#[tauri::command(async)]
fn launch_plugin(
    executable: Option<String>,
    workspace: String,
    path: String,
) -> Result<(), String> {
    let target = if workspace.trim().is_empty() {
        // 文档模式:无工作区上下文,目标为绝对路径或 URL,原样使用
        PathBuf::from(&path)
    } else {
        let workspace = resolve_workspace(&workspace)?;
        workspace_target(&workspace, &path)?
    };
    log::info!("[plugin] launch_plugin target={path} workspace={workspace}");
    if let Some(executable) = executable.filter(|value| !value.trim().is_empty()) {
        let executable = PathBuf::from(executable);
        Command::new(&executable)
            .arg(&target)
            .current_dir(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法启动外部插件：{error}"))
    } else {
        open::that(&target).map_err(|error| format!("无法打开目标路径：{error}"))
    }
}

/* =============== 文档模式:只读画布文档的支撑命令 =============== */

#[derive(Default)]
struct StartupDocument(Option<String>);

#[tauri::command]
fn startup_document_arg(state: State<StartupDocument>) -> Option<String> {
    state.0.clone()
}

#[tauri::command(async)]
fn read_document_text(path: String) -> Result<String, String> {
    let requested = Path::new(&path);
    let metadata = fs::metadata(requested).map_err(|error| format!("无法读取画布文档：{error}"))?;
    if !metadata.is_file() {
        return Err("画布文档不是文件".into());
    }
    if metadata.len() > MAX_FLOW_BYTES {
        return Err("画布文档不能超过 16 MB".into());
    }
    log::info!(
        "[document] read_document_text path={path} bytes={}",
        metadata.len()
    );
    fs::read_to_string(requested).map_err(|error| {
        log::warn!("[document] read failed path={path} error={error}");
        format!("无法以 UTF-8 读取画布文档：{error}")
    })
}

#[tauri::command(async)]
fn write_document_text(path: String, content: String) -> Result<(), String> {
    let requested = Path::new(&path);
    if !requested.is_file() {
        return Err("画布文档不存在，无法保存".into());
    }
    let bytes = content.len() as u64;
    if bytes > MAX_FLOW_BYTES {
        return Err("画布文档内容超过 16 MB，无法保存".into());
    }
    log::info!("[document] write_document_text path={path} bytes={bytes}");
    fs::write(requested, content).map_err(|error| {
        log::warn!("[document] write failed path={path} error={error}");
        format!("无法写入画布文档：{error}")
    })
}

pub fn run() {
    let startup = std::env::args()
        .nth(1)
        .filter(|value| !value.trim().is_empty());
    // 日志:写到 exe 同级 logs/ 文件夹(便携版可直接查看),同时输出 stdout
    let log_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("logs")))
        .unwrap_or_else(|| std::env::temp_dir().join("flow-canvas-logs"));
    let _ = fs::create_dir_all(&log_dir);
    log::info!("[startup] log directory: {}", log_dir.display());
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                        path: log_dir.clone(),
                        file_name: Some("flow".to_string()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(512_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .manage(AgentState::default())
        .manage(StartupDocument(startup))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            initialize_framework,
            prepare_node_directory,
            read_node_results,
            startup_workspace,
            save_workspace_flow,
            scan_workspace,
            validate_workspace_target,
            launch_plugin,
            read_document_text,
            write_document_text,
            startup_document_arg,
            agent_open,
            agent_codex_session,
            agent_write,
            agent_resize,
            agent_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flow Canvas");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("flow-canvas-{name}-{nonce}"))
    }

    #[test]
    fn workspace_initialization_and_save_stay_under_root() {
        let root = temporary_directory("workspace");
        fs::create_dir_all(&root).unwrap();
        let snapshot = open_workspace(root.to_string_lossy().into_owned()).unwrap();
        assert!(root.join(".flow-canvas/logs").is_dir());
        assert!(root.join(".flow-canvas/artifacts").is_dir());
        for stage in ["research", "test", "excute", "conclusion"] {
            for module in [
                "design",
                "processing",
                "analysis",
                "results",
                "presentation",
            ] {
                assert!(root.join(stage).join(module).is_dir());
            }
        }
        assert!(snapshot.document.is_none());

        let document = FlowDocument {
            schema_version: 1,
            name: "test flow".into(),
            nodes: serde_json::json!([]),
            edges: serde_json::json!([]),
            files: None,
            activities: None,
        };
        let saved = save_workspace_flow(root.to_string_lossy().into_owned(), document).unwrap();
        assert_eq!(PathBuf::from(saved), root.join(".flow-canvas/flow.json"));
        assert!(root.join(".flow-canvas/flow.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_rejects_targets_outside_root() {
        let root = temporary_directory("inside");
        let outside = temporary_directory("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let canonical = fs::canonicalize(&root).unwrap();
        assert!(workspace_target(&canonical, &outside.to_string_lossy()).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn framework_initialization_preserves_existing_work() {
        let root = temporary_directory("framework-repeat");
        fs::create_dir_all(&root).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        initialize_framework(workspace.clone()).unwrap();
        let result = root.join("research/design/notes.md");
        fs::write(&result, "existing research").unwrap();
        initialize_framework(workspace).unwrap();
        assert_eq!(fs::read_to_string(result).unwrap(), "existing research");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opening_existing_flow_preserves_its_graph_and_directories() {
        let root = temporary_directory("existing-flow");
        fs::create_dir_all(root.join(".flow-canvas")).unwrap();
        let document = FlowDocument {
            schema_version: 1,
            name: "existing flow".into(),
            nodes: serde_json::json!([{ "id": "custom-node", "data": { "title": "Custom" } }]),
            edges: serde_json::json!([]),
            files: None,
            activities: None,
        };
        let flow_path = root.join(".flow-canvas/flow.json");
        save_flow_file(&flow_path, &document).unwrap();
        let original = fs::read(&flow_path).unwrap();
        let snapshot = open_workspace(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(snapshot.document.unwrap().nodes, document.nodes);
        assert_eq!(fs::read(&flow_path).unwrap(), original);
        assert!(root.join("research/design").is_dir());
        assert!(root.join("test/design").is_dir());
        assert!(root.join("excute/design").is_dir());
        assert!(root.join("conclusion/design").is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_directory_creation_is_idempotent_and_rejects_escape() {
        let root = temporary_directory("node-directory");
        let outside = temporary_directory("node-outside");
        fs::create_dir_all(&root).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        let nested = "test/analysis/custom-method".to_string();
        let created = prepare_node_directory(workspace.clone(), nested.clone()).unwrap();
        assert!(Path::new(&created).is_dir());
        assert_eq!(
            prepare_node_directory(workspace.clone(), nested).unwrap(),
            created
        );
        assert_eq!(
            prepare_node_directory(workspace.clone(), created.clone()).unwrap(),
            created
        );
        assert!(prepare_node_directory(workspace.clone(), "../outside".into()).is_err());
        assert!(prepare_node_directory(workspace.clone(), "test/../../outside".into()).is_err());
        assert!(prepare_node_directory(workspace.clone(), "..\\outside".into()).is_err());
        assert!(prepare_node_directory(workspace.clone(), "".into()).is_err());
        assert!(
            prepare_node_directory(workspace.clone(), outside.to_string_lossy().into_owned())
                .is_err()
        );
        assert!(!outside.exists());
        fs::write(root.join("occupied"), "keep").unwrap();
        assert!(prepare_node_directory(workspace, "occupied/subdir".into()).is_err());
        assert_eq!(fs::read_to_string(root.join("occupied")).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_results_read_optional_utf8_files_without_modifying_them() {
        let root = temporary_directory("node-results");
        let directory = root.join("conclusion/analysis");
        fs::create_dir_all(&directory).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        let empty = read_node_results(workspace.clone(), "conclusion/analysis".into()).unwrap();
        assert!(empty.result.is_none());
        assert!(empty.conclusion.is_none());
        fs::write(directory.join("result.md"), "# 结果\n已完成分析。\n").unwrap();
        let partial = read_node_results(workspace.clone(), "conclusion/analysis".into()).unwrap();
        assert_eq!(partial.result.as_deref(), Some("# 结果\n已完成分析。\n"));
        assert!(partial.conclusion.is_none());
        fs::write(directory.join("conclusion.md"), "# 结论\n需要复核。\n").unwrap();
        let complete =
            read_node_results(workspace.clone(), directory.to_string_lossy().into_owned()).unwrap();
        assert_eq!(complete.result, partial.result);
        assert_eq!(complete.conclusion.as_deref(), Some("# 结论\n需要复核。\n"));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        assert_eq!(
            fs::read_to_string(directory.join("conclusion.md")).unwrap(),
            "# 结论\n需要复核。\n"
        );
        assert!(read_node_results(workspace, "missing".into()).is_err());
        assert!(!root.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_results_reject_escape_oversized_files_and_invalid_text() {
        let root = temporary_directory("node-results-invalid");
        let outside = temporary_directory("node-results-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        assert!(read_node_results(workspace.clone(), "../outside".into()).is_err());
        assert!(read_node_results(workspace.clone(), "..\\outside".into()).is_err());
        assert!(
            read_node_results(workspace.clone(), outside.to_string_lossy().into_owned()).is_err()
        );
        let result = root.join("result.md");
        fs::File::create(&result)
            .unwrap()
            .set_len(MAX_NODE_RESULT_BYTES + 1)
            .unwrap();
        assert!(read_node_results(workspace.clone(), ".".into()).is_err());
        fs::write(&result, [0xff, 0xfe]).unwrap();
        assert!(read_node_results(workspace.clone(), ".".into()).is_err());
        assert!(read_node_results(workspace, "result.md".into()).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn node_results_reject_links_outside_workspace() {
        let root = temporary_directory("node-results-link");
        let outside = temporary_directory("node-results-link-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("result.md"), "external result").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        assert!(read_node_results(workspace.clone(), "linked".into()).is_err());
        std::os::unix::fs::symlink(outside.join("result.md"), root.join("result.md")).unwrap();
        assert!(read_node_results(workspace.clone(), ".".into()).is_err());
        fs::remove_file(root.join("result.md")).unwrap();
        std::os::unix::fs::symlink(outside.join("missing.md"), root.join("conclusion.md")).unwrap();
        assert!(read_node_results(workspace, ".".into()).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("result.md")).unwrap(),
            "external result"
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn framework_and_node_directories_reject_symbolic_links() {
        let root = temporary_directory("symlink-root");
        let outside = temporary_directory("symlink-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("research")).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        assert!(initialize_framework(workspace.clone()).is_err());
        assert!(prepare_node_directory(workspace.clone(), "research/design/new".into()).is_err());
        assert!(!outside.join("design").exists());
        std::os::unix::fs::symlink(outside.join("missing"), root.join("dangling")).unwrap();
        assert!(prepare_node_directory(workspace, "dangling/child".into()).is_err());
        assert!(!outside.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_rejects_symbolic_links() {
        let root = temporary_directory("metadata-root");
        let outside = temporary_directory("metadata-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".flow-canvas")).unwrap();
        assert!(open_workspace(root.to_string_lossy().into_owned()).is_err());
        assert!(!outside.join("logs").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn codex_agent_is_bound_to_workspace_sandbox() {
        let root = temporary_directory("agent");
        fs::create_dir_all(&root).unwrap();
        let command = agent_command(&root, "codex_micu").unwrap();
        let arguments = command
            .get_argv()
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(arguments.contains("wsl.exe"));
        assert!(arguments.contains("codex_micu -C"));
        assert!(arguments.contains("workspace-write"));
        assert!(arguments.contains("never"));
        fs::remove_dir_all(root).unwrap();
    }
}
