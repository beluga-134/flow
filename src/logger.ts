/**
 * logger.ts — 前端日志(落盘到 exe 同级 logs/flow.log)
 *
 * 经 tauri-plugin-log 写入(Rust 侧已配置 Folder target);
 * 任何失败静默忽略(日志不能反过来干扰主流程)。
 */

import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

const safe = (fn: (message: string) => Promise<void>) => (message: string) => {
  try {
    fn(message).catch(() => undefined);
  } catch {
    /* 非 Tauri 环境(浏览器预览)直接忽略 */
  }
};

export const appLog = {
  info: safe(logInfo),
  warn: safe(logWarn),
  error: safe(logError),
};
