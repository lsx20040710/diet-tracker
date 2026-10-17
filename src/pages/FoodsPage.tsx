import { Boxes, Copy, List, Pencil, Plus, Search, Star, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { FoodCombinationsPanel } from '../components/FoodCombinationsPanel';
import { FoodForm } from '../components/FoodForm';
import {
  primaryButtonClass,
  secondaryButtonClass,
  SelectInput,
} from '../components/ui/FormControls';
import { Modal } from '../components/ui/Modal';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { confirmAction } from '../stores/confirmation-store';
import { useAppStore } from '../stores/app-store';
import { FOOD_CATEGORIES, type Food, type FoodCategory, type FoodInput } from '../types/models';
import { formatNutrition } from '../utils/nutrition';

type FoodDialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; food: Food }
  | { mode: 'copy'; food: Food };

const REGULAR_FOOD_CATEGORIES = FOOD_CATEGORIES.filter((item) => item !== '补剂');

export function FoodsPage() {
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [foods, setFoods] = useState<Food[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<FoodCategory | '全部'>('全部');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<FoodDialogState>({ mode: 'closed' });
  const [dialogSubmitting, setDialogSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'foods' | 'combinations'>('foods');
  const [favoriteUpdatingId, setFavoriteUpdatingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const foodsRequestId = useRef(0);
  const deletePending = useRef(false);

  const loadFoods = useCallback(async () => {
    const requestId = ++foodsRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = unwrapApiResult(
        await getDietTrackerApi().listFoods({
          search: search.trim() || undefined,
          category,
          kind: 'food',
        }),
      );
      if (requestId === foodsRequestId.current) setFoods(result);
    } catch (loadError) {
      if (requestId === foodsRequestId.current) setError(getErrorMessage(loadError));
    } finally {
      if (requestId === foodsRequestId.current) setLoading(false);
    }
  }, [category, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFoods(), search ? 150 : 0);
    return () => {
      window.clearTimeout(timer);
      // 筛选改变时立即作废旧请求，避免旧结果在防抖等待期间覆盖当前筛选。
      foodsRequestId.current += 1;
    };
  }, [loadFoods, search]);

  async function handleSubmit(input: FoodInput) {
    beginSaving();
    try {
      if (dialog.mode === 'edit') {
        unwrapApiResult(await getDietTrackerApi().updateFood(dialog.food.id, input));
      } else {
        unwrapApiResult(await getDietTrackerApi().createFood(input));
      }
      await Promise.all([loadFoods(), loadDashboard()]);
      finishSaving();
      setDialog({ mode: 'closed' });
    } catch (submitError) {
      reportSaveError(getErrorMessage(submitError));
      throw submitError;
    }
  }

  async function handleDelete(food: Food) {
    if (deletePending.current) return;
    deletePending.current = true;
    if (
      !(await confirmAction(`确定从食物库删除“${food.name}”吗？历史饮食记录会保留原有营养快照。`))
    ) {
      deletePending.current = false;
      return;
    }
    setDeletingId(food.id);
    setError(null);
    beginSaving();
    try {
      unwrapApiResult(await getDietTrackerApi().archiveFood(food.id));
      await loadFoods();
      finishSaving();
    } catch (deleteError) {
      const message = getErrorMessage(deleteError);
      setError(message);
      reportSaveError(message);
    } finally {
      setDeletingId(null);
      deletePending.current = false;
    }
  }

  async function handleFavorite(food: Food) {
    if (favoriteUpdatingId !== null) return;
    setFavoriteUpdatingId(food.id);
    beginSaving();
    setError(null);
    try {
      const updated = unwrapApiResult(
        await getDietTrackerApi().setFoodFavorite(food.id, !food.isFavorite),
      );
      setFoods((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      finishSaving();
    } catch (favoriteError) {
      const message = getErrorMessage(favoriteError);
      setError(message);
      reportSaveError(message);
    } finally {
      setFavoriteUpdatingId(null);
    }
  }

  const dialogFood =
    dialog.mode === 'edit'
      ? dialog.food
      : dialog.mode === 'copy'
        ? { ...dialog.food, name: `${dialog.food.name} 副本` }
        : null;

  return (
    <div className="mx-auto flex h-full max-w-[1680px] flex-col p-5">
      <div className="mb-4 flex shrink-0 items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">食物库</h1>
          <p className="mt-1 text-sm text-slate-500">
            管理普通食材和食物；补剂已移至独立的“补剂库”。营养修改只影响之后新增的记录。
          </p>
        </div>
        {activeTab === 'foods' ? (
          <button
            className={primaryButtonClass}
            onClick={() => setDialog({ mode: 'create' })}
            type="button"
          >
            <Plus className="size-4" />
            新增食物
          </button>
        ) : null}
      </div>

      <div className="mb-3 flex w-fit shrink-0 gap-1 rounded-lg bg-slate-200/70 p-1" role="tablist">
        <button
          aria-selected={activeTab === 'foods'}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${
            activeTab === 'foods'
              ? 'bg-white text-emerald-700 shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
          onClick={() => setActiveTab('foods')}
          role="tab"
          type="button"
        >
          <List className="size-4" />
          食物列表
        </button>
        <button
          aria-selected={activeTab === 'combinations'}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${
            activeTab === 'combinations'
              ? 'bg-white text-emerald-700 shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
          onClick={() => setActiveTab('combinations')}
          role="tab"
          type="button"
        >
          <Boxes className="size-4" />
          常用组合
        </button>
      </div>

      {activeTab === 'foods' ? (
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="grid shrink-0 grid-cols-[minmax(240px,1fr)_180px_auto] items-end gap-4 border-b border-slate-200 bg-slate-50/60 p-4">
            <label className="block min-w-0 text-sm font-medium text-slate-700">
              <span>搜索食物</span>
              <span className="relative mt-1.5 block">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                />
                <input
                  aria-label="搜索食物"
                  className="h-10 w-full min-w-0 rounded-lg border border-slate-300 bg-white py-2 pl-10 pr-10 text-sm font-normal text-slate-900 outline-none placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="名称、品牌或拼音首字母"
                  type="search"
                  value={search}
                />
                {search ? (
                  <button
                    aria-label="清空食物搜索"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => setSearch('')}
                    type="button"
                  >
                    <X className="size-4" />
                  </button>
                ) : null}
              </span>
            </label>
            <label className="block min-w-0 text-sm font-medium text-slate-700">
              <span>食物分类</span>
              <SelectInput
                aria-label="按分类筛选"
                className="h-10 font-normal"
                onChange={(event) => setCategory(event.target.value as FoodCategory | '全部')}
                value={category}
              >
                <option value="全部">全部分类</option>
                {REGULAR_FOOD_CATEGORIES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </SelectInput>
            </label>
            <span
              aria-live="polite"
              className="flex h-10 min-w-16 items-center justify-end whitespace-nowrap text-sm text-slate-500"
            >
              {loading ? '搜索中…' : `${foods.length} 项`}
            </span>
          </div>

          {error ? (
            <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
              <button
                className="ml-3 font-medium underline"
                onClick={() => void loadFoods()}
                type="button"
              >
                重试
              </button>
            </div>
          ) : null}

          <div aria-busy={loading} className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[1050px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-500 shadow-[0_1px_0_#e2e8f0]">
                <tr>
                  <th className="px-4 py-3">名称</th>
                  <th className="px-3 py-3">分类</th>
                  <th className="px-3 py-3 text-right">热量 /100g</th>
                  <th className="px-3 py-3 text-right">蛋白质</th>
                  <th className="px-3 py-3 text-right">碳水</th>
                  <th className="px-3 py-3 text-right">脂肪</th>
                  <th className="px-3 py-3">默认份量</th>
                  <th className="px-3 py-3">统计</th>
                  <th className="sticky right-0 z-20 bg-slate-50 px-4 py-3 text-right shadow-[-1px_0_0_#e2e8f0]">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {foods.map((food) => (
                  <tr className="hover:bg-slate-50" key={food.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium text-slate-900">
                        {food.name}
                        <button
                          aria-label={`${food.isFavorite ? '取消常用' : '标记常用'} ${food.name}`}
                          className={`rounded p-1 transition hover:bg-amber-50 ${
                            food.isFavorite
                              ? 'text-amber-400'
                              : 'text-slate-300 hover:text-amber-400'
                          }`}
                          disabled={favoriteUpdatingId !== null}
                          onClick={() => void handleFavorite(food)}
                          title={food.isFavorite ? '取消常用' : '标记为常用'}
                          type="button"
                        >
                          <Star className={`size-3.5 ${food.isFavorite ? 'fill-current' : ''}`} />
                        </button>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">{food.brand || '无品牌'}</p>
                    </td>
                    <td className="px-3 py-3 text-slate-600">{food.category}</td>
                    <td className="px-3 py-3 text-right text-slate-700">
                      {formatNutrition(food.caloriesPer100g, 1)} kcal
                    </td>
                    <td className="px-3 py-3 text-right text-slate-700">
                      {formatNutrition(food.proteinPer100g, 1)}g
                    </td>
                    <td className="px-3 py-3 text-right text-slate-700">
                      {formatNutrition(food.carbsPer100g, 1)}g
                    </td>
                    <td className="px-3 py-3 text-right text-slate-700">
                      {formatNutrition(food.fatPer100g, 1)}g
                    </td>
                    <td className="px-3 py-3 text-slate-600">
                      {food.defaultServingGrams
                        ? `每${food.unitName || '份'} ${formatNutrition(food.defaultServingGrams, 1)}g`
                        : '未设置'}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${
                          food.countInNutrition
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {food.countInNutrition ? '计入' : '不计入'}
                      </span>
                    </td>
                    <td className="sticky right-0 bg-white px-4 py-3 shadow-[-1px_0_0_#e2e8f0]">
                      <div className="flex justify-end gap-1">
                        <button
                          aria-label={`编辑 ${food.name}`}
                          className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          onClick={() => setDialog({ mode: 'edit', food })}
                          title="编辑"
                          type="button"
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          aria-label={`复制 ${food.name}`}
                          className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          onClick={() => setDialog({ mode: 'copy', food })}
                          title="复制"
                          type="button"
                        >
                          <Copy className="size-4" />
                        </button>
                        <button
                          aria-label={`删除 ${food.name}`}
                          className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          disabled={deletingId !== null}
                          onClick={() => void handleDelete(food)}
                          title="删除"
                          type="button"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && foods.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center text-sm text-slate-500">
                <p>{search || category !== '全部' ? '没有符合条件的食物' : '食物库尚无数据'}</p>
                <div className="mt-3 flex gap-3">
                  {search || category !== '全部' ? (
                    <button
                      className={secondaryButtonClass}
                      onClick={() => {
                        setSearch('');
                        setCategory('全部');
                      }}
                      type="button"
                    >
                      清除筛选
                    </button>
                  ) : null}
                  <button
                    className={primaryButtonClass}
                    onClick={() => setDialog({ mode: 'create' })}
                    type="button"
                  >
                    <Plus className="size-4" />
                    新增食物
                  </button>
                </div>
              </div>
            ) : loading ? (
              <div className="flex h-56 items-center justify-center text-sm text-slate-500">
                正在读取食物库…
              </div>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <FoodCombinationsPanel />
        </section>
      )}

      <Modal
        closeDisabled={dialogSubmitting}
        onClose={() => {
          if (!dialogSubmitting) setDialog({ mode: 'closed' });
        }}
        open={dialog.mode !== 'closed'}
        title={
          dialog.mode === 'edit' ? '编辑食物' : dialog.mode === 'copy' ? '复制食物' : '新增食物'
        }
        widthClassName="max-w-3xl"
      >
        {dialog.mode !== 'closed' ? (
          <FoodForm
            initialFood={dialogFood}
            kind="food"
            onCancel={() => {
              if (!dialogSubmitting) setDialog({ mode: 'closed' });
            }}
            onSubmit={handleSubmit}
            onSubmittingChange={setDialogSubmitting}
          />
        ) : null}
      </Modal>
    </div>
  );
}
