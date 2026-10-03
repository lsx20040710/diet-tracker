import {
  AlertCircle,
  CheckCircle2,
  Database,
  FileInput,
  FileSpreadsheet,
  LoaderCircle,
  XCircle,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { primaryButtonClass, secondaryButtonClass } from '../components/ui/FormControls';
import { Modal } from '../components/ui/Modal';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useAppStore } from '../stores/app-store';
import type {
  DateRangeQuery,
  ExportDataKind,
  FileOperationResult,
  ImportCsvResult,
  ImportDataKind,
} from '../types/models';
import { shiftDate, todayString } from '../utils/date';

const exportDefinitions: Array<{
  kind: ExportDataKind;
  title: string;
  description: string;
}> = [
  { kind: 'body_records', title: '身体数据', description: '体重、体脂率、腰围与备注' },
  {
    kind: 'meal_records',
    title: '每日饮食明细',
    description: '四个餐次、补剂记录及营养快照',
  },
  {
    kind: 'nutrition_summaries',
    title: '每日营养汇总',
    description: '每日摄入量与当日目标',
  },
  {
    kind: 'foods',
    title: '食物库与补剂库',
    description: '普通食物、补剂及各自营养设置（同一文件）',
  },
  { kind: 'diet_plans', title: '饮食方案', description: '目标、日期范围与启用状态' },
  { kind: 'food_combinations', title: '常用组合', description: '组合名称及所含食物' },
];

const importDefinitions: Array<{
  kind: ImportDataKind;
  title: string;
  description: string;
}> = [
  {
    kind: 'body_records',
    title: '导入身体数据 CSV',
    description: '同一日期已有记录时覆盖该日身体数据，其他日期新增。',
  },
  {
    kind: 'foods',
    title: '导入食物 / 补剂 CSV',
    description: '根据“是否补剂”字段分别加入食物库或补剂库，不修改历史饮食快照。',
  },
];

type Feedback = { type: 'success' | 'error' | 'info'; message: string };

