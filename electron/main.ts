import { app, BrowserWindow, dialog, screen, type Rectangle } from 'electron';
import { join } from 'node:path';

import { DatabaseService, type WindowState } from './database';
import { DataStorageService } from './data-storage';
import { AppError, normalizeDatabaseError } from './errors';
import {
  registerIpcHandlers,
  removeIpcHandlers,
  setDataStorageTransition,
  type DataStorageOperations,
} from './ipc';

const MINIMUM_WIDTH = 1024;
const MINIMUM_HEIGHT = 680;
const DEFAULT_WIDTH = 1360;
const DEFAULT_HEIGHT = 820;

let mainWindow: BrowserWindow | null = null;
let database: DatabaseService | null = null;
let databaseFilePath: string | null = null;
let dataStorage: DataStorageService | null = null;
let applicationQuitting = false;

const storageOperations: DataStorageOperations = {
  getInfo: () => requireStorage().getInfo(),
  chooseDirectory: async (owner) => {
    const storage = requireStorage();
    const options: Electron.OpenDialogOptions = {
      title: '选择用户数据存放目录',
      defaultPath: storage.getInfo().directory,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此目录',
    };
    const selection = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (applicationQuitting || selection.canceled || !selection.filePaths[0]) return null;
    return storage.prepareSelection(selection.filePaths[0]);
  },
  changeDirectory: (input) => {
    const storage = requireStorage();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new AppError('WINDOW_UNAVAILABLE', '当前窗口不可用，请重新打开应用。');
    }
    setDataStorageTransition(true);
    try {
      const result = storage.changeDirectory(input);
      if (!result.changed) {
        setDataStorageTransition(false);
        return result;
      }
      database = storage.database;
      databaseFilePath = result.storage.databasePath;
      registerIpcHandlers(database, storageOperations);
      // 新文档提交后再解锁 IPC，旧页面中的表单不能写入切换后的数据库。
      mainWindow.webContents.once('did-navigate', () => setDataStorageTransition(false));
      setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const settingsUrl = new URL(mainWindow.webContents.getURL());
          settingsUrl.searchParams.set('page', 'settings');
          void mainWindow.webContents.loadURL(settingsUrl.toString()).catch((error: unknown) => {
            showStartupError(error);
            app.quit();
          });
        }
      });
      return result;
    } catch (error) {
      setDataStorageTransition(false);
      throw error;
    }
  },
};

function requireStorage(): DataStorageService {
  if (applicationQuitting || !dataStorage) {
    throw new AppError('STORAGE_UNAVAILABLE', '数据存储服务不可用，请重新启动应用。');
  }
  return dataStorage;
}

/** 自选目录不可达时保留原配置，恢复动作只接受用户选中的已有数据库。 */
async function initializeDataStorage(): Promise<boolean> {
  dataStorage = new DataStorageService(app.getPath('userData'), app.getVersion());
  let recoverDirectory: string | null = null;
  while (!applicationQuitting) {
    try {
      database = recoverDirectory
        ? dataStorage.recoverExisting(recoverDirectory)
        : dataStorage.initialize();
      databaseFilePath = dataStorage.getInfo().databasePath;
      return true;
    } catch (error) {
      const safeError = error instanceof AppError ? error : normalizeDatabaseError(error);
      const result = await dialog.showMessageBox({
        type: 'error',
        title: '无法打开用户数据',
        message: safeError.message,
        detail:
          '请确认原数据目录可访问（例如重新连接外置盘）。也可以选择原目录或其他包含 diet-tracker.sqlite3 的目录继续使用；不会创建空数据库或覆盖原数据。',
        buttons: ['重试', '选择已有数据目录', '退出'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (result.response === 2 || applicationQuitting) return false;
      if (result.response === 0) continue;
      const selection = await dialog.showOpenDialog({
        title: '选择包含 diet-tracker.sqlite3 的已有数据目录',
        properties: ['openDirectory'],
        buttonLabel: '使用已有数据',
      });
      if (!selection.canceled && selection.filePaths[0]) {
        recoverDirectory = selection.filePaths[0];
      }
    }
  }
  return false;
}

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

  app.whenReady().then(async () => {
    try {
      if (!(await initializeDataStorage()) || !database) {
        app.quit();
        return;
      }
      registerIpcHandlers(database, storageOperations);
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
    applicationQuitting = true;
    if (database && mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getNormalBounds();
      try {
        database.saveWindowState({ ...bounds, isMaximized: mainWindow.isMaximized() });
      } catch (error) {
        console.error('退出前保存窗口位置失败：', error);
      }
    }
    removeIpcHandlers();
    dataStorage?.close();
    dataStorage = null;
    database = null;
  });
}
