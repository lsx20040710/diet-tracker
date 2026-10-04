import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

describe('移动用户数据库时保护源目录的并发变化', () => {
  let temporaryDirectory: string;
  let defaultDirectory: string;
  let targetDirectory: string;
  let sourcePath: string;
  let storage: DataStorageService;
  const openedStorages: DataStorageService[] = [];
  const openedDatabases: DatabaseService[] = [];
  const recordDate = '2026-10-04';

  function readWeight(databasePath: string): number {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare('SELECT weight FROM body_records WHERE record_date = ?')
        .get(recordDate) as { weight: number };
      return row.weight;
    } finally {
      database.close();
    }
  }

  function migrate() {
    const selection = storage.prepareSelection(targetDirectory);
    return storage.changeDirectory({ selectionId: selection.selectionId, mode: 'migrate' });
  }

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-move-safety-'));
    defaultDirectory = join(temporaryDirectory, 'source');
    targetDirectory = join(temporaryDirectory, 'target');
    sourcePath = join(defaultDirectory, DATABASE_FILENAME);
    mkdirSync(targetDirectory);
    storage = new DataStorageService(defaultDirectory, 'test');
    openedStorages.push(storage);
    storage.initialize();
    openedDatabases.push(storage.database);
    storage.database.upsertBodyRecord({
      recordDate,
      weight: 72,
      bodyFatPercentage: null,
      waistCircumference: null,
      note: '独立临时目录中的迁移安全验收数据',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(renameSync).mockReset();
    for (const service of openedStorages.splice(0)) service.close();
    for (const database of openedDatabases.splice(0)) database.close();
    if (!temporaryDirectory.startsWith(join(tmpdir(), 'diet-tracker-move-safety-'))) {
      throw new Error('Refusing to remove an unexpected test directory');
    }
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  it('快照后外部 SQLite 提交的新记录不能被源清理删除，提示在重启后保留', () => {
    vi.mocked(renameSync).mockImplementationOnce((source, destination) => {
      fs.renameSync(source, destination);
      const external = new DatabaseSync(sourcePath);
      try {
        external
          .prepare('UPDATE body_records SET weight = ? WHERE record_date = ?')
          .run(74, recordDate);
      } finally {
        external.close();
      }
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.directory).toBe(targetDirectory);
    expect(result.storage.migrationNotice).toMatchObject({
      status: 'cleanup_pending',
      sourceDirectory: defaultDirectory,
      sourceDatabasePath: sourcePath,
    });
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);
    expect(existsSync(sourcePath)).toBe(true);
    expect(readWeight(sourcePath)).toBe(74);

    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    openedStorages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo()).toMatchObject({
      directory: targetDirectory,
      migrationNotice: { status: 'cleanup_pending', sourceDatabasePath: sourcePath },
    });
    expect(restarted.database.getDashboard(recordDate).bodyRecord?.weight).toBe(72);
    expect(readWeight(sourcePath)).toBe(74);
  });

  it('源连接关闭后主库路径被替换时，不删除替代文件或移走的原库', () => {
    const sourceDatabase = storage.database;
    const closeOriginal = sourceDatabase.close.bind(sourceDatabase);
    const preservedSource = join(defaultDirectory, 'source-preserved.sqlite3');
    vi.spyOn(sourceDatabase, 'close').mockImplementationOnce(() => {
      closeOriginal();
      fs.renameSync(sourcePath, preservedSource);
      writeFileSync(sourcePath, 'unrelated replacement file', { flag: 'wx' });
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(readFileSync(sourcePath, 'utf8')).toBe('unrelated replacement file');
    expect(readWeight(preservedSource)).toBe(72);
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);
  });

  it('源连接关闭后出现的陌生日志不会被当作原库日志删除', () => {
    const sourceDatabase = storage.database;
    const closeOriginal = sourceDatabase.close.bind(sourceDatabase);
    const foreignJournal = `${sourcePath}-wal`;
    vi.spyOn(sourceDatabase, 'close').mockImplementationOnce(() => {
      closeOriginal();
      writeFileSync(foreignJournal, 'unrelated new journal', { flag: 'wx' });
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(true);
    expect(readFileSync(foreignJournal, 'utf8')).toBe('unrelated new journal');
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);
  });

  it('配置提交后目标被外部连接删除记录时，保留源数据而不清理唯一完整副本', () => {
    vi.mocked(renameSync).mockImplementationOnce((source, destination) => {
      fs.renameSync(source, destination);
      const external = new DatabaseSync(join(targetDirectory, DATABASE_FILENAME));
      try {
        external.prepare('DELETE FROM body_records WHERE record_date = ?').run(recordDate);
      } finally {
        external.close();
      }
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(true);
    expect(readWeight(sourcePath)).toBe(72);
    expect(storage.database.getDashboard(recordDate).bodyRecord).toBeNull();
  });

  it('配置提交后目标业务表被外部删除时，源库保留并持久化未清理通知', () => {
    vi.mocked(renameSync).mockImplementationOnce((source, destination) => {
      fs.renameSync(source, destination);
      const external = new DatabaseSync(join(targetDirectory, DATABASE_FILENAME));
      try {
        external.exec('DROP TABLE body_records');
      } finally {
        external.close();
      }
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(true);
    expect(readWeight(sourcePath)).toBe(72);
    const configuration = JSON.parse(
      readFileSync(join(defaultDirectory, STORAGE_CONFIG_FILENAME), 'utf8'),
    ) as { migrationNotice: { status: string } };
    expect(configuration.migrationNotice.status).toBe('cleanup_pending');
  });

  it('源连接关闭后目标最终完整性验证期间发生的新提交，也不能触发删源', () => {
    const sourceDatabase = storage.database;
    const closeOriginal = sourceDatabase.close.bind(sourceDatabase);
    let sourceClosed = false;
    vi.spyOn(sourceDatabase, 'close').mockImplementationOnce(() => {
      closeOriginal();
      sourceClosed = true;
    });
    const validateOriginal = DatabaseService.validateExistingDatabase;
    let externalWriteBlocked = false;
    vi.spyOn(DatabaseService, 'validateExistingDatabase').mockImplementation((databasePath) => {
      validateOriginal(databasePath);
      if (
        !sourceClosed ||
        externalWriteBlocked ||
        databasePath !== join(targetDirectory, DATABASE_FILENAME)
      ) {
        return;
      }
      const external = new DatabaseSync(databasePath, { timeout: 1 });
      try {
        external.prepare('DELETE FROM body_records WHERE record_date = ?').run(recordDate);
      } catch (error) {
        externalWriteBlocked = error instanceof Error && /locked|busy/i.test(error.message);
        throw error;
      } finally {
        external.close();
      }
    });

    const result = migrate();
    expect(externalWriteBlocked).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(true);
    expect(readWeight(sourcePath)).toBe(72);
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);
    expect(storage.getInfo().directory).toBe(targetDirectory);
  });

  it('源连接成功关闭后，原库被其他连接写入时不删除新的记录', () => {
    const sourceDatabase = storage.database;
    const closeOriginal = sourceDatabase.close.bind(sourceDatabase);
    vi.spyOn(sourceDatabase, 'close').mockImplementationOnce(() => {
      closeOriginal();
      const external = new DatabaseSync(sourcePath);
      try {
        external
          .prepare('UPDATE body_records SET weight = ? WHERE record_date = ?')
          .run(75, recordDate);
      } finally {
        external.close();
      }
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(true);
    expect(readWeight(sourcePath)).toBe(75);
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);
  });

  it('源关闭后目标目录被移走并重建时，不把新路径中的另一数据库视为迁移结果', () => {
    const sourceDatabase = storage.database;
    const closeOriginal = sourceDatabase.close.bind(sourceDatabase);
    const preservedTarget = join(temporaryDirectory, 'target-preserved');
    vi.spyOn(sourceDatabase, 'close').mockImplementationOnce(() => {
      closeOriginal();
      // Windows 不允许重命名正在被 SQLite 占用的目录，注入连接释放后模拟外部替换。
      storage.database.close();
      fs.renameSync(targetDirectory, preservedTarget);
      mkdirSync(targetDirectory);
      const replacement = new DatabaseService(
        join(targetDirectory, DATABASE_FILENAME),
        'replacement',
      );
      openedDatabases.push(replacement);
      replacement.initialize();
      replacement.upsertBodyRecord({
        recordDate,
        weight: 91,
        bodyFatPercentage: null,
        waistCircumference: null,
        note: '目标目录被替换后的独立数据库',
      });
      replacement.close();
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(readWeight(sourcePath)).toBe(72);
    expect(readWeight(join(preservedTarget, DATABASE_FILENAME))).toBe(72);
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(91);
    expect(storage.getInfo().directory).toBe(targetDirectory);
  });

  it('源连接关闭失败时切换仍成功，但保留旧库并在重启后提示待处理', () => {
    const sourceDatabase = storage.database;
    const closeOriginal = sourceDatabase.close.bind(sourceDatabase);
    vi.spyOn(sourceDatabase, 'close').mockImplementationOnce(() => {
      throw new Error('Injected source connection close failure');
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(true);
    expect(readWeight(sourcePath)).toBe(72);
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);

    closeOriginal();
    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    openedStorages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo().migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(true);
  });

  it('源库已删除后无法保存完成通知，不把已提交切换误报失败，也不在重启后重删', () => {
    vi.mocked(renameSync)
      .mockImplementationOnce((source, destination) => fs.renameSync(source, destination))
      .mockImplementationOnce(() => {
        throw new Error('Injected migration notice persistence failure');
      });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.directory).toBe(targetDirectory);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(existsSync(sourcePath)).toBe(false);
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);

    writeFileSync(sourcePath, 'unrelated later file', { flag: 'wx' });
    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    openedStorages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo()).toMatchObject({
      directory: targetDirectory,
      migrationNotice: { status: 'cleanup_pending', sourceDatabasePath: sourcePath },
    });
    expect(readFileSync(sourcePath, 'utf8')).toBe('unrelated later file');
    expect(restarted.database.getDashboard(recordDate).bodyRecord?.weight).toBe(72);
  });

  it('新配置提交后启动指针被外部改回旧目录时，不能删除该指针仍引用的原库', () => {
    const configurationPath = join(defaultDirectory, STORAGE_CONFIG_FILENAME);
    const externalConfiguration = `${JSON.stringify({ version: 1, directory: defaultDirectory })}\n`;
    vi.mocked(renameSync).mockImplementationOnce((source, destination) => {
      fs.renameSync(source, destination);
      writeFileSync(configurationPath, externalConfiguration, 'utf8');
    });

    const result = migrate();
    expect(result.changed).toBe(true);
    expect(result.storage.directory).toBe(targetDirectory);
    expect(result.storage.migrationNotice?.status).toBe('cleanup_pending');
    expect(readFileSync(configurationPath, 'utf8')).toBe(externalConfiguration);
    expect(existsSync(sourcePath)).toBe(true);
    expect(readWeight(sourcePath)).toBe(72);
    expect(readWeight(join(targetDirectory, DATABASE_FILENAME))).toBe(72);

    storage.close();
    const restarted = new DataStorageService(defaultDirectory, 'restarted');
    openedStorages.push(restarted);
    restarted.initialize();
    expect(restarted.getInfo().directory).toBe(defaultDirectory);
    expect(restarted.database.getDashboard(recordDate).bodyRecord?.weight).toBe(72);
  });
});
