import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Database,
  Flame,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Field,
  primaryButtonClass,
  secondaryButtonClass,
  SelectInput,
  TextInput,
} from '../components/ui/FormControls';
import { Modal } from '../components/ui/Modal';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useSettingsStore } from '../stores/settings-store';
import type { DataStorageInfo, DataStorageSelection, EnergyUnit } from '../types/models';

type Feedback = { type: 'success' | 'error' | 'info'; message: string };
type StorageOperation = 'loading' | 'choosing' | 'changing' | null;

export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings);
  const settingsLoading = useSettingsStore((state) => state.loading);
  const settingsSaving = useSettingsStore((state) => state.saving);
  const settingsError = useSettingsStore((state) => state.errorMessage);
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const saveSettings = useSettingsStore((state) => state.saveSettings);
  const [storage, setStorage] = useState<DataStorageInfo | null>(null);
  const [selection, setSelection] = useState<DataStorageSelection | null>(null);
  const [existingConfirmed, setExistingConfirmed] = useState(false);
  const [operation, setOperation] = useState<StorageOperation>('loading');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const operationLockRef = useRef(false);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let active = true;
    operationLockRef.current = true;
    async function loadInitialStorage() {
      try {
        const result = unwrapApiResult(await getDietTrackerApi().getStorageInfo());
        if (active) setStorage(result);
      } catch (error) {
        if (active) setFeedback({ type: 'error', message: getErrorMessage(error) });
      } finally {
        if (active) {
          operationLockRef.current = false;
          setOperation(null);
        }
      }
    }
    void loadInitialStorage();
    return () => {
      active = false;
    };
  }, []);

  async function refreshStorage() {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setOperation('loading');
    setFeedback(null);
    try {
      setStorage(unwrapApiResult(await getDietTrackerApi().getStorageInfo()));
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      operationLockRef.current = false;
      setOperation(null);
    }
  }

  async function chooseDirectory() {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setOperation('choosing');
    setFeedback(null);
    setSelection(null);
    setExistingConfirmed(false);
    try {
      const chosen = unwrapApiResult(await getDietTrackerApi().chooseStorageDirectory());
      if (!chosen) {
        setFeedback({ type: 'info', message: '已取消选择，数据存放位置未更改。' });
      } else if (chosen.isCurrent) {
        setFeedback({ type: 'info', message: '所选目录就是当前使用的位置，无需更改。' });
      } else {
        setSelection(chosen);
      }
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      operationLockRef.current = false;
      setOperation(null);
    }
  }

  async function confirmChange() {
    if (
      !selection ||
      operationLockRef.current ||
      (selection.hasExistingDatabase && !existingConfirmed)
    ) {
      return;
    }
    operationLockRef.current = true;
    setOperation('changing');
    setFeedback(null);
    let reloading = false;
    try {
      const result = unwrapApiResult(
        await getDietTrackerApi().changeStorageDirectory({
          selectionId: selection.selectionId,
          mode: selection.hasExistingDatabase ? 'existing' : 'migrate',
        }),
      );
      setStorage(result.storage);
      reloading = result.changed;
      setSelection(null);
      setFeedback({
        type: result.storage.migrationNotice?.status === 'cleanup_pending' ? 'info' : 'success',
        message: result.changed
          ? result.storage.migrationNotice?.status === 'cleanup_pending'
            ? '已使用新位置，但原数据库清理未完成。重新加载后可在设置查看详情。'
            : '数据存放位置已更改，正在重新加载页面。重启后将继续使用新位置。'
          : '正在使用所选目录，数据存放位置无需更改。',
      });
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error) });
    } finally {
      if (!reloading) {
        operationLockRef.current = false;
        setOperation(null);
      }
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setFeedback({ type: 'success', message: '路径已复制。' });
    } catch {
      setFeedback({ type: 'info', message: '未能自动复制，请在路径框中选中内容后按 Ctrl + C。' });
    }
  }

  function closeSelection() {
    if (operationLockRef.current) return;
    setSelection(null);
    setExistingConfirmed(false);
  }

  const busy = operation !== null;

  return (
    <div className="min-h-full p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-slate-950">设置</h1>
          <p className="mt-1 text-sm text-slate-500">
            设置默认热量单位与用户数据存放位置，按自己的习惯管理本地记录。
          </p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Flame className="size-5 text-emerald-600" />
            <h2 className="text-lg font-semibold text-slate-900">热量输入</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            食物、补剂、饮食方案和日型的热量输入框默认使用所选单位，也可在输入时临时切换。
          </p>
          <div className="mt-4 max-w-sm">
            <Field label="默认热量单位" hint="选择后自动保存，重启应用后继续使用。">
              <SelectInput
                disabled={busy || settingsLoading || settingsSaving || !settings}
                onChange={(event) =>
                  void saveSettings({ defaultEnergyUnit: event.target.value as EnergyUnit })
                }
                value={settings?.defaultEnergyUnit ?? ''}
              >
                {!settings ? <option value="">正在读取设置…</option> : null}
                <option value="kJ">千焦 (kJ)</option>
                <option value="kcal">千卡 (kcal)</option>
              </SelectInput>
            </Field>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            此设置仅影响输入单位；营养统计、历史记录和导入导出仍使用 kcal。
          </p>
          {settingsSaving ? (
            <p className="mt-3 text-sm text-slate-500" role="status">
              正在保存热量单位…
            </p>
          ) : null}
          {settingsError ? (
            <div className="mt-3 flex items-center gap-3 text-sm text-red-700" role="alert">
              <span>{settingsError}</span>
              <button
                className={secondaryButtonClass}
                disabled={busy || settingsLoading || settingsSaving}
                onClick={() => void loadSettings()}
                type="button"
              >
                重新读取
              </button>
            </div>
          ) : null}
        </section>

        {feedback && !selection ? (
          <div
            className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
              feedback.type === 'error'
                ? 'border-red-200 bg-red-50 text-red-700'
                : feedback.type === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-blue-200 bg-blue-50 text-blue-700'
            }`}
            role={feedback.type === 'error' ? 'alert' : 'status'}
          >
            {feedback.type === 'error' ? (
              <XCircle className="mt-0.5 size-4 shrink-0" />
            ) : feedback.type === 'success' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <span className="min-w-0 break-words">{feedback.message}</span>
          </div>
        ) : null}

        {storage?.migrationNotice ? (
          storage.migrationNotice.status === 'cleanup_pending' ? (
            <section
              className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-950"
              role="alert"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="size-5 shrink-0" />
                <h2>正在使用新位置，原数据库尚未清理完成</h2>
              </div>
              <p className="mt-2 break-words">{storage.migrationNotice.message}</p>
              <dl className="mt-3 space-y-2">
                <div>
                  <dt className="font-medium">当前使用的数据库</dt>
                  <dd className="break-all">{storage.databasePath}</dd>
                </div>
                <div>
                  <dt className="font-medium">原目录</dt>
                  <dd className="break-all">{storage.migrationNotice.sourceDirectory}</dd>
                </div>
                <div>
                  <dt className="font-medium">需要检查的原数据库路径</dt>
                  <dd className="break-all">{storage.migrationNotice.sourceDatabasePath}</dd>
                </div>
              </dl>
              <p className="mt-3">
                原位置可能仍有数据库或其 WAL/SHM
                文件。请先核对新旧数据库的记录；原库若有额外记录，先妥善保留或导出。确认没有其他程序使用后，再按需手动清理原数据库文件；其他文件无需删除。
              </p>
            </section>
          ) : (
            <p
              className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
              role="status"
            >
              <CheckCircle2 className="size-4 shrink-0" />
              数据已迁移，旧数据库已清理。
            </p>
          )
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Database className="size-5 text-emerald-600" />
                <h2 className="text-lg font-semibold text-slate-900">用户数据存放位置</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                食物库、补剂、饮食方案、每日记录与身体数据保存在同一数据库中。
              </p>
            </div>
            <button
              aria-label="刷新数据存放位置"
              className={`${secondaryButtonClass} shrink-0`}
              disabled={busy}
              onClick={() => void refreshStorage()}
              type="button"
            >
              <RefreshCw className={`size-4 ${operation === 'loading' ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>

          {storage ? (
            <div className="mt-5 space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-700" htmlFor="storage-directory">
                  当前使用的目录
                </label>
                <div className="flex items-center gap-2">
                  <TextInput
                    id="storage-directory"
                    readOnly
                    title={storage.directory}
                    value={storage.directory}
                  />
                  <button
                    aria-label="复制当前目录"
                    className={`${secondaryButtonClass} mt-1.5 shrink-0 px-3`}
                    onClick={() => void copyPath(storage.directory)}
                    type="button"
                  >
                    <Copy className="size-4" />
                    复制
                  </button>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700" htmlFor="storage-database">
                  当前数据库文件
                </label>
                <div className="flex items-center gap-2">
                  <TextInput
                    id="storage-database"
                    readOnly
                    title={storage.databasePath}
                    value={storage.databasePath}
                  />
                  <button
                    aria-label="复制数据库文件路径"
                    className={`${secondaryButtonClass} mt-1.5 shrink-0 px-3`}
                    onClick={() => void copyPath(storage.databasePath)}
                    type="button"
                  >
                    <Copy className="size-4" />
                    复制
                  </button>
                </div>
              </div>
              <p className="break-words text-xs leading-5 text-slate-500">
                {storage.isDefault ? '当前使用初始建议位置。' : '当前使用你选择的位置。'}
                初始建议目录：{storage.defaultDirectory}
              </p>
            </div>
          ) : (
            <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
              {operation === 'loading'
                ? '正在读取当前数据存放位置…'
                : '未能读取当前存放位置，请刷新重试。'}
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-start gap-4 border-t border-slate-200 pt-5">
            <button
              className={`${primaryButtonClass} shrink-0`}
              disabled={busy}
              onClick={() => void chooseDirectory()}
              type="button"
            >
              {operation === 'choosing' ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FolderOpen className="size-4" />
              )}
              {operation === 'choosing' ? '正在选择…' : '选择数据存放目录'}
            </button>
            <p className="max-w-md flex-1 text-sm leading-6 text-slate-500">
              选择目录后会先显示确认信息。更改成功后页面会重新加载，重启应用也将继续使用所选位置。
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm leading-6 text-slate-600">
          <h2 className="font-medium text-slate-900">更改位置时如何处理已有数据</h2>
          <p className="mt-2">
            选择没有数据库的目录：迁移当前全部记录，确认新位置可靠后清理原位置的数据库，其他文件不删除。迁移前置步骤失败时保留原数据。
          </p>
          <p className="mt-1">
            选择已有数据库的目录：确认后使用该目录中的记录，当前数据不会合并或覆盖，原数据库仍保留。
          </p>
          <p className="mt-1">请使用长期可访问的目录。使用外接硬盘时，打开应用前请先连接设备。</p>
        </section>
      </div>

      <Modal
        closeDisabled={operation === 'changing'}
        description="确认前不会更改当前数据存放位置。"
        onClose={closeSelection}
        open={selection !== null}
        title={selection?.hasExistingDatabase ? '使用所选目录中的已有数据' : '迁移用户数据'}
        widthClassName="max-w-xl"
      >
        {selection ? (
          <div className="space-y-5">
            {feedback?.type === 'error' ? (
              <p
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                role="alert"
              >
                {feedback.message}
              </p>
            ) : null}
            <div>
              <p className="text-sm font-medium text-slate-700">所选目录</p>
              <p className="mt-1.5 break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-800">
                {selection.directory}
              </p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
              {selection.hasExistingDatabase ? (
                <>
                  所选目录已有数据库。继续后将显示其中的食物、方案和历史记录，当前记录不会与它合并，也不会覆盖它。当前数据库会保留在原位置，之后可重新选择原目录恢复使用。
                </>
              ) : (
                <>
                  将当前全部记录迁移到所选目录，验证新数据库并记住所选路径。成功后清理原位置的数据库及其
                  WAL/SHM
                  文件，其他文件不删除。任何迁移前置步骤失败时保留原数据；如切换成功但原数据库清理失败，会显示待处理提示。之后的新增和修改只写入新位置。
                </>
              )}
            </div>
            {selection.hasExistingDatabase ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-6 text-slate-700">
                <input
                  checked={existingConfirmed}
                  className="mt-1 size-4 shrink-0 accent-emerald-600"
                  disabled={busy}
                  onChange={(event) => setExistingConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>我确认使用所选目录的数据，当前数据不合并也不覆盖。</span>
              </label>
            ) : null}
            <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
              <button
                className={secondaryButtonClass}
                disabled={busy}
                onClick={closeSelection}
                type="button"
              >
                取消
              </button>
              <button
                className={primaryButtonClass}
                disabled={busy || (selection.hasExistingDatabase && !existingConfirmed)}
                onClick={() => void confirmChange()}
                type="button"
              >
                {operation === 'changing' ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <FolderOpen className="size-4" />
                )}
                {operation === 'changing'
                  ? '正在更改…'
                  : selection.hasExistingDatabase
                    ? '确认使用已有数据'
                    : '迁移数据并使用新目录'}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
