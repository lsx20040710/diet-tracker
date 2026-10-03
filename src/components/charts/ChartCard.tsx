import {
  CheckCircle2,
  FileSpreadsheet,
  ImageDown,
  Info,
  LoaderCircle,
  XCircle,
} from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../../services/api';
import type { ChartCsvCell } from '../../types/models';
import { chartSvgToPngData, serializeChartSvg } from '../../utils/chart-export';

type ChartExportAction = 'csv' | 'svg' | 'png';

export interface ChartCsvColumn {
  dataKey: string;
  header: string;
}

interface ChartCardProps {
  title: string;
  description: string;
  csvColumns: ChartCsvColumn[];
  csvRows: ReadonlyArray<Record<string, ChartCsvCell>>;
  suggestedName: string;
  hasData: boolean;
  children: ReactNode;
  actions?: ReactNode;
}

/** 统一承载图表、数据导出和图片导出状态，文件写入始终由主进程完成。 */
export function ChartCard({
  title,
  description,
  csvColumns,
  csvRows,
  suggestedName,
  hasData,
  children,
  actions,
}: ChartCardProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const operationLockRef = useRef(false);
  const [activeAction, setActiveAction] = useState<ChartExportAction | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

  async function exportCsv() {
    if (operationLockRef.current || !hasData) return;
    operationLockRef.current = true;
    setActiveAction('csv');
    setFeedback(null);
    try {
      const result = unwrapApiResult(
        await getDietTrackerApi().exportChartCsv({
          suggestedName,
          headers: csvColumns.map((column) => column.header),
          rows: csvRows.map((row) => csvColumns.map((column) => row[column.dataKey] ?? null)),
        }),
      );
      setFeedback(
        result.canceled
          ? { type: 'info', message: '已取消导出，未创建文件。' }
          : {
              type: 'success',
              message: `已导出 ${result.recordCount} 条记录：${result.filePath ?? ''}`,
            },
      );
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      operationLockRef.current = false;
      setActiveAction(null);
    }
  }

  async function exportImage(format: Extract<ChartExportAction, 'svg' | 'png'>) {
    if (operationLockRef.current || !chartRef.current) return;
    operationLockRef.current = true;
    setActiveAction(format);
    setFeedback(null);
    try {
      const svgData = serializeChartSvg(chartRef.current);
      const data = format === 'png' ? await chartSvgToPngData(svgData) : svgData;
      const result = unwrapApiResult(
        await getDietTrackerApi().exportChartImage({ format, suggestedName, data }),
      );
      setFeedback(
        result.canceled
          ? { type: 'info', message: '已取消导出，未创建图片。' }
          : { type: 'success', message: `图表已保存：${result.filePath ?? ''}` },
      );
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      operationLockRef.current = false;
      setActiveAction(null);
    }
  }

  const disabled = activeAction !== null;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-emerald-300 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled || !hasData}
            onClick={() => void exportCsv()}
            type="button"
          >
            {activeAction === 'csv' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <FileSpreadsheet className="size-3.5" />
            )}
            CSV
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-emerald-300 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled || !hasData}
            onClick={() => void exportImage('png')}
            type="button"
          >
            {activeAction === 'png' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ImageDown className="size-3.5" />
            )}
            PNG
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-emerald-300 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled || !hasData}
            onClick={() => void exportImage('svg')}
            type="button"
          >
            {activeAction === 'svg' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ImageDown className="size-3.5" />
            )}
            SVG
          </button>
        </div>
      </header>

      <div className="p-4" ref={chartRef}>
        {children}
      </div>

      {feedback ? (
        <div
          className={`flex items-start gap-2 border-t px-5 py-3 text-xs ${
            feedback.type === 'error'
              ? 'border-red-100 bg-red-50 text-red-700'
              : feedback.type === 'success'
                ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
                : 'border-blue-100 bg-blue-50 text-blue-700'
          }`}
        >
          {feedback.type === 'error' ? (
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
          ) : feedback.type === 'success' ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span className="min-w-0 break-all">{feedback.message}</span>
        </div>
      ) : null}
    </section>
  );
}