/** 数据传输页仅调用受限 preload API，选取文件和写盘均由主进程负责。 */
export function TransferPage() {
  const today = todayString();
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const clearAppError = useAppStore((state) => state.clearError);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [activeOperation, setActiveOperation] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<ImportDataKind | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const operationLockRef = useRef(false);

  const rangeError = useMemo(() => {
    if (startDate && endDate && startDate > endDate) return '开始日期不能晚于结束日期。';
    return null;
  }, [endDate, startDate]);

  function exportRange(): DateRangeQuery {
    return {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    };
  }

  function describeResult(result: FileOperationResult, dataName: string): Feedback {
    if (result.canceled) {
      return { type: 'info', message: '已取消选择保存位置，未创建文件。' };
    }
    return {
      type: 'success',
      message: `${dataName}已导出 ${result.recordCount} 条记录：${result.filePath ?? ''}`,
    };
  }

  async function runExport(kind: ExportDataKind) {
    if (operationLockRef.current || rangeError) return;
    operationLockRef.current = true;
    setActiveOperation(`csv:${kind}`);
    setFeedback(null);
    try {
      const definition = exportDefinitions.find((item) => item.kind === kind);
      const result = unwrapApiResult(await getDietTrackerApi().exportCsv(kind, exportRange()));
      setFeedback(describeResult(result, `${definition?.title ?? '数据'} CSV`));
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      operationLockRef.current = false;
      setActiveOperation(null);
    }
  }

  async function runExcelExport() {
    if (operationLockRef.current || rangeError) return;
    operationLockRef.current = true;
    setActiveOperation('excel');
    setFeedback(null);
    try {
      const result = unwrapApiResult(await getDietTrackerApi().exportExcel(exportRange()));
      setFeedback(describeResult(result, 'Excel 工作簿'));
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      operationLockRef.current = false;
      setActiveOperation(null);
    }
  }

  function describeImport(result: ImportCsvResult, kind: ImportDataKind): Feedback {
    if (result.canceled) {
      return { type: 'info', message: '已取消选择导入文件，现有数据未修改。' };
    }
    const dataName = kind === 'body_records' ? '身体数据' : '食物';
    return {
      type: 'success',
      message: `${dataName}导入完成：读取 ${result.recordCount} 条，新增 ${result.createdCount} 条，更新 ${result.updatedCount} 条。`,
    };
  }

  async function confirmImport() {
    if (!pendingImport || operationLockRef.current) return;
    const kind = pendingImport;
    operationLockRef.current = true;
    setActiveOperation(`import:${kind}`);
    setFeedback(null);
    try {
      const result = unwrapApiResult(await getDietTrackerApi().importCsv(kind));
      const importFeedback = describeImport(result, kind);
      setFeedback(importFeedback);
      if (!result.canceled && kind === 'body_records') {
        // 导入可能覆盖当前日期，刷新首页缓存，避免返回首页后显示旧值。
        try {
          const refreshed = await loadDashboard();
          if (!refreshed) {
            clearAppError();
            setFeedback({
              type: 'info',
              message: `${importFeedback.message} 但首页数据刷新失败，返回首页后请手动刷新。`,
            });
          }
        } catch {
          // 数据库导入已经提交，后续刷新失败不能把成功导入误报为失败。
          clearAppError();
          setFeedback({
            type: 'info',
            message: `${importFeedback.message} 但首页数据刷新失败，返回首页后请手动刷新。`,
          });
        }
      }
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      operationLockRef.current = false;
      setActiveOperation(null);
      setPendingImport(null);
    }
  }

  const pendingDefinition = importDefinitions.find((item) => item.kind === pendingImport);
  const busy = activeOperation !== null;

  return (
    <div className="min-h-full p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-slate-950">数据导入导出</h1>
          <p className="mt-1 text-sm text-slate-500">
            文件由本机直接生成或读取，不会上传到网络。Ctrl + E 可快速打开本页。
          </p>
        </header>

        {feedback ? (
          <div
            className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
              feedback.type === 'error'
                ? 'border-red-200 bg-red-50 text-red-700'
                : feedback.type === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-blue-200 bg-blue-50 text-blue-700'
            }`}
          >
            {feedback.type === 'error' ? (
              <XCircle className="mt-0.5 size-4 shrink-0" />
            ) : feedback.type === 'success' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <span className="min-w-0 break-all">{feedback.message}</span>
          </div>
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-end gap-4">
            <div className="mr-2">
              <h2 className="font-semibold text-slate-900">导出日期范围</h2>
              <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">
                两个日期都留空时导出全部记录；食物库与补剂库、饮食方案和常用组合始终完整导出。
              </p>
            </div>
            <label className="text-xs font-medium text-slate-600">
              开始日期
              <input
                className="mt-1.5 block rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                onChange={(event) => setStartDate(event.target.value)}
                type="date"
                value={startDate}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              结束日期
              <input
                className="mt-1.5 block rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                onChange={(event) => setEndDate(event.target.value)}
                type="date"
                value={endDate}
              />
            </label>
            <button
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => {
                setStartDate(shiftDate(today, -29));
                setEndDate(today);
              }}
              type="button"
            >
              最近 30 天
            </button>
            <button
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => {
                setStartDate('');
                setEndDate('');
              }}
              type="button"
            >
              全部日期
            </button>
          </div>
          {rangeError ? <p className="mt-3 text-sm text-red-600">{rangeError}</p> : null}
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-5 p-6 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="size-5 text-emerald-600" />
                <h2 className="text-lg font-semibold text-slate-900">完整 Excel 工作簿</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                一次生成身体数据、每日饮食明细、每日营养汇总、食物库（含补剂库）、饮食方案和常用组合
                6 个工作表。
              </p>
            </div>
            <button
              className={primaryButtonClass}
              disabled={busy || Boolean(rangeError)}
              onClick={() => void runExcelExport()}
              type="button"
            >
              {activeOperation === 'excel' ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="size-4" />
              )}
              {activeOperation === 'excel' ? '正在生成…' : '导出完整 Excel'}
            </button>
          </div>
        </section>

        <section>
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-slate-900">分别导出 CSV</h2>
            <p className="mt-1 text-sm text-slate-500">每类数据生成一个独立的 UTF-8 CSV 文件。</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {exportDefinitions.map((item) => {
              const operationId = `csv:${item.kind}`;
              return (
                <article
                  className="flex min-h-36 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                  key={item.kind}
                >
                  <div className="flex items-center gap-2">
                    <Database className="size-4 text-slate-400" />
                    <h3 className="font-medium text-slate-900">{item.title}</h3>
                  </div>
                  <p className="mt-2 flex-1 text-xs leading-5 text-slate-500">{item.description}</p>
                  <button
                    className={`${secondaryButtonClass} mt-3 w-full`}
                    disabled={busy || Boolean(rangeError)}
                    onClick={() => void runExport(item.kind)}
                    type="button"
                  >
                    {activeOperation === operationId ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <FileSpreadsheet className="size-4" />
                    )}
                    {activeOperation === operationId ? '正在导出…' : '导出 CSV'}
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section>
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-slate-900">导入 CSV</h2>
            <p className="mt-1 text-sm text-slate-500">
              请选择本应用导出的同类型 CSV；字段缺失、日期无效或数值非法时不会写入部分数据。
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {importDefinitions.map((item) => (
              <article
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
                key={item.kind}
              >
                <div className="flex items-center gap-2">
                  <FileInput className="size-5 text-blue-600" />
                  <h3 className="font-semibold text-slate-900">{item.title}</h3>
                </div>
                <p className="mt-2 min-h-10 text-sm leading-5 text-slate-500">{item.description}</p>
                <button
                  className={`${secondaryButtonClass} mt-4`}
                  disabled={busy}
                  onClick={() => {
                    setFeedback(null);
                    setPendingImport(item.kind);
                  }}
                  type="button"
                >
                  <FileInput className="size-4" />
                  选择文件并导入
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>

      <Modal
        description="确认后才会打开本机文件选择窗口。"
        onClose={() => {
          if (!busy) setPendingImport(null);
        }}
        open={pendingImport !== null}
        title={pendingDefinition?.title ?? '确认导入'}
        widthClassName="max-w-lg"
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            {pendingImport === 'body_records' ? (
              <>
                导入将按日期处理身体数据：同一日期已有记录时直接覆盖，其他日期新增。导入校验失败时不会写入部分记录。
              </>
            ) : (
              <>
                导入将根据“是否补剂”字段向食物库或补剂库追加记录，不会删除或修改现有条目；历史饮食继续保留保存时的营养快照。
              </>
            )}
          </div>
          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => setPendingImport(null)}
              type="button"
            >
              取消
            </button>
            <button
              className={primaryButtonClass}
              disabled={busy}
              onClick={() => void confirmImport()}
              type="button"
            >
              {activeOperation?.startsWith('import:') ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FileInput className="size-4" />
              )}
              {activeOperation?.startsWith('import:') ? '正在导入…' : '确认并选择文件'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
