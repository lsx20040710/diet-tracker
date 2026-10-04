import fs, {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../electron/database';
import {
  DATABASE_FILENAME,
  DataStorageService,
  STORAGE_CONFIG_FILENAME,
} from '../electron/data-storage';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
    renameSync: vi.fn(original.renameSync),
    copyFileSync: vi.fn(original.copyFileSync),
    unlinkSync: vi.fn(original.unlinkSync),
  };
});

describe('用户数据目录选择与安全迁移', () => {
  let temporaryDirectory: string;
  let defaultDirectory: string;
  let selectedDirectory: string;
  let storage: DataStorageService;
  const date = '2026-10-04';
  const services: DatabaseService[] = [];
  const storages: DataStorageService[] = [];

  function addWeight(service: DatabaseService, weight: number): void {
    service.upsertBodyRecord({
      recordDate: date,
      weight,
      bodyFatPercentage: null,
      waistCircumference: null,
      note: '迁移验收记录',
    });
  }

  function createExisting(directory: string, weight = 81): DatabaseService {
    mkdirSync(directory, { recursive: true });
    const service = new DatabaseService(join(directory, DATABASE_FILENAME), 'test');
    services.push(service);
    service.initialize();
    addWeight(service, weight);
    service.close();
    return service;
  }

  function migrate(): void {
    const selection = storage.prepareSelection(selectedDirectory);
    storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' });
  }

  function allStoredRows(databasePath: string): Record<string, unknown[]> {
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      return Object.fromEntries(
        tables.map((table) => {
          const name = String(table.name);
          return [
            name,
            inspection
              .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
              .all(),
          ];
        }),
      );
    } finally {
      inspection.close();
    }
  }

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-storage-test-'));
    defaultDirectory = join(temporaryDirectory, 'default');
    selectedDirectory = join(temporaryDirectory, 'selected');
    mkdirSync(selectedDirectory);
    storage = new DataStorageService(defaultDirectory, 'test');
    storages.push(storage);
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.close();
    for (const service of storages.splice(0)) service.close();
    vi.resetAllMocks();
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  it('首次运行创建初始建议目录，显示实际路径并保存启动指针', () => {
    storage.initialize();
    expect(storage.getInfo()).toEqual({
      directory: defaultDirectory,
      databasePath: join(defaultDirectory, DATABASE_FILENAME),
      defaultDirectory,
      isDefault: true,
    });
    expect(JSON.parse(readFileSync(storage.configurationPath, 'utf8'))).toEqual({
      version: 1,
      directory: defaultDirectory,
    });
    expect(storage.initialize()).toBe(storage.database);
  });

  it('空目录迁移包含已提交 WAL 的一致快照，清理源库且重启继续使用新位置', () => {
    storage.initialize();
    addWeight(storage.database, 72.5);
    const food = storage.database.createFood({
      name: '自定义迁移食物',
      category: '主食',
      caloriesPer100g: 200,
      proteinPer100g: 12,
      carbsPer100g: 20,
      fatPer100g: 8,
      defaultServingGrams: 80,
      isFavorite: true,
    });
    const supplement = storage.database.createFood({
      name: '迁移补剂',
      category: '补剂',
      caloriesPer100g: 0,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 0,
      isSupplement: true,
      defaultServingGrams: 1,
      countInNutrition: false,
      supplementFrequency: 'daily',
      supplementDosage: 1.5,
      supplementDosageUnit: 'serving',
    });
    storage.database.createMealRecord({
      recordDate: date,
      mealType: 'lunch',
      foodId: food.id,
      amount: 1.5,
      unitType: 'serving',
    });
    storage.database.createMealRecord({
      recordDate: date,
      mealType: 'supplement',
      foodId: supplement.id,
      amount: 1.5,
      unitType: 'serving',
    });
    storage.database.createFoodCombination({
      name: '迁移组合',
      items: [{ foodId: food.id, amount: 1.5, unitType: 'serving' }],
    });
    storage.database.saveWindowState({ width: 1200, height: 800, isMaximized: false });
    const unrelatedFile = join(defaultDirectory, 'personal-file.txt');
    writeFileSync(unrelatedFile, '迁移应保留原目录中的其他文件');
    const sourceRows = allStoredRows(storage.getInfo().databasePath);
    expect(existsSync(`${join(defaultDirectory, DATABASE_FILENAME)}-wal`)).toBe(true);
    const originalService = storage.database;
    const selection = storage.prepareSelection(selectedDirectory);
    expect(selection).toMatchObject({ hasExistingDatabase: false, isCurrent: false });
    const result = storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' });
    expect(result.changed).toBe(true);
    expect(result.previousDirectory).toBe(defaultDirectory);
    expect(result.storage.migrationNotice).toMatchObject({
      status: 'completed',
      sourceDirectory: defaultDirectory,
      sourceDatabasePath: join(defaultDirectory, DATABASE_FILENAME),
    });
    expect(storage.database).not.toBe(originalService);
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(72.5);
    expect(allStoredRows(storage.getInfo().databasePath)).toEqual(sourceRows);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect(existsSync(`${join(defaultDirectory, DATABASE_FILENAME)}${suffix}`)).toBe(false);
    }
    expect(readFileSync(unrelatedFile, 'utf8')).toBe('迁移应保留原目录中的其他文件');
    expect(readdirSync(selectedDirectory)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('.migration-')]),
    );
    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    storages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo()).toMatchObject({
      directory: selectedDirectory,
      isDefault: false,
      migrationNotice: { status: 'completed', sourceDirectory: defaultDirectory },
    });
    expect(restarted.database.getDashboard(date).bodyRecord?.weight).toBe(72.5);
    expect(allStoredRows(restarted.getInfo().databasePath)).toEqual(sourceRows);
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('新位置后续记录不会在原目录重新生成数据库', () => {
    storage.initialize();
    addWeight(storage.database, 72);
    migrate();
    addWeight(storage.database, 71);
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(false);
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(71);
    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    storages.push(restarted);
    restarted.initialize();
    expect(restarted.database.getDashboard(date).bodyRecord?.weight).toBe(71);
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('只有残留 WAL 日志的目录不能迁移新库或生成默认空库', () => {
    storage.initialize();
    const orphanedJournal = `${join(selectedDirectory, DATABASE_FILENAME)}-wal`;
    writeFileSync(orphanedJournal, 'recoverable-journal');
    expect(() => storage.prepareSelection(selectedDirectory)).toThrow('残留日志');
    expect(readFileSync(orphanedJournal, 'utf8')).toBe('recoverable-journal');
    expect(existsSync(join(selectedDirectory, DATABASE_FILENAME))).toBe(false);
    const firstRunDirectory = join(temporaryDirectory, 'orphaned-default');
    mkdirSync(firstRunDirectory);
    writeFileSync(`${join(firstRunDirectory, DATABASE_FILENAME)}-wal`, 'recoverable-journal');
    const firstRun = new DataStorageService(firstRunDirectory);
    storages.push(firstRun);
    expect(() => firstRun.initialize()).toThrow('残留日志');
    expect(existsSync(join(firstRunDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('目标已有数据库时拒绝迁移覆写，明确选择继续使用后保留两个库及恢复快照', () => {
    storage.initialize();
    addWeight(storage.database, 72);
    createExisting(selectedDirectory, 81);
    const before = readFileSync(join(selectedDirectory, DATABASE_FILENAME));
    const selection = storage.prepareSelection(selectedDirectory);
    expect(selection.hasExistingDatabase).toBe(true);
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }),
    ).toThrow('不能覆写');
    expect(readFileSync(join(selectedDirectory, DATABASE_FILENAME))).toEqual(before);
    const explicitSelection = storage.prepareSelection(selectedDirectory);
    storage.changeDirectory({ selectionId: explicitSelection.selectionId, mode: 'existing' });
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(81);
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(true);
    expect(storage.getInfo().migrationNotice).toBeUndefined();
    const previous = new DatabaseService(join(defaultDirectory, DATABASE_FILENAME), 'test');
    services.push(previous);
    previous.initialize();
    expect(previous.getDashboard(date).bodyRecord?.weight).toBe(72);
    const backup = readdirSync(selectedDirectory).find((name) => name.includes('.before-open-'));
    expect(backup).toBeDefined();
    DatabaseService.validateExistingDatabase(join(selectedDirectory, backup!));
  });

  it('选择当前目录不迁移、不创建额外数据库', () => {
    storage.initialize();
    const selection = storage.prepareSelection(defaultDirectory);
    const result = storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' });
    expect(result.changed).toBe(false);
    expect(
      readdirSync(defaultDirectory).some(
        (name) => name.includes('before-open') || name.includes('migration'),
      ),
    ).toBe(false);
  });

  it('旧 selection 无法重放，新的选择会使之前的 token 失效', () => {
    storage.initialize();
    const first = storage.prepareSelection(selectedDirectory);
    storage.prepareSelection(defaultDirectory);
    expect(() =>
      storage.changeDirectory({ selectionId: first.selectionId, mode: 'migrate' }),
    ).toThrow('已失效');
    const selection = storage.prepareSelection(selectedDirectory);
    storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' });
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }),
    ).toThrow('已失效');
  });

  it('选择后目标出现数据库，重新检查后拒绝覆写', () => {
    storage.initialize();
    const selection = storage.prepareSelection(selectedDirectory);
    createExisting(selectedDirectory, 88);
    const original = readFileSync(join(selectedDirectory, DATABASE_FILENAME));
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }),
    ).toThrow('不能覆写');
    expect(readFileSync(join(selectedDirectory, DATABASE_FILENAME))).toEqual(original);
    expect(storage.getInfo().directory).toBe(defaultDirectory);
  });

  it('快照提交瞬间文件出现时 EXCL 拒绝，绝不覆写新文件', () => {
    storage.initialize();
    const selection = storage.prepareSelection(selectedDirectory);
    vi.mocked(copyFileSync).mockImplementationOnce((source, destination, mode) => {
      writeFileSync(destination, 'race-created-file', { flag: 'wx' });
      fs.copyFileSync(source, destination, mode);
    });
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }),
    ).toThrow('未覆写');
    expect(readFileSync(join(selectedDirectory, DATABASE_FILENAME), 'utf8')).toBe(
      'race-created-file',
    );
    expect(storage.getInfo().directory).toBe(defaultDirectory);
  });

  it('配置提交失败保留当前数据库和配置，并保留目标快照供恢复', () => {
    storage.initialize();
    addWeight(storage.database, 72);
    const before = readFileSync(storage.configurationPath, 'utf8');
    const previous = storage.database;
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(() => migrate()).toThrow('原配置和当前数据仍保留');
    expect(readFileSync(storage.configurationPath, 'utf8')).toBe(before);
    expect(storage.database).toBe(previous);
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(72);
    DatabaseService.validateExistingDatabase(join(selectedDirectory, DATABASE_FILENAME));
    expect(
      readdirSync(defaultDirectory).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
    ).toBe(false);
  });

  it('目录权限错误发生在迁移前，原数据和配置保持不变', () => {
    storage.initialize();
    const original = readFileSync(storage.configurationPath, 'utf8');
    const selection = storage.prepareSelection(selectedDirectory);
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (String(path).includes('.diet-tracker-write-test-')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return fs.openSync(path, flags, mode);
    });
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }),
    ).toThrow('不可写');
    expect(readFileSync(storage.configurationPath, 'utf8')).toBe(original);
    expect(existsSync(join(selectedDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('提交成功后临时文件和锁清理失败仍返回成功，锁可在下次操作重新清理', () => {
    storage.initialize();
    const lockPath = `${storage.configurationPath}.lock`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(unlinkSync).mockImplementation((path) => {
      if (String(path).endsWith('.lock') || String(path).includes('.migration-')) {
        throw Object.assign(new Error('temporary cleanup denied'), { code: 'EACCES' });
      }
      fs.unlinkSync(path);
    });
    const selection = storage.prepareSelection(selectedDirectory);
    expect(
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }).changed,
    ).toBe(true);
    expect(storage.getInfo().directory).toBe(selectedDirectory);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).released).toBe(true);
    vi.mocked(unlinkSync).mockReset();
    const nextDirectory = join(temporaryDirectory, 'next');
    mkdirSync(nextDirectory);
    const next = storage.prepareSelection(nextDirectory);
    expect(
      storage.changeDirectory({ selectionId: next.selectionId, mode: 'migrate' }).changed,
    ).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    warning.mockRestore();
  });

  it('提交成功后旧连接关闭失败仍返回新服务，主进程可正确重注册', () => {
    storage.initialize();
    addWeight(storage.database, 72);
    const previous = storage.database;
    const closeFailure = vi.spyOn(previous, 'close').mockImplementationOnce(() => {
      throw new Error('old connection cleanup failed');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const selection = storage.prepareSelection(selectedDirectory);
    expect(
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }).changed,
    ).toBe(true);
    expect(storage.database).not.toBe(previous);
    expect(storage.getInfo().directory).toBe(selectedDirectory);
    expect(storage.getInfo().migrationNotice).toMatchObject({
      status: 'cleanup_pending',
      sourceDirectory: defaultDirectory,
    });
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(true);
    addWeight(storage.database, 71);
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(71);
    closeFailure.mockRestore();
    previous.close();
    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    storages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo().migrationNotice?.status).toBe('cleanup_pending');
    expect(restarted.database.getDashboard(date).bodyRecord?.weight).toBe(71);
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(true);
    warning.mockRestore();
  });

  it('原数据库删除权限不足时切换仍成功，保留原库并持久化清理提示', () => {
    storage.initialize();
    addWeight(storage.database, 72);
    const sourcePath = join(defaultDirectory, DATABASE_FILENAME);
    vi.mocked(unlinkSync).mockImplementation((path) => {
      if (String(path) === sourcePath) {
        throw Object.assign(new Error('source cleanup denied'), { code: 'EACCES' });
      }
      fs.unlinkSync(path);
    });
    const selection = storage.prepareSelection(selectedDirectory);
    const result = storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' });
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice).toMatchObject({
      status: 'cleanup_pending',
      sourceDatabasePath: sourcePath,
    });
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(72);
    const sourceRows = allStoredRows(sourcePath);
    expect(allStoredRows(result.storage.databasePath)).toEqual(sourceRows);
    expect(JSON.parse(readFileSync(storage.configurationPath, 'utf8')).migrationNotice.status).toBe(
      'cleanup_pending',
    );
    vi.mocked(unlinkSync).mockReset();
    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    storages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo().migrationNotice?.status).toBe('cleanup_pending');
    expect(allStoredRows(sourcePath)).toEqual(sourceRows);
    expect(restarted.getInfo().directory).toBe(selectedDirectory);
  });

  it('源库已清理但清理结果保存失败时仍返回成功，重启不再次删除原路径的新文件', () => {
    storage.initialize();
    addWeight(storage.database, 72);
    let commits = 0;
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (++commits === 2) {
        throw Object.assign(new Error('notice commit denied'), { code: 'EACCES' });
      }
      fs.renameSync(source, destination);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const selection = storage.prepareSelection(selectedDirectory);
    const result = storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' });
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(72);
    const sourcePath = join(defaultDirectory, DATABASE_FILENAME);
    expect(existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(readFileSync(storage.configurationPath, 'utf8')).migrationNotice.status).toBe(
      'cleanup_pending',
    );
    writeFileSync(sourcePath, '原路径后来出现的文件必须保留', { flag: 'wx' });
    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    storages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo().migrationNotice?.status).toBe('cleanup_pending');
    expect(restarted.database.getDashboard(date).bodyRecord?.weight).toBe(72);
    expect(readFileSync(sourcePath, 'utf8')).toBe('原路径后来出现的文件必须保留');
    warning.mockRestore();
  });

  it('数据库目录缺失不会静默回到默认位置或生成空库', () => {
    storage.initialize();
    migrate();
    storage.close();
    renameSync(selectedDirectory, `${selectedDirectory}-offline`);
    const restarted = new DataStorageService(defaultDirectory);
    storages.push(restarted);
    expect(() => restarted.initialize()).toThrow('不会创建空数据库');
    expect(existsSync(selectedDirectory)).toBe(false);
    expect(JSON.parse(readFileSync(restarted.configurationPath, 'utf8')).directory).toBe(
      selectedDirectory,
    );
  });

  it('保存过的数据库文件缺失时不生成替代空库', () => {
    storage.initialize();
    migrate();
    storage.close();
    renameSync(
      join(selectedDirectory, DATABASE_FILENAME),
      join(selectedDirectory, 'recoverable.sqlite3'),
    );
    const restarted = new DataStorageService(defaultDirectory);
    storages.push(restarted);
    expect(() => restarted.initialize()).toThrow('不会创建空库');
    expect(existsSync(join(selectedDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('坏配置不会回退空库，明确连接已有库后保留坏配置备份并可重启', () => {
    mkdirSync(defaultDirectory);
    const invalid = '{broken-config';
    writeFileSync(join(defaultDirectory, STORAGE_CONFIG_FILENAME), invalid);
    createExisting(selectedDirectory, 88);
    expect(() => storage.initialize()).toThrow('配置损坏');
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(false);
    storage.recoverExisting(selectedDirectory);
    expect(storage.database.getDashboard(date).bodyRecord?.weight).toBe(88);
    const backup = readdirSync(defaultDirectory).find((name) => name.includes('.backup-'));
    expect(readFileSync(join(defaultDirectory, backup!), 'utf8')).toBe(invalid);
    storage.close();
    storage.initialize();
    expect(storage.getInfo().directory).toBe(selectedDirectory);
  });

  it.each([
    { version: 2, directory: 'ignored' },
    { version: 1, directory: '../relative' },
    { version: 1, directory: null },
  ])('非法配置 %j 不会创建默认库', (configuration) => {
    mkdirSync(defaultDirectory);
    writeFileSync(join(defaultDirectory, STORAGE_CONFIG_FILENAME), JSON.stringify(configuration));
    expect(() => storage.initialize()).toThrow('配置损坏');
    expect(existsSync(join(defaultDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('明确恢复到空目录被拒绝，原配置保持不变', () => {
    mkdirSync(defaultDirectory);
    writeFileSync(storage.configurationPath, '{broken');
    expect(() => storage.recoverExisting(selectedDirectory)).toThrow('不会创建空库');
    expect(readFileSync(storage.configurationPath, 'utf8')).toBe('{broken');
    expect(existsSync(join(selectedDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('普通 SQLite 文件和损坏数据库在可写初始化前被拒绝且字节不变', () => {
    storage.initialize();
    const databasePath = join(selectedDirectory, DATABASE_FILENAME);
    const unrelated = new DatabaseSync(databasePath);
    unrelated.exec(
      "CREATE TABLE personal_records (private_text TEXT); INSERT INTO personal_records VALUES ('保留')",
    );
    unrelated.close();
    const original = readFileSync(databasePath);
    let selection = storage.prepareSelection(selectedDirectory);
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'existing' }),
    ).toThrow('不是本程序');
    expect(readFileSync(databasePath)).toEqual(original);
    writeFileSync(databasePath, 'not SQLite');
    selection = storage.prepareSelection(selectedDirectory);
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'existing' }),
    ).toThrow('无法读取');
    expect(readFileSync(databasePath, 'utf8')).toBe('not SQLite');
    expect(storage.getInfo().directory).toBe(defaultDirectory);
  });

  it('未来版本数据库被拒绝且文件不变', () => {
    storage.initialize();
    createExisting(selectedDirectory);
    const databasePath = join(selectedDirectory, DATABASE_FILENAME);
    const future = new DatabaseSync(databasePath);
    future.exec(
      "INSERT INTO schema_migrations VALUES (11, 'future', '2026-10-04'); PRAGMA user_version=11",
    );
    future.close();
    const original = readFileSync(databasePath);
    const selection = storage.prepareSelection(selectedDirectory);
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'existing' }),
    ).toThrow('不受');
    expect(readFileSync(databasePath)).toEqual(original);
  });

  it('其他实例持有锁时拒绝并发迁移且不删除其锁', () => {
    storage.initialize();
    const lockPath = `${storage.configurationPath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
    const selection = storage.prepareSelection(selectedDirectory);
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }),
    ).toThrow('另一个');
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(selectedDirectory, DATABASE_FILENAME))).toBe(false);
  });

  it('配置被外部修改后拒绝依据陈旧指针迁移', () => {
    storage.initialize();
    const external = JSON.stringify({ version: 1, directory: selectedDirectory });
    writeFileSync(storage.configurationPath, external);
    const selection = storage.prepareSelection(selectedDirectory);
    expect(() =>
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }),
    ).toThrow('其他操作修改');
    expect(readFileSync(storage.configurationPath, 'utf8')).toBe(external);
    expect(storage.getInfo().directory).toBe(defaultDirectory);
  });

  it('同一目录的联接别名识别为当前位置，不创建另一份库', () => {
    storage.initialize();
    const alias = join(temporaryDirectory, 'alias');
    symlinkSync(defaultDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const selection = storage.prepareSelection(alias);
    expect(selection.isCurrent).toBe(true);
    expect(
      storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' }).changed,
    ).toBe(false);
  });

  it('源数据库硬链接不能以另一条 WAL 路径打开', () => {
    storage.initialize();
    linkSync(join(defaultDirectory, DATABASE_FILENAME), join(selectedDirectory, DATABASE_FILENAME));
    expect(() => storage.prepareSelection(selectedDirectory)).toThrow('硬链接');
    expect(storage.getInfo().directory).toBe(defaultDirectory);
  });
});
