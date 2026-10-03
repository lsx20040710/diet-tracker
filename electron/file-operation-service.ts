import { extname } from 'node:path';

import { BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron';

import type {
  ChartCsvExportInput,
  ChartImageExportInput,
  DateRangeQuery,
  ExportDataKind,
  FileOperationResult,
  ImportCsvResult,
  ImportDataKind,
} from '../src/types/models';
import type { DatabaseService } from './database';
import {
  exportCsvToPath,
  exportExcelToPath,
  importCsvFromPath,
  saveChartCsvToPath,
  saveChartImageToPath,
} from './data-transfer';

const CSV_KIND_LABELS: Record<ExportDataKind, string> = {
  body_records: '身体数据',
  meal_records: '每日饮食明细',
  nutrition_summaries: '每日营养汇总',
  foods: '食物库',
  diet_plans: '饮食方案',
  food_combinations: '常用组合',
};

function dateStamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureExtension(filePath: string, extension: string): string {
  return extname(filePath).toLocaleLowerCase('zh-CN') === extension
    ? filePath
    : `${filePath}${extension}`;
}

async function showSaveDialog(
  owner: BrowserWindow | null,
  options: SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options);
}

async function showOpenDialog(
  owner: BrowserWindow | null,
  options: OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
}

/** 文件路径只能由系统对话框产生，渲染进程无法指定任意读写位置。 */
export class FileOperationService {
  constructor(private readonly database: DatabaseService) {}

  async exportExcel(
    owner: BrowserWindow | null,
    query: DateRangeQuery = {},
  ): Promise<FileOperationResult> {
    const selection = await showSaveDialog(owner, {
      title: '导出 Excel 数据',
      defaultPath: `饮食与体重记录-${dateStamp()}.xlsx`,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, filePath: null, recordCount: 0 };
    }
    const filePath = ensureExtension(selection.filePath, '.xlsx');
    const recordCount = await exportExcelToPath(this.database, filePath, query);
    return { canceled: false, filePath, recordCount };
  }

  async exportCsv(
    owner: BrowserWindow | null,
    kind: ExportDataKind,
    query: DateRangeQuery = {},
  ): Promise<FileOperationResult> {
    const label = CSV_KIND_LABELS[kind];
    const selection = await showSaveDialog(owner, {
      title: `导出${label} CSV`,
      defaultPath: `${label}-${dateStamp()}.csv`,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, filePath: null, recordCount: 0 };
    }
    const filePath = ensureExtension(selection.filePath, '.csv');
    const recordCount = await exportCsvToPath(this.database, filePath, kind, query);
    return { canceled: false, filePath, recordCount };
  }

  async importCsv(owner: BrowserWindow | null, kind: ImportDataKind): Promise<ImportCsvResult> {
    const selection = await showOpenDialog(owner, {
      title: kind === 'foods' ? '导入食物库 CSV' : '导入身体数据 CSV',
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) {
      return {
        canceled: true,
        filePath: null,
        recordCount: 0,
        createdCount: 0,
        updatedCount: 0,
      };
    }
    const result = await importCsvFromPath(this.database, selectedPath, kind);
    return {
      canceled: false,
      filePath: selectedPath,
      recordCount: result.createdCount + result.updatedCount,
      ...result,
    };
  }

  async exportChartCsv(
    owner: BrowserWindow | null,
    input: ChartCsvExportInput,
  ): Promise<FileOperationResult> {
    const suggestedName = input.suggestedName.toLocaleLowerCase('zh-CN').endsWith('.csv')
      ? input.suggestedName
      : `${input.suggestedName}.csv`;
    const selection = await showSaveDialog(owner, {
      title: '导出图表数据',
      defaultPath: suggestedName,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, filePath: null, recordCount: 0 };
    }
    const filePath = ensureExtension(selection.filePath, '.csv');
    const recordCount = await saveChartCsvToPath(input, filePath);
    return { canceled: false, filePath, recordCount };
  }

  async exportChartImage(
    owner: BrowserWindow | null,
    input: ChartImageExportInput,
  ): Promise<FileOperationResult> {
    const extension = `.${input.format}`;
    const suggestedName = input.suggestedName.toLocaleLowerCase('zh-CN').endsWith(extension)
      ? input.suggestedName
      : `${input.suggestedName}${extension}`;
    const selection = await showSaveDialog(owner, {
      title: '导出图表图片',
      defaultPath: suggestedName,
      filters: [
        {
          name: input.format === 'png' ? 'PNG 图片' : 'SVG 矢量图',
          extensions: [input.format],
        },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, filePath: null, recordCount: 0 };
    }
    const filePath = ensureExtension(selection.filePath, extension);
    await saveChartImageToPath(input, filePath);
    return { canceled: false, filePath, recordCount: 1 };
  }
}
