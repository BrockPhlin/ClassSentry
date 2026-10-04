#!/usr/bin/env node
// ClassSentry 桌面版入口：把现有 Web 控制台（server.js）原样嵌进 Electron。
// 服务器仍在本地 127.0.0.1 监听，窗口只是它的一个壳；
// 数据目录（.env / alerts.json）跟随 userData，打包后可写。

import { app, BrowserWindow, Menu, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT || 5175);
const URL_BASE = `http://127.0.0.1:${PORT}`;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main();
}

async function main() {
  // 配置与数据落在用户目录（~/Library/Application Support/ClassSentry），打包后可写
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  process.chdir(userData);

  // 首次启动播种：把随 app 附带的 .env 模板/既有配置复制过去，避免用户从头填
  const targetEnv = path.join(userData, ".env");
  const bundledEnv = path.join(process.resourcesPath || "", ".env.default");
  if (!fs.existsSync(targetEnv) && fs.existsSync(bundledEnv)) {
    fs.copyFileSync(bundledEnv, targetEnv);
  }

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
    shell.openExternal(url); // 外链交给系统浏览器
    return { action: "deny" };
  });

  win.loadURL(URL_BASE);
}
