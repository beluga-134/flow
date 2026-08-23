import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FlowDocument, PluginManifest, WorkspaceFileRecord, WorkspaceSnapshot } from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface AgentOpenResult { sessionId: number; workspace: string; agent: string; openedAt: number; }
export interface CodexSessionResult { sessionId: string; resumeCommand: string; }
export interface AgentExit { sessionId: number; exitCode: number | null; error: string | null; }
export type AgentData = ArrayBuffer | Uint8Array | number[];

export async function chooseDirectory(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) return null;
  return (await open({ directory: true, multiple: false, defaultPath })) as string | null;
}

export async function openWorkspace(path: string): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("open_workspace", { path });
}

export async function startupWorkspace(): Promise<WorkspaceSnapshot | null> {
  return invoke<WorkspaceSnapshot | null>("startup_workspace");
}

export async function saveWorkspaceFlow(workspace: string, flowDocument: FlowDocument): Promise<string> {
  if (!isTauri()) {
    const blob = new Blob([JSON.stringify(flowDocument, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${flowDocument.name || "flow"}.flow.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    return anchor.download;
  }
  return invoke<string>("save_workspace_flow", { workspace, document: flowDocument });
}

export async function scanWorkspace(workspace: string): Promise<WorkspaceFileRecord[]> {
  return invoke<WorkspaceFileRecord[]>("scan_workspace", { workspace });
}

export async function findCodexSession(workspace: string, openedAt: number): Promise<CodexSessionResult | null> {
  return invoke<CodexSessionResult | null>("agent_codex_session", { workspace, openedAt });
}

export async function validateWorkspaceTarget(workspace: string, path: string): Promise<string> {
  return invoke<string>("validate_workspace_target", { workspace, path });
}

export async function openPlugin(manifest: PluginManifest, workspace: string, path: string): Promise<void> {
  if (!isTauri()) {
    window.alert(`${manifest.name}\n\n浏览器预览不会启动外部程序。\n路径：${path}`);
    return;
  }
  await invoke("launch_plugin", { executable: manifest.executable, workspace, path });
}

export async function openAgent(
  workspace: string,
  agent: "codex_micu",
  rows: number,
  cols: number,
  onData: (data: AgentData) => void,
  onExit: (exit: AgentExit) => void,
): Promise<AgentOpenResult> {
  const dataChannel = new Channel<AgentData>();
  dataChannel.onmessage = onData;
  const exitChannel = new Channel<AgentExit>();
  exitChannel.onmessage = onExit;
  return invoke<AgentOpenResult>("agent_open", { workspace, agent, rows, cols, onData: dataChannel, onExit: exitChannel });
}

export async function writeAgent(sessionId: number, data: Uint8Array): Promise<void> {
  if (!sessionId || data.length === 0) return;
  await invoke("agent_write", { sessionId, data: Array.from(data) });
}

export async function interruptAgent(sessionId: number): Promise<void> {
  if (!sessionId) return;
  await writeAgent(sessionId, new TextEncoder().encode("\u0003"));
}

export async function resizeAgent(sessionId: number, rows: number, cols: number): Promise<void> {
  if (!sessionId) return;
  await invoke("agent_resize", { sessionId, rows, cols });
}

export async function closeAgent(sessionId: number): Promise<void> {
  if (!sessionId) return;
  try { await invoke("agent_close", { sessionId }); } catch { /* Session may already have exited. */ }
}
