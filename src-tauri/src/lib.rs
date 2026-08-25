use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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
const WORKSPACE_DATA_DIRECTORY: &str = ".flow-canvas";
const WORKSPACE_FLOW_FILE: &str = "flow.json";
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
    let data = workspace_data_directory(workspace);
    for directory in [data.clone(), data.join("logs"), data.join("artifacts")] {
        fs::create_dir_all(&directory).map_err(|error| {
            format!("无法初始化工作区目录 {}：{error}", display_path(&directory))
        })?;
    }
    Ok(())
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
    let output = Command::new("wsl.exe")
        .args([
            "--cd",
            &display_path(&workspace),
            "--exec",
            "bash",
            "-lic",
            &query,
        ])
        .output()
        .map_err(|error| format!("无法查询 WSL Codex 会话：{error}"))?;
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
    let workspace = resolve_workspace(&workspace)?;
    let target = workspace_target(&workspace, &path)?;
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

pub fn run() {
    tauri::Builder::default()
        .manage(AgentState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            startup_workspace,
            save_workspace_flow,
            scan_workspace,
            validate_workspace_target,
            launch_plugin,
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
