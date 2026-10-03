import { join } from 'node:path';

import { app, BrowserWindow, dialog, screen, type Rectangle } from 'electron';

import { DatabaseService, type WindowState } from './database';
import { AppError, normalizeDatabaseError } from './errors';
import { registerIpcHandlers, removeIpcHandlers } from './ipc';

const MINIMUM_WIDTH = 1024;
const MINIMUM_HEIGHT = 680;
const DEFAULT_WIDTH = 1360;
const DEFAULT_HEIGHT = 820;

let mainWindow: BrowserWindow | null = null;
let database: DatabaseService | null = null;
let databaseFilePath: string | null = null;

function isStateVisible(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) {
    return false;
  }
  const bounds: Rectangle = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  return screen.getAllDisplays().some(({ workArea }) => {
    const visibleWidth =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
      Math.max(bounds.x, workArea.x);
    const visibleHeight =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
      Math.max(bounds.y, workArea.y);
    return visibleWidth >= 100 && visibleHeight >= 100;
  });
}

function createMainWindow(): BrowserWindow {
  if (!database) {
    throw new AppError('DATABASE_NOT_READY', '本地数据库尚未初始化。');
  }

  const savedState = database.getWindowState();
  const useSavedPosition = savedState !== null && isStateVisible(savedState);
  const window = new BrowserWindow({
    ...(useSavedPosition ? { x: savedState.x, y: savedState.y } : { center: true }),
    width: savedState?.width ?? DEFAULT_WIDTH,
    height: savedState?.height ?? DEFAULT_HEIGHT,
    minWidth: MINIMUM_WIDTH,
    minHeight: MINIMUM_HEIGHT,
    show: false,
    title: '饮食与体重记录助手',
    backgroundColor: '#f6f8f7',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  window.once('ready-to-show', () => {
    if (savedState?.isMaximized) {
      window.maximize();
    }
    window.show();
  });
  window.on('close', () => {
    if (!database) {
      return;
    }
    const bounds = window.getNormalBounds();
    try {
      database.saveWindowState({
        ...bounds,
        isMaximized: window.isMaximized(),
      });
    } catch (error) {
      console.error('保存窗口位置失败：', error);
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
}

function showStartupError(error: unknown): void {
  const safeError = error instanceof AppError ? error : normalizeDatabaseError(error);
  const pathHint = databaseFilePath ? `\n\n数据库位置：${databaseFilePath}` : '';
  dialog.showErrorBox('饮食与体重记录助手无法启动', `${safeError.message}${pathHint}`);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    try {
      databaseFilePath = join(app.getPath('userData'), 'diet-tracker.sqlite3');
      database = new DatabaseService(databaseFilePath, app.getVersion());
      database.initialize();
      registerIpcHandlers(database);
      mainWindow = createMainWindow();
    } catch (error) {
      console.error('应用初始化失败：', error);
      showStartupError(error);
      app.quit();
    }

    app.on('activate', () => {
      if (!mainWindow && database) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (database && mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getNormalBounds();
      try {
        database.saveWindowState({ ...bounds, isMaximized: mainWindow.isMaximized() });
      } catch (error) {
        console.error('退出前保存窗口位置失败：', error);
      }
    }
    removeIpcHandlers();
    database?.close();
    database = null;
  });
}
