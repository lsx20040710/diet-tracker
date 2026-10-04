import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  DataStorageChangeInput,
  DataStorageChangeResult,
  DataStorageInfo,
  DataStorageMigrationNotice,
  DataStorageSelection,
} from '../src/types/models';
import { DatabaseService } from './database';
import { AppError } from './errors';

export const DATABASE_FILENAME = 'diet-tracker.sqlite3';
export const STORAGE_CONFIG_FILENAME = 'data-storage.json';

interface StorageConfiguration {
  version: 1;
  directory: string;
  migrationNotice?: DataStorageMigrationNotice | null;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

interface SourceMigrationState {
  directory: string;
  databasePath: string;
  directoryIdentity: FileIdentity;
  databaseIdentity: FileIdentity;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  dataVersion: number;
}

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return (
    first.dev === second.dev && first.ino === second.ino && first.birthtimeNs === second.birthtimeNs
  );
}

function isMigrationNotice(value: unknown): value is DataStorageMigrationNotice {
  return (
    value !== null &&
    typeof value === 'object' &&
    'status' in value &&
    (value.status === 'completed' || value.status === 'cleanup_pending') &&
    'sourceDirectory' in value &&
    typeof value.sourceDirectory === 'string' &&
    isAbsolute(value.sourceDirectory) &&
    !value.sourceDirectory.includes('\0') &&
    'sourceDatabasePath' in value &&
    typeof value.sourceDatabasePath === 'string' &&
    isAbsolute(value.sourceDatabasePath) &&
    !value.sourceDatabasePath.includes('\0') &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

function pathsEqual(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US')
    : first === second;
}

function storageError(error: unknown, message: string): AppError {
  return error instanceof AppError
    ? error
    : new AppError('STORAGE_OPERATION_FAILED', message, { cause: error });
}

function cleanupTemporaryFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 清理临时文件失败不改变已经提交的数据切换结果，也不遮住原始错误。
    console.warn('数据位置操作的临时文件暂时无法清理，用户数据仍保留。');
  }
}

/** 固定启动配置仅保存目录指针；用户记录始终位于当前选定目录。 */
export class DataStorageService {
  readonly configurationPath: string;
  private currentDatabase: DatabaseService | null = null;
  private currentDirectory: string | null = null;
  private currentDatabaseIdentity: FileIdentity | null = null;
  private currentDirectoryIdentity: FileIdentity | null = null;
  private migrationNotice: DataStorageMigrationNotice | null = null;
  private expectedConfiguration: string | null = null;
  private busy = false;
  private selections = new Map<string, DataStorageSelection>();

  constructor(
    private readonly defaultDirectory: string,
    private readonly appVersion = '0.0.0',
    private readonly configurationDirectory = defaultDirectory,
  ) {
    this.configurationPath = join(resolve(configurationDirectory), STORAGE_CONFIG_FILENAME);
  }

  get database(): DatabaseService {
    if (!this.currentDatabase) {
      throw new AppError('DATABASE_NOT_READY', '用户数据尚未打开，请重新连接原数据目录。');
    }
    return this.currentDatabase;
  }

