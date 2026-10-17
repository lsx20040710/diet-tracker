import type { IpcMainInvokeEvent } from 'electron';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../electron/database';
import { AppError } from '../electron/errors';
import { IPC_CHANNELS } from '../electron/ipc/channels';
import {
  registerIpcHandlers,
  removeIpcHandlers,
  setDataStorageTransition,
  type DataStorageOperations,
} from '../electron/ipc';
import type { DataStorageChangeInput, DataStorageInfo } from '../src/types/models';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  fileDatabases: [] as unknown[],
  owner: {},
  importCsv: vi.fn(),
  exportCsv: vi.fn(),
  exportExcel: vi.fn(),
  exportChartCsv: vi.fn(),
  exportChartImage: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => mocks.owner) },
  ipcMain: {
    handle: vi.fn(
      (channel: string, callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        mocks.handlers.set(channel, callback);
      },
    ),
    removeHandler: vi.fn((channel: string) => mocks.handlers.delete(channel)),
  },
}));

vi.mock('../electron/file-operation-service', () => ({
  FileOperationService: class {
    constructor(database: unknown) {
      mocks.fileDatabases.push(database);
    }

    importCsv = mocks.importCsv;
    exportCsv = mocks.exportCsv;
    exportExcel = mocks.exportExcel;
    exportChartCsv = mocks.exportChartCsv;
    exportChartImage = mocks.exportChartImage;
  },
}));

const storageInfo: DataStorageInfo = {
  directory: 'E:\\test-data',
  databasePath: 'E:\\test-data\\diet-tracker.sqlite3',
  defaultDirectory: 'E:\\default-data',
  isDefault: false,
};
const changeInput: DataStorageChangeInput = {
  selectionId: '028b3205-d38d-4774-9f7b-134cc3d6c84a',
  mode: 'migrate',
};
const canceledOperation = { canceled: true, filePath: null, recordCount: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const callback = mocks.handlers.get(channel);
  if (!callback) throw new Error(`Missing IPC handler: ${channel}`);
  return callback({ sender: {} } as IpcMainInvokeEvent, ...args);
}

function fakeDatabase(version = 'old') {
  const service = {
    getAppInfo: vi.fn(() => ({ version, databasePath: `${version}.sqlite3`, databaseVersion: 10 })),
    getAppSettings: vi.fn(() => ({ defaultEnergyUnit: 'kJ' })),
    saveAppSettings: vi.fn((settings: { defaultEnergyUnit: 'kcal' | 'kJ' }) => settings),
    listBodyRecords: vi.fn(() => []),
    deleteBodyRecord: vi.fn(),
  };
  return { service, database: service as unknown as DatabaseService };
}

