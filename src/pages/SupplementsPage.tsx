import { CircleAlert, Copy, Pencil, Pill, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FoodForm } from '../components/FoodForm';
import { primaryButtonClass } from '../components/ui/FormControls';
import { Modal } from '../components/ui/Modal';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { confirmAction } from '../stores/confirmation-store';
import { useAppStore } from '../stores/app-store';
import type { Food, FoodInput } from '../types/models';
import { formatNutrition } from '../utils/nutrition';
import { formatSupplementDosage, formatSupplementFrequency } from '../utils/supplements';

type SupplementDialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; supplement: Food }
  | { mode: 'copy'; supplement: Food };

function nutritionIsEmpty(supplement: Food): boolean {
  return [
    supplement.caloriesPer100g,
    supplement.proteinPer100g,
    supplement.carbsPer100g,
    supplement.fatPer100g,
  ].every((value) => value === 0);
}

/** 补剂沿用食物营养快照模型，但在独立页面中管理，避免与普通食材混在一起。 */
export function SupplementsPage() {
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [supplements, setSupplements] = useState<Food[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SupplementDialogState>({ mode: 'closed' });
  const [dialogSubmitting, setDialogSubmitting] = useState(false);
  const [archivingId, setArchivingId] = useState<number | null>(null);
  const requestIdRef = useRef(0);
  const archivePendingRef = useRef(false);

  const loadSupplements = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = unwrapApiResult(
        await getDietTrackerApi().listFoods({
          search: search.trim() || undefined,
          kind: 'supplement',
        }),
      );
      if (requestId === requestIdRef.current) setSupplements(result);
    } catch (loadError) {
      if (requestId === requestIdRef.current) setError(getErrorMessage(loadError));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSupplements(), search ? 150 : 0);
    return () => window.clearTimeout(timer);
  }, [loadSupplements, search]);

  async function handleSubmit(input: FoodInput) {
    beginSaving();
    try {
      if (dialog.mode === 'edit') {
        unwrapApiResult(await getDietTrackerApi().updateFood(dialog.supplement.id, input));
      } else {
        unwrapApiResult(await getDietTrackerApi().createFood(input));
      }
      const [, dashboardLoaded] = await Promise.all([loadSupplements(), loadDashboard()]);
      finishSaving();
      if (!dashboardLoaded) {
        setError('补剂已保存，但当日计划刷新失败，请进入今日记录后点击刷新。');
      }
      setDialog({ mode: 'closed' });
    } catch (submitError) {
      reportSaveError(getErrorMessage(submitError));
      throw submitError;
    }
  }

  async function handleArchive(supplement: Food) {
    if (archivePendingRef.current) return;
    archivePendingRef.current = true;
    const confirmed = await confirmAction(
      `确定从补剂库删除“${supplement.name}”吗？删除后不会再出现在补剂库和添加记录搜索中，历史记录仍保留原有营养快照。`,
    );
    if (!confirmed) {
      archivePendingRef.current = false;
      return;
    }

    setArchivingId(supplement.id);
    setError(null);
    beginSaving();
    try {
      unwrapApiResult(await getDietTrackerApi().archiveFood(supplement.id));
      const [, dashboardLoaded] = await Promise.all([loadSupplements(), loadDashboard()]);
      finishSaving();
      if (!dashboardLoaded) {
        setError('补剂已删除，但当日计划刷新失败，请进入今日记录后点击刷新。');
      }
    } catch (archiveError) {
      const message = getErrorMessage(archiveError);
      setError(message);
      reportSaveError(message);
    } finally {
      setArchivingId(null);
      archivePendingRef.current = false;
    }
  }

  const dialogSupplement = useMemo(
    () =>
      dialog.mode === 'edit'
        ? dialog.supplement
        : dialog.mode === 'copy'
          ? { ...dialog.supplement, name: `${dialog.supplement.name} 副本` }
          : null,
    [dialog],
  );

  return (
    <div className="mx-auto flex h-full max-w-[1680px] flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-2">
            <Pill className="size-5 text-emerald-600" />
            <h1 className="text-xl font-semibold text-slate-950">补剂库</h1>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            按实际产品包装维护服用计划、份量和营养；修改只影响之后新增的记录，历史数据继续使用保存时快照。
          </p>
        </div>
        <button
          className={primaryButtonClass}
          onClick={() => setDialog({ mode: 'create' })}
          type="button"
        >
          <Plus className="size-4" />
          新增补剂
        </button>
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800">
          默认补剂提供可修改的作用说明，营养数据从 0
          开始。鱼油、蛋白粉及其他含能量补剂没有统一数值，请按本人购买产品的包装标签填写。
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-600">
          补剂作用说明仅供日常记录参考，不属于医疗建议；具体用量、禁忌或与药物的相互作用请咨询专业人员。
        </div>
      </div>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-slate-200 p-4">
          <label className="relative max-w-xl flex-1">
            <span className="sr-only">搜索补剂</span>
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full rounded-lg border border-slate-300 py-2 pl-10 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索补剂名称或品牌"
              value={search}
            />
          </label>
          <span className="ml-auto text-sm text-slate-500">{supplements.length} 项</span>
        </div>

        {error ? (
          <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
            <button
              className="ml-3 font-medium underline"
              onClick={() => void loadSupplements()}
              type="button"
            >
              重试
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1260px] table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[125px]" />
              <col className="w-[230px]" />
              <col className="w-[140px]" />
              <col className="w-[105px]" />
              <col className="w-[105px]" />
              <col className="w-[85px]" />
              <col className="w-[65px]" />
              <col className="w-[65px]" />
              <col className="w-[65px]" />
              <col className="w-[100px]" />
              <col className="w-[140px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-500 shadow-[0_1px_0_#e2e8f0]">
              <tr>
                <th className="px-4 py-3">名称</th>
                <th className="px-3 py-3">主要作用 / 说明</th>
                <th className="px-3 py-3">服用频率</th>
                <th className="px-3 py-3">每次用量</th>
                <th className="px-3 py-3">默认份量</th>
                <th className="px-3 py-3 text-right" title="每 100 克热量">
                  热量
                </th>
                <th className="px-3 py-3 text-right" title="每 100 克蛋白质">
                  蛋白
                </th>
                <th className="px-3 py-3 text-right" title="每 100 克碳水化合物">
                  碳水
                </th>
                <th className="px-3 py-3 text-right" title="每 100 克脂肪">
                  脂肪
                </th>
                <th className="px-3 py-3">营养统计</th>
                <th className="sticky right-0 z-20 bg-slate-50 px-4 py-3 text-right shadow-[-1px_0_0_#e2e8f0]">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {supplements.map((supplement) => {
                const missingCountedNutrition =
                  supplement.countInNutrition && nutritionIsEmpty(supplement);
                return (
                  <tr className="group align-top hover:bg-slate-50" key={supplement.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{supplement.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {supplement.brand || '未填写品牌'}
                      </p>
                    </td>
                    <td className="px-3 py-3 leading-5 text-slate-600">
                      <p className="line-clamp-2" title={supplement.note || '未填写作用说明'}>
                        {supplement.note || '未填写作用说明'}
                      </p>
                    </td>
                    <td className="px-3 py-3 leading-5 text-slate-600">
                      {formatSupplementFrequency(supplement)}
                    </td>
                    <td className="px-3 py-3 text-slate-600">
                      {formatSupplementDosage(supplement)}
                    </td>
                    <td className="px-3 py-3 text-slate-600">
                      {supplement.defaultServingGrams
                        ? `${formatNutrition(supplement.defaultServingGrams, 1)}g / ${supplement.unitName || '份'}`
                        : `未设置 / ${supplement.unitName || '份'}`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-slate-700">
                      {formatNutrition(supplement.caloriesPer100g, 1)} kcal
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-slate-700">
                      {formatNutrition(supplement.proteinPer100g, 1)}g
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-slate-700">
                      {formatNutrition(supplement.carbsPer100g, 1)}g
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-slate-700">
                      {formatNutrition(supplement.fatPer100g, 1)}g
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${
                          supplement.countInNutrition
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {supplement.countInNutrition ? '计入' : '不计入'}
                      </span>
                      {missingCountedNutrition ? (
                        <p
                          aria-label="请按包装补充营养数据"
                          className="mt-2 flex items-center gap-1 whitespace-nowrap text-xs leading-4 text-amber-700"
                          title="请按包装补充营养数据"
                        >
                          <CircleAlert className="size-3.5 shrink-0" />
                          待补营养
                        </p>
                      ) : null}
                    </td>
                    <td className="sticky right-0 bg-white px-4 py-3 shadow-[-1px_0_0_#f1f5f9] group-hover:bg-slate-50">
                      <div className="flex justify-end gap-1">
                        <button
                          aria-label={`编辑 ${supplement.name}`}
                          className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          onClick={() => setDialog({ mode: 'edit', supplement })}
                          title="编辑"
                          type="button"
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          aria-label={`复制 ${supplement.name}`}
                          className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          onClick={() => setDialog({ mode: 'copy', supplement })}
                          title="复制"
                          type="button"
                        >
                          <Copy className="size-4" />
                        </button>
                        <button
                          aria-label={`删除 ${supplement.name}`}
                          className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          disabled={archivingId !== null}
                          onClick={() => void handleArchive(supplement)}
                          title="删除"
                          type="button"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!loading && supplements.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center text-sm text-slate-500">
              <p>{search ? '没有符合条件的补剂' : '补剂库尚无数据'}</p>
              <button
                className="mt-3 font-medium text-emerald-700"
                onClick={() => setDialog({ mode: 'create' })}
                type="button"
              >
                新增第一个补剂
              </button>
            </div>
          ) : loading ? (
            <div className="flex h-56 items-center justify-center text-sm text-slate-500">
              正在读取补剂库…
            </div>
          ) : null}
        </div>
      </section>

      <Modal
        closeDisabled={dialogSubmitting}
        description="服用频率和每次用量用于生成当日计划；营养数据仍统一按每 100 克保存。"
        onClose={() => {
          if (!dialogSubmitting) setDialog({ mode: 'closed' });
        }}
        open={dialog.mode !== 'closed'}
        title={
          dialog.mode === 'edit' ? '编辑补剂' : dialog.mode === 'copy' ? '复制补剂' : '新增补剂'
        }
        widthClassName="max-w-4xl"
      >
        {dialog.mode !== 'closed' ? (
          <FoodForm
            initialFood={dialogSupplement}
            kind="supplement"
            onCancel={() => {
              if (!dialogSubmitting) setDialog({ mode: 'closed' });
            }}
            onSubmit={handleSubmit}
            onSubmittingChange={setDialogSubmitting}
            submitLabel="保存补剂"
          />
        ) : null}
      </Modal>
    </div>
  );
}
