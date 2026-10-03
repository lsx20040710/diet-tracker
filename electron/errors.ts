/** 可安全返回到渲染进程的业务错误。 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }
}

/** 将底层 SQLite 错误转换为不暴露内部实现的中文提示。 */
export function normalizeDatabaseError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('database or disk is full') || message.includes('sqlite_full')) {
    return new AppError('DISK_FULL', '磁盘空间不足，无法保存数据。', {
      cause: error,
    });
  }
  if (message.includes('readonly') || message.includes('read-only')) {
    return new AppError('DATABASE_READ_ONLY', '本地数据库不可写，请检查数据存储目录权限。', {
      cause: error,
    });
  }
  if (message.includes('malformed') || message.includes('not a database')) {
    return new AppError('DATABASE_CORRUPTED', '本地数据库已损坏，请从有效备份恢复数据。', {
      cause: error,
    });
  }

  return new AppError('DATABASE_ERROR', '数据库操作失败，请稍后重试。', {
    cause: error,
  });
}