describe('数据目录切换的 IPC 屏障', () => {
  let storage: DataStorageOperations;

  beforeEach(() => {
    removeIpcHandlers();
    setDataStorageTransition(false);
    vi.clearAllMocks();
    mocks.fileDatabases.length = 0;
    for (const operation of [
      mocks.importCsv,
      mocks.exportCsv,
      mocks.exportExcel,
      mocks.exportChartCsv,
      mocks.exportChartImage,
    ]) {
      operation.mockReset().mockResolvedValue(canceledOperation);
    }
    storage = {
      getInfo: vi.fn(() => storageInfo),
      chooseDirectory: vi.fn(async () => null),
      changeDirectory: vi.fn(() => ({
        changed: true,
        storage: storageInfo,
        previousDirectory: storageInfo.defaultDirectory,
      })),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerIpcHandlers(fakeDatabase().database, storage);
  });

  afterEach(() => {
    removeIpcHandlers();
    setDataStorageTransition(false);
    vi.restoreAllMocks();
  });

  it('通过白名单读取并保存默认热量单位', () => {
    const { database, service } = fakeDatabase();
    registerIpcHandlers(database, storage);
    expect(invoke(IPC_CHANNELS.getAppSettings)).toEqual({
      ok: true,
      data: { defaultEnergyUnit: 'kJ' },
    });
    expect(invoke(IPC_CHANNELS.saveAppSettings, { defaultEnergyUnit: 'kcal' })).toEqual({
      ok: true,
      data: { defaultEnergyUnit: 'kcal' },
    });
    expect(service.saveAppSettings).toHaveBeenCalledExactlyOnceWith({
      defaultEnergyUnit: 'kcal',
    });
  });

  it.each([
    undefined,
    null,
    {},
    { defaultEnergyUnit: 'cal' },
    { defaultEnergyUnit: 0 },
    { defaultEnergyUnit: 'kJ', arbitraryKey: 'value' },
  ])('非法热量单位参数不可到达数据库：%j', (input) => {
    const { database, service } = fakeDatabase();
    registerIpcHandlers(database, storage);
    expect(invoke(IPC_CHANNELS.saveAppSettings, input)).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    });
    expect(service.saveAppSettings).not.toHaveBeenCalled();
  });

  it.each([
    [IPC_CHANNELS.importCsv, ['foods'], 'importCsv'],
    [IPC_CHANNELS.exportCsv, [{ kind: 'foods' }], 'exportCsv'],
    [IPC_CHANNELS.exportExcel, [], 'exportExcel'],
    [
      IPC_CHANNELS.exportChartCsv,
      [{ suggestedName: 'chart.csv', headers: ['日期'], rows: [['2026-10-04']] }],
      'exportChartCsv',
    ],
    [
      IPC_CHANNELS.exportChartImage,
      [{ format: 'png', suggestedName: 'chart.png', data: 'data:image/png;base64,AAAA' }],
      'exportChartImage',
    ],
  ] as const)('%s 未结束时拒绝切换，取消操作后恢复', async (channel, args, operation) => {
    const pending = deferred<typeof canceledOperation>();
    mocks[operation].mockReturnValueOnce(pending.promise);
    const result = invoke(channel, ...args);

    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({
      ok: false,
      code: 'STORAGE_BUSY',
    });
    expect(storage.changeDirectory).not.toHaveBeenCalled();

    pending.resolve(canceledOperation);
    await expect(result).resolves.toMatchObject({ ok: true, data: { canceled: true } });
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({ ok: true });
    expect(storage.changeDirectory).toHaveBeenCalledExactlyOnceWith(changeInput);
  });

  it('尚未关闭目录选择框时也拒绝切换', async () => {
    const pending = deferred<null>();
    vi.mocked(storage.chooseDirectory).mockReturnValueOnce(pending.promise);
    const selection = invoke(IPC_CHANNELS.chooseStorageDirectory);

    expect(storage.chooseDirectory).toHaveBeenCalledExactlyOnceWith(mocks.owner);
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({
      ok: false,
      code: 'STORAGE_BUSY',
    });

    pending.resolve(null);
    await expect(selection).resolves.toEqual({ ok: true, data: null });
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({ ok: true });
  });

  it('导入失败后释放活动计数，后续切换仍可进行', async () => {
    const pending = deferred<never>();
    mocks.importCsv.mockReturnValueOnce(pending.promise);
    const result = invoke(IPC_CHANNELS.importCsv, 'foods');
    pending.reject(new AppError('CSV_IMPORT_FAILED', '导入失败'));

    await expect(result).resolves.toMatchObject({ ok: false, code: 'CSV_IMPORT_FAILED' });
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({ ok: true });
  });

  it('多个异步操作必须全部结束才能切换', async () => {
    const first = deferred<typeof canceledOperation>();
    const second = deferred<typeof canceledOperation>();
    mocks.importCsv.mockReturnValueOnce(first.promise);
    mocks.exportExcel.mockReturnValueOnce(second.promise);
    const importing = invoke(IPC_CHANNELS.importCsv, 'foods');
    const exporting = invoke(IPC_CHANNELS.exportExcel);
    first.resolve(canceledOperation);
    await importing;

    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({
      ok: false,
      code: 'STORAGE_BUSY',
    });
    second.resolve(canceledOperation);
    await exporting;
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({ ok: true });
  });

  it('重载过渡期阻止读、写、文件操作及再次选择或切换', async () => {
    const { database, service } = fakeDatabase();
    registerIpcHandlers(database, storage);
    setDataStorageTransition(true);

    for (const result of [
      invoke(IPC_CHANNELS.listBodyRecords),
      invoke(IPC_CHANNELS.deleteBodyRecord, 1),
      invoke(IPC_CHANNELS.getStorageInfo),
      invoke(IPC_CHANNELS.getAppSettings),
      invoke(IPC_CHANNELS.saveAppSettings, { defaultEnergyUnit: 'kcal' }),
      invoke(IPC_CHANNELS.changeStorageDirectory, changeInput),
      await invoke(IPC_CHANNELS.importCsv, 'foods'),
      await invoke(IPC_CHANNELS.chooseStorageDirectory),
    ]) {
      expect(result).toMatchObject({ ok: false, code: 'STORAGE_CHANGING' });
    }
    expect(service.listBodyRecords).not.toHaveBeenCalled();
    expect(service.deleteBodyRecord).not.toHaveBeenCalled();
    expect(service.getAppSettings).not.toHaveBeenCalled();
    expect(service.saveAppSettings).not.toHaveBeenCalled();
    expect(mocks.importCsv).not.toHaveBeenCalled();
    expect(storage.getInfo).not.toHaveBeenCalled();
    expect(storage.chooseDirectory).not.toHaveBeenCalled();
    expect(storage.changeDirectory).not.toHaveBeenCalled();

    setDataStorageTransition(false);
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({ ok: true });
  });

  it.each([
    undefined,
    null,
    {},
    { ...changeInput, mode: 'overwrite' },
    { ...changeInput, selectionId: 'E:\\arbitrary-directory' },
    { ...changeInput, directory: 'E:\\arbitrary-directory' },
  ])('非法切换参数不可到达存储服务：%j', (input) => {
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, input)).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    });
    expect(storage.changeDirectory).not.toHaveBeenCalled();
  });

  it('重新注册后调用新数据库，并保留先前未结束操作的计数', async () => {
    const first = fakeDatabase('first');
    const second = fakeDatabase('second');
    registerIpcHandlers(first.database, storage);
    const pending = deferred<typeof canceledOperation>();
    mocks.importCsv.mockReturnValueOnce(pending.promise);
    const importing = invoke(IPC_CHANNELS.importCsv, 'foods');

    registerIpcHandlers(second.database, storage);
    expect(invoke(IPC_CHANNELS.getAppInfo)).toMatchObject({
      ok: true,
      data: { version: 'second' },
    });
    expect(first.service.getAppInfo).not.toHaveBeenCalled();
    expect(second.service.getAppInfo).toHaveBeenCalledOnce();
    expect(mocks.fileDatabases.at(-1)).toBe(second.database);
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({
      ok: false,
      code: 'STORAGE_BUSY',
    });

    pending.resolve(canceledOperation);
    await importing;
    expect(invoke(IPC_CHANNELS.changeStorageDirectory, changeInput)).toMatchObject({ ok: true });
  });

  it('退出清理移除全部白名单处理器', () => {
    expect(mocks.handlers.size).toBe(Object.keys(IPC_CHANNELS).length);
    removeIpcHandlers();
    expect(mocks.handlers.size).toBe(0);
  });
});