  initialize(): DatabaseService {
    if (this.currentDatabase) {
      return this.currentDatabase;
    }
    this.expectedConfiguration = this.readConfiguration();
    this.migrationNotice = null;
    let directory: string;
    if (this.expectedConfiguration === null) {
      // 只有完全没有启动配置的首次运行才允许创建默认数据库。
      mkdirSync(this.defaultDirectory, { recursive: true });
      directory = this.canonicalDirectory(this.defaultDirectory);
    } else {
      let configuration: StorageConfiguration;
      try {
        const parsed: unknown = JSON.parse(this.expectedConfiguration);
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          !('version' in parsed) ||
          parsed.version !== 1 ||
          !('directory' in parsed) ||
          typeof parsed.directory !== 'string' ||
          !isAbsolute(parsed.directory) ||
          !parsed.directory.trim() ||
          parsed.directory.includes('\0') ||
          ('migrationNotice' in parsed &&
            parsed.migrationNotice !== null &&
            !isMigrationNotice(parsed.migrationNotice))
        ) {
          throw new Error('Invalid configuration');
        }
        configuration = parsed as StorageConfiguration;
      } catch (error) {
        throw new AppError(
          'STORAGE_CONFIG_INVALID',
          '数据存储位置配置损坏，请重新选择包含已有数据库的目录。原配置和数据会保留。',
          { cause: error },
        );
      }
      directory = this.canonicalDirectory(configuration.directory);
      this.migrationNotice = configuration.migrationNotice ?? null;
      this.assertExistingDatabase(join(directory, DATABASE_FILENAME));
    }
    const databasePath = join(directory, DATABASE_FILENAME);
    if (existsSync(databasePath)) {
      this.assertExistingDatabase(databasePath);
    } else {
      this.assertNoOrphanedDatabaseJournals(databasePath);
    }
    const candidate = new DatabaseService(databasePath, this.appVersion);
    const directoryIdentity = this.directoryIdentity(directory);
    const existingIdentity = existsSync(databasePath) ? this.fileIdentity(databasePath) : null;
    try {
      candidate.initialize();
      const databaseIdentity = this.fileIdentity(databasePath);
      if (existingIdentity && !sameIdentity(existingIdentity, databaseIdentity)) {
        throw new AppError(
          'STORAGE_DATABASE_CHANGED',
          '数据库文件在打开时发生变化，请关闭其他程序后重试。',
        );
      }
      if (this.expectedConfiguration === null) {
        this.withConfigurationLock(() => this.writeConfiguration(directory));
      }
      this.currentDatabase = candidate;
      this.currentDirectory = directory;
      this.currentDatabaseIdentity = databaseIdentity;
      this.currentDirectoryIdentity = directoryIdentity;
      return candidate;
    } catch (error) {
      candidate.close();
      throw storageError(error, '无法打开用户数据目录，请检查目录权限。原数据仍保留。');
    }
  }

  getInfo(): DataStorageInfo {
    if (!this.currentDatabase || !this.currentDirectory) {
      throw new AppError('DATABASE_NOT_READY', '用户数据尚未打开，请重新连接原数据目录。');
    }
    const directory = this.currentDirectory;
    const databasePath = join(directory, DATABASE_FILENAME);
    let defaultDirectory = resolve(this.defaultDirectory);
    try {
      if (existsSync(this.defaultDirectory)) defaultDirectory = realpathSync(this.defaultDirectory);
    } catch {
      // 初始建议目录暂不可访问，不影响当前数据库或已经提交的迁移结果。
    }
    return {
      directory,
      databasePath,
      defaultDirectory,
      isDefault: pathsEqual(directory, defaultDirectory),
      ...(this.migrationNotice ? { migrationNotice: this.migrationNotice } : {}),
    };
  }

  prepareSelection(directory: string): DataStorageSelection {
    this.getInfo();
    const selection = this.inspectDirectory(directory);
    this.selections.clear();
    this.selections.set(selection.selectionId, selection);
    return selection;
  }

  changeDirectory(input: DataStorageChangeInput): DataStorageChangeResult {
    return this.withConfigurationLock(() => {
      if (input.mode !== 'migrate' && input.mode !== 'existing') {
        throw new AppError('STORAGE_SELECTION_INVALID', '请选择迁移当前数据或使用已有数据库。');
      }
      const selected = this.selections.get(input.selectionId);
      this.selections.delete(input.selectionId);
      if (!selected) {
        throw new AppError('STORAGE_SELECTION_EXPIRED', '目录选择已失效，请重新选择目录。');
      }
      const selection = this.inspectDirectory(selected.directory);
      const previousDirectory = this.getInfo().directory;
      if (selection.isCurrent) {
        return { changed: false, storage: this.getInfo(), previousDirectory };
      }
      if (input.mode === 'migrate' && selection.hasExistingDatabase) {
        throw new AppError(
          'STORAGE_DATABASE_EXISTS',
          '所选目录已有数据库，不能覆写。请明确选择使用已有数据库，或选择其他目录。',
        );
      }
      if (input.mode === 'existing' && !selection.hasExistingDatabase) {
        throw new AppError('STORAGE_DATABASE_MISSING', '所选目录中没有已有数据库，请重新选择。');
      }
      this.assertConfigurationUnchanged();
      this.assertWritableDirectory(selection.directory);
      let source: SourceMigrationState | null = null;
      if (input.mode === 'migrate') {
        source = this.prepareSourceMigration();
        this.migrateSnapshot(selection.databasePath);
      }
      this.assertExistingDatabase(selection.databasePath);
      const pendingNotice: DataStorageMigrationNotice | null = source
        ? {
            status: 'cleanup_pending',
            sourceDirectory: source.directory,
            sourceDatabasePath: source.databasePath,
            message:
              '数据已迁移到新位置，原数据库的清理尚未确认完成。请检查原路径；程序不会在重启后自动删除旧文件。',
          }
        : null;
      const activation = this.activateDatabase(
        selection.directory,
        input.mode === 'existing',
        pendingNotice,
        source,
      );
      if (source) {
        this.finishSourceMigration(
          source,
          activation.previousClosed,
          activation.sourceUnchanged,
          activation.targetDataVersion,
        );
      }
      this.selections.clear();
      return { changed: true, storage: this.getInfo(), previousDirectory };
    });
  }

  /** 启动错误恢复只接受明确选中的已有有效数据库，绝不生成空库。 */
  recoverExisting(directory: string): DatabaseService {
    this.expectedConfiguration = this.readConfiguration();
    return this.withConfigurationLock(() => {
      const canonicalDirectory = this.canonicalDirectory(directory);
      const databasePath = join(canonicalDirectory, DATABASE_FILENAME);
      this.assertExistingDatabase(databasePath);
      this.assertWritableDirectory(canonicalDirectory);
      this.activateDatabase(canonicalDirectory, true);
      this.selections.clear();
      return this.database;
    });
  }

  close(): void {
    this.currentDatabase?.close();
    this.currentDatabase = null;
    this.currentDirectory = null;
    this.currentDatabaseIdentity = null;
    this.currentDirectoryIdentity = null;
    this.selections.clear();
  }

  private canonicalDirectory(directory: string): string {
    if (!directory.trim() || !isAbsolute(directory) || directory.includes('\0')) {
      throw new AppError('STORAGE_DIRECTORY_INVALID', '请选择一个有效的本地目录。');
    }
    try {
      if (!statSync(directory).isDirectory()) {
        throw new Error('Not a directory');
      }
      return realpathSync(directory);
    } catch (error) {
      throw new AppError(
        'STORAGE_DIRECTORY_UNAVAILABLE',
        `用户数据目录不可访问：${directory}\n请重新连接磁盘或选择包含已有数据库的目录。不会创建空数据库。`,
        { cause: error },
      );
    }
  }

  private inspectDirectory(directory: string): DataStorageSelection {
    const canonicalDirectory = this.canonicalDirectory(directory);
    const databasePath = join(canonicalDirectory, DATABASE_FILENAME);
    const hasExistingDatabase = this.databaseExists(databasePath);
    if (!hasExistingDatabase) {
      this.assertNoOrphanedDatabaseJournals(databasePath);
    }
    const isCurrent =
      this.currentDirectory !== null && pathsEqual(canonicalDirectory, this.currentDirectory);
    if (hasExistingDatabase && !isCurrent && this.currentDatabase) {
      const current = statSync(this.currentDatabase.getAppInfo().databasePath);
      const selected = statSync(databasePath);
      if (current.dev === selected.dev && current.ino === selected.ino) {
        throw new AppError(
          'STORAGE_DATABASE_ALIAS',
          '所选数据库是当前数据库的硬链接，请选择其他目录。',
        );
      }
    }
    return {
      selectionId: randomUUID(),
      directory: canonicalDirectory,
      databasePath,
      hasExistingDatabase,
      isCurrent,
    };
  }

  private databaseExists(databasePath: string): boolean {
    try {
      const file = lstatSync(databasePath);
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new AppError('STORAGE_DATABASE_INVALID', '数据库路径必须是所选目录内的普通文件。');
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw storageError(error, '无法检查所选目录中的数据库，请检查权限。');
    }
  }

  private assertExistingDatabase(databasePath: string): void {
    if (!this.databaseExists(databasePath)) {
      throw new AppError(
        'STORAGE_DATABASE_MISSING',
        '已选数据目录中的数据库不存在，请重新连接原数据或选择已有数据库。不会创建空库。',
      );
    }
    DatabaseService.validateExistingDatabase(databasePath);
  }

  private assertNoOrphanedDatabaseJournals(databasePath: string): void {
    if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
      throw new AppError(
        'STORAGE_DATABASE_JOURNALS_EXIST',
        '所选目录存在没有主数据库的残留日志，请先恢复原数据库或选择其他目录。不会覆写或删除日志。',
      );
    }
  }

  private assertWritableDirectory(directory: string): void {
    const probePath = join(directory, `.diet-tracker-write-test-${randomUUID()}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(probePath, 'wx', 0o600);
    } catch (error) {
      throw new AppError(
        'STORAGE_DIRECTORY_READ_ONLY',
        '所选目录不可写，请检查权限或选择其他目录。',
        { cause: error },
      );
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        cleanupTemporaryFile(probePath);
      }
    }
  }

  private fileIdentity(path: string): FileIdentity {
    const file = lstatSync(path, { bigint: true });
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new AppError(
        'STORAGE_DATABASE_CHANGED',
        '数据库路径已变为其他文件或符号链接，请检查原目录。',
      );
    }
    return file;
  }

  private directoryIdentity(path: string): FileIdentity {
    const directory = lstatSync(path, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new AppError('STORAGE_DIRECTORY_CHANGED', '数据目录的真实位置发生变化，请检查原目录。');
    }
    return directory;
  }

  private assertSourceIdentity(
    source: Pick<
      SourceMigrationState,
      'directory' | 'databasePath' | 'directoryIdentity' | 'databaseIdentity'
    >,
  ): void {
    if (
      !pathsEqual(realpathSync(source.directory), source.directory) ||
      !sameIdentity(this.directoryIdentity(source.directory), source.directoryIdentity)
    ) {
      throw new AppError(
        'STORAGE_DIRECTORY_CHANGED',
        '原目录的真实位置或目录身份已改变，不能自动清理。',
      );
    }
    const database = lstatSync(source.databasePath, { bigint: true });
    if (
      !database.isFile() ||
      database.isSymbolicLink() ||
      database.nlink !== 1n ||
      !sameIdentity(database, source.databaseIdentity)
    ) {
      throw new AppError(
        'STORAGE_DATABASE_CHANGED',
        '原数据库文件被替换或出现链接，不能自动清理。',
      );
    }
  }

  private prepareSourceMigration(): SourceMigrationState {
    const source = {
      directory: this.currentDirectory!,
      databasePath: this.database.getAppInfo().databasePath,
      directoryIdentity: this.currentDirectoryIdentity!,
      databaseIdentity: this.currentDatabaseIdentity!,
    };
    this.assertSourceIdentity(source);
    // 先落盘使关闭后的文件变化也能反映快照后的外部提交，随后快照仍由 SQLite 保证一致。
    this.database.checkpointForMigration();
    this.assertSourceIdentity(source);
    const file = lstatSync(source.databasePath, { bigint: true });
    return {
      ...source,
      size: file.size,
      mtimeNs: file.mtimeNs,
      ctimeNs: file.ctimeNs,
      dataVersion: this.database.getDataVersion(),
    };
  }

  private finishSourceMigration(
    source: SourceMigrationState,
    previousClosed: boolean,
    sourceUnchanged: boolean,
    targetDataVersion: number | null,
  ): void {
    let notice: DataStorageMigrationNotice = {
      status: 'cleanup_pending',
      sourceDirectory: source.directory,
      sourceDatabasePath: source.databasePath,
      message:
        '已使用新数据位置，但原数据库尚未清理。请核对原路径后手动处理；程序不会在重启后自动删除。',
    };
    try {
      if (!previousClosed) {
        throw new AppError(
          'STORAGE_SOURCE_NOT_CLOSED',
          '旧数据库连接未成功关闭，已保留原数据库，请退出程序后检查旧路径。',
        );
      }
      if (!sourceUnchanged) {
        throw new AppError(
          'STORAGE_SOURCE_UPDATED',
          '原数据库在快照后被其他连接修改，已保留原数据库；请核对旧位置的最新记录。',
        );
      }
      this.database.withMigrationCleanupLock(() => {
        try {
          this.assertSourceIdentity({
            directory: this.currentDirectory!,
            databasePath: join(this.currentDirectory!, DATABASE_FILENAME),
            directoryIdentity: this.currentDirectoryIdentity!,
            databaseIdentity: this.currentDatabaseIdentity!,
          });
          if (targetDataVersion === null || this.database.getDataVersion() !== targetDataVersion) {
            throw new Error('Target database changed after verification');
          }
          DatabaseService.validateExistingDatabase(join(this.currentDirectory!, DATABASE_FILENAME));
        } catch (error) {
          throw new AppError(
            'STORAGE_TARGET_CHANGED',
            '新位置的数据库在验证后被其他程序修改或替换，已保留原数据库。请核对两处数据后再处理。',
            { cause: error },
          );
        }
        this.assertSourceIdentity(source);
        const journals = ['-wal', '-shm', '-journal'].map(
          (suffix) => `${source.databasePath}${suffix}`,
        );
        if (journals.some((path) => existsSync(path))) {
          throw new AppError(
            'STORAGE_SOURCE_IN_USE',
            '原数据库仍有日志文件，可能正被其他连接使用；已保留原库及日志，请关闭相关程序后手动核对。',
          );
        }
        const file = lstatSync(source.databasePath, { bigint: true });
        if (
          file.size !== source.size ||
          file.mtimeNs !== source.mtimeNs ||
          file.ctimeNs !== source.ctimeNs
        ) {
          throw new AppError(
            'STORAGE_SOURCE_UPDATED',
            '原数据库在快照后发生变化，已保留原数据库；请核对旧位置的最新记录。',
          );
        }
        // 只删除身份、真实目录和内容元数据仍匹配本次已关闭源库的确切路径。
        this.assertSourceIdentity(source);
        this.assertSourceIdentity({
          directory: this.currentDirectory!,
          databasePath: join(this.currentDirectory!, DATABASE_FILENAME),
          directoryIdentity: this.currentDirectoryIdentity!,
          databaseIdentity: this.currentDatabaseIdentity!,
        });
        if (this.database.getDataVersion() !== targetDataVersion) {
          throw new AppError(
            'STORAGE_TARGET_CHANGED',
            '新数据库在最终验证期间发生变化，已保留原数据库。请核对两处数据。',
          );
        }
        this.assertConfigurationUnchanged();
        unlinkSync(source.databasePath);
      });
      notice = {
        ...notice,
        status: 'completed',
        message: '迁移已完成，原位置的数据库及其运行日志已清理。原目录中的其他文件仍保留。',
      };
    } catch (error) {
      notice = {
        ...notice,
        message:
          error instanceof AppError
            ? error.message
            : '新位置已正常使用，但原数据库清理失败，可能没有删除权限或文件仍被占用。请核对旧路径后手动处理。',
      };
    }
    try {
      this.writeConfiguration(this.currentDirectory!, notice);
    } catch {
      // 切换已经提交；保留先前持久化的 pending，绝不能把成功切换回报为失败。
      this.migrationNotice =
        notice.status === 'completed'
          ? {
              ...notice,
              status: 'cleanup_pending',
              message:
                '原数据库已清理，但清理结果未能保存。重启后请检查旧路径；程序不会再次自动删除。',
            }
          : notice;
      console.warn('数据已切换，但迁移清理结果暂时无法保存。');
    }
  }

  private migrateSnapshot(databasePath: string): void {
    const temporaryPath = `${databasePath}.migration-${randomUUID()}.tmp`;
    let snapshotCreated = false;
    try {
      // 同步 VACUUM INTO 会把主库和已提交的 WAL 内容组成一个一致快照。
      const descriptor = openSync(temporaryPath, 'wx', 0o600);
      snapshotCreated = true;
      closeSync(descriptor);
      this.database.exportSnapshot(temporaryPath);
      copyFileSync(temporaryPath, databasePath, constants.COPYFILE_EXCL);
      const targetDescriptor = openSync(databasePath, 'r+');
      try {
        fsyncSync(targetDescriptor);
      } finally {
        closeSync(targetDescriptor);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new AppError(
          'STORAGE_DATABASE_EXISTS',
          '所选目录出现了已有数据库，迁移已取消且未覆写。',
          { cause: error },
        );
      }
      throw storageError(error, '数据迁移失败，原目录中的数据库仍保留，请检查磁盘空间和目录权限。');
    } finally {
      // 此处只清理临时快照；源库必须等新配置提交及源连接关闭后单独处理。
      if (snapshotCreated) {
        cleanupTemporaryFile(temporaryPath);
      }
    }
  }

  private activateDatabase(
    directory: string,
    preserveExisting: boolean,
    notice: DataStorageMigrationNotice | null = null,
    source: SourceMigrationState | null = null,
  ): { previousClosed: boolean; sourceUnchanged: boolean; targetDataVersion: number | null } {
    const databasePath = join(directory, DATABASE_FILENAME);
    // 已有库可能需要版本迁移或自动目标重算，先保存独立且经校验的一致恢复副本。
    if (preserveExisting) {
      const recoveryPath = `${databasePath}.before-open-${randomUUID()}.sqlite3`;
      const descriptor = openSync(recoveryPath, 'wx', 0o600);
      closeSync(descriptor);
      DatabaseService.createExistingSnapshot(databasePath, recoveryPath);
    }
    const candidate = new DatabaseService(databasePath, this.appVersion);
    const directoryIdentity = this.directoryIdentity(directory);
    const openedIdentity = this.fileIdentity(databasePath);
    let databaseIdentity: FileIdentity;
    let targetDataVersion: number | null = null;
    try {
      candidate.initialize();
      databaseIdentity = this.fileIdentity(databasePath);
      if (!sameIdentity(openedIdentity, databaseIdentity)) {
        throw new AppError(
          'STORAGE_DATABASE_CHANGED',
          '目标数据库文件在打开时被替换，迁移已取消。',
        );
      }
      if (source) {
        candidate.checkpointForMigration();
        const descriptor = openSync(databasePath, 'r+');
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        DatabaseService.validateExistingDatabase(databasePath);
        targetDataVersion = candidate.getDataVersion();
      }
      this.writeConfiguration(directory, notice);
    } catch (error) {
      candidate.close();
      throw storageError(error, '数据存储位置更改失败，当前使用的数据库和配置保持不变。');
    }
    const previous = this.currentDatabase;
    let sourceUnchanged = true;
    if (source && previous) {
      try {
        sourceUnchanged = previous.getDataVersion() === source.dataVersion;
      } catch {
        sourceUnchanged = false;
      }
    }
    this.currentDatabase = candidate;
    this.currentDirectory = directory;
    this.currentDatabaseIdentity = databaseIdentity;
    this.currentDirectoryIdentity = directoryIdentity;
    let previousClosed = true;
    try {
      previous?.close();
    } catch {
      previousClosed = false;
      // 新配置和新服务已提交，旧连接清理失败不能把成功切换误报为失败。
      console.warn('旧数据库连接暂时无法关闭，当前已使用新的数据位置。');
    }
    return { previousClosed, sourceUnchanged, targetDataVersion };
  }

  private readConfiguration(): string | null {
    try {
      return readFileSync(this.configurationPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new AppError(
        'STORAGE_CONFIG_UNREADABLE',
        '无法读取数据存储位置配置，请检查默认配置目录权限。',
        { cause: error },
      );
    }
  }

  private assertConfigurationUnchanged(): void {
    if (this.readConfiguration() !== this.expectedConfiguration) {
      throw new AppError(
        'STORAGE_CONFIG_CHANGED',
        '数据存储位置配置已被其他操作修改，请重启程序后重试。',
      );
    }
  }

  private writeConfiguration(
    directory: string,
    notice: DataStorageMigrationNotice | null = this.migrationNotice,
  ): void {
    this.assertConfigurationUnchanged();
    const configuration: StorageConfiguration = {
      version: 1,
      directory,
      ...(notice ? { migrationNotice: notice } : {}),
    };
    const content = `${JSON.stringify(configuration, null, 2)}\n`;
    const temporaryPath = `${this.configurationPath}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      if (this.expectedConfiguration !== null) {
        writeFileSync(
          `${this.configurationPath}.backup-${randomUUID()}`,
          this.expectedConfiguration,
          { flag: 'wx', mode: 0o600 },
        );
      }
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, content, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.assertConfigurationUnchanged();
      renameSync(temporaryPath, this.configurationPath);
      this.expectedConfiguration = content;
      this.migrationNotice = notice;
    } catch (error) {
      throw storageError(error, '无法保存新的数据存储位置，原配置和当前数据仍保留。');
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (existsSync(temporaryPath)) {
        cleanupTemporaryFile(temporaryPath);
      }
    }
  }

  private withConfigurationLock<T>(operation: () => T): T {
    if (this.busy) {
      throw new AppError('STORAGE_BUSY', '数据位置正在更改，请等待完成后重试。');
    }
    this.busy = true;
    const lockPath = `${this.configurationPath}.lock`;
    let descriptor: number | undefined;
    try {
      mkdirSync(this.configurationDirectory, { recursive: true });
      try {
        descriptor = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        // 只移除已确认进程不存在的临时锁；运行中的另一实例永不抢锁。
        let lock: { pid?: unknown; released?: unknown };
        try {
          lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
            pid?: unknown;
            released?: unknown;
          };
          if (typeof lock.pid !== 'number' || !Number.isSafeInteger(lock.pid) || lock.pid < 1) {
            throw new Error('Invalid lock');
          }
          if (lock.released === true) {
            unlinkSync(lockPath);
            descriptor = openSync(lockPath, 'wx', 0o600);
          } else {
            process.kill(lock.pid, 0);
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ESRCH') {
            unlinkSync(lockPath);
            descriptor = openSync(lockPath, 'wx', 0o600);
          }
        }
        if (descriptor === undefined) {
          throw new AppError('STORAGE_BUSY', '另一个数据位置操作尚未完成，请稍后重试。');
        }
      }
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid }), 'utf8');
      return operation();
    } catch (error) {
      throw storageError(error, '无法更改数据位置，请检查目录权限。原数据仍保留。');
    } finally {
      try {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            console.warn('数据位置操作的临时锁连接暂时无法关闭。');
          }
          try {
            unlinkSync(lockPath);
          } catch {
            // 保留的临时锁明确标记释放，使清理故障不会永久阻塞后续操作。
            try {
              writeFileSync(lockPath, JSON.stringify({ pid: process.pid, released: true }), 'utf8');
            } catch {
              console.warn('数据位置操作的临时锁暂时无法清理，已提交的数据位置仍有效。');
            }
          }
        }
      } finally {
        this.busy = false;
      }
    }
  }
}
