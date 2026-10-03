import type { ApiResult } from '../types/models';

/** 将主进程的显式结果转换成普通返回值，并保留可直接展示的中文错误。 */
export function unwrapApiResult<T>(result: ApiResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new Error(result.error || '操作失败，请稍后重试');
}

/** 统一访问 preload 暴露的受限接口，避免渲染进程接触 Node.js 能力。 */
export function getDietTrackerApi(): Window['dietTracker'] {
  if (!window.dietTracker) {
    throw new Error('应用数据服务尚未就绪，请重新启动应用');
  }
  return window.dietTracker;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误，请重试';
}
