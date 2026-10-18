#!/usr/bin/env node
// ClassSentry 桌面版入口：把现有 Web 控制台（server.js）原样嵌进 Electron。
// 服务器仍在本地 127.0.0.1 监听，窗口只是它的一个壳；
// 数据目录（.env / alerts.json）跟随 userData，打包后可写。

import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 端口要在 main() 里 chdir 到用户数据目录、加载 .env 之后才能确定
// （用户在设置页改过 WEB_PORT 时，必须读到它，否则会一直探测 5175 直到超时）。
let PORT = 5175;
let URL_BASE = `http://127.0.0.1:${PORT}`;

function resolvePort(userData) {
  try {
    const text = fs.readFileSync(path.join(userData, ".env"), "utf8");
    const m = text.match(/^\s*WEB_PORT\s*=\s*["']?(\d+)["']?\s*$/m);
    if (m && !process.env.WEB_PORT) process.env.WEB_PORT = m[1];
  } catch {
    // 没有 .env 就用默认端口
  }
  const port = Number(process.env.WEB_PORT || 5175);
  PORT = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 5175;
  URL_BASE = `http://127.0.0.1:${PORT}`;
}

// Windows 通知与任务栏分组需要稳定的 AppUserModelID
app.setAppUserModelId("com.brockphlin.classsentry");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main().catch((e) => {
    // 否则启动失败时既无窗口也不退出，用户完全无从得知发生了什么
    dialog.showErrorBox("ClassSentry 启动失败", String(e?.message || e));
    app.quit();
  });
}

async function main() {
  // 配置与数据落在用户目录（macOS: ~/Library/Application Support/ClassSentry，
  // Windows: %APPDATA%\ClassSentry），打包后可写
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  process.chdir(userData);
  resolvePort(userData);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => app.quit());
  }

  await startServer();
  createWindow();

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on("activate", () => {
    // macOS：关窗后点 Dock 图标应重开窗口（服务一直在后台）
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
    // macOS：关窗不退出，监控继续；Cmd+Q 才真正退出
  });
}

async function startServer() {
  // 5175 已有活着的控制台（比如开发者另开的 node server.js）就直接复用
  if (await serverReachable()) return;
  await import(pathToFileURL(path.join(__dirname, "server.js")).href);
  // 等 express 就绪
  for (let i = 0; i < 40; i++) {
    if (await serverReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("本地服务启动超时");
}

function serverReachable() {
  return fetch(`${URL_BASE}/api/state`, { signal: AbortSignal.timeout(800) })
    .then((res) => res.ok)
    .catch(() => false);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 640,
    title: "ClassSentry 课堂哨兵",
    backgroundColor: "#faf9f5",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const template =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ]
      : [
          {
            label: "文件",
            submenu: [{ role: "quit", label: "退出" }],
          },
          { role: "editMenu" },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 外链交给系统浏览器；只放行 http(s)，避免 file:// 等协议被页面触发
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // 窗口只允许停留在本地控制台，禁止被导航到其它站点
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(URL_BASE)) event.preventDefault();
  });

  win.loadURL(URL_BASE);
}
