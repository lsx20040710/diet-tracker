import { AlertCircle, CalendarRange, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChartCard, type ChartCsvColumn } from '../components/charts/ChartCard';
import {
  TimeSeriesChart,
  type ChartDatum,
  type ChartSeries,
} from '../components/charts/TimeSeriesChart';
import { secondaryButtonClass } from '../components/ui/FormControls';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import type { TrendDataPoint } from '../types/models';
import { shiftDate, todayString } from '../utils/date';
import {
  calculateMovingAverages,
  calculateWeeklyAverages,
  fillTrendDateRange,
  MOVING_AVERAGE_WINDOWS,
  resolveTrendDateRange,
  type MovingAverageWindow,
  type TrendRangePreset,
} from '../utils/trends';

const rangeOptions: Array<{ value: TrendRangePreset; label: string }> = [
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: '90d', label: '最近 90 天' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '今年' },
  { value: 'custom', label: '自定义日期' },
];

type ComparisonMetric = 'calories' | 'protein' | 'carbs' | 'fat';

const comparisonOptions: Array<{
  value: ComparisonMetric;
  label: string;
  unit: string;
  color: string;
  targetKey: string;
}> = [
  { value: 'calories', label: '热量', unit: 'kcal', color: '#f97316', targetKey: 'targetCalories' },
  { value: 'protein', label: '蛋白质', unit: 'g', color: '#10b981', targetKey: 'targetProtein' },
  { value: 'carbs', label: '碳水', unit: 'g', color: '#3b82f6', targetKey: 'targetCarbs' },
  { value: 'fat', label: '脂肪', unit: 'g', color: '#8b5cf6', targetKey: 'targetFat' },
];

function hasValues(data: ChartDatum[], keys: string[]): boolean {
  return data.some((point) => keys.some((key) => typeof point[key] === 'number'));
}

function visibleRows(data: ChartDatum[], keys: string[]): ChartDatum[] {
  return hasValues(data, keys) ? data : [];
}

function chartSeries(
  dataKey: string,
  name: string,
  color: string,
  unit: string,
  dashed = false,
): ChartSeries {
  return { dataKey, name, color, unit, dashed };
}

function chartCsvColumns(
  series: readonly ChartSeries[],
  dateKey = 'recordDate',
  dateHeader = '日期',
): ChartCsvColumn[] {
  return [
    { dataKey: dateKey, header: dateHeader },
    ...series.map((item) => ({
      dataKey: item.dataKey,
      header: `${item.name}(${item.unit})`,
    })),
  ];
}

/** 第三阶段趋势中心：所有图表只读取主进程返回的本地数据库数据。 */
export function TrendsPage() {
  const today = todayString();
  const [rangePreset, setRangePreset] = useState<TrendRangePreset>('30d');
  const [customStartDate, setCustomStartDate] = useState(shiftDate(today, -29));
  const [customEndDate, setCustomEndDate] = useState(today);
  const [movingAverageWindow, setMovingAverageWindow] = useState<MovingAverageWindow>(7);
  const [comparisonMetric, setComparisonMetric] = useState<ComparisonMetric>('calories');
  const [points, setPoints] = useState<TrendDataPoint[]>([]);
  const [loadedRangeKey, setLoadedRangeKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const activeRangeKeyRef = useRef<string | null>(null);

  const dateRange = useMemo(
    () => resolveTrendDateRange(rangePreset, customStartDate, customEndDate, today),
    [customEndDate, customStartDate, rangePreset, today],
  );
  const currentRangeKey = dateRange
    ? `${rangePreset}|${dateRange.startDate ?? ''}|${dateRange.endDate ?? ''}`
    : null;

  const loadTrendData = useCallback(async () => {
    if (!dateRange || !currentRangeKey) {
      requestIdRef.current += 1;
      activeRangeKeyRef.current = null;
      setPoints([]);
      setLoadedRangeKey(null);
      setLoading(false);
      setError('请选择完整且起始日期不晚于结束日期的时间范围。');
      return;
    }
    if (activeRangeKeyRef.current === currentRangeKey) return;

    const requestId = ++requestIdRef.current;
    activeRangeKeyRef.current = currentRangeKey;
    // 新范围与旧 points 不能同时显示，否则图片文件名和图表内容可能不一致。
    setLoadedRangeKey(null);
    setLoading(true);
    setError(null);
    try {
      const result = unwrapApiResult(await getDietTrackerApi().getTrendData(dateRange));
      if (requestId !== requestIdRef.current) return;
      setPoints([...result].sort((left, right) => left.recordDate.localeCompare(right.recordDate)));
      setLoadedRangeKey(currentRangeKey);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setPoints([]);
      setLoadedRangeKey(null);
      setError(getErrorMessage(loadError));
    } finally {
      if (requestId === requestIdRef.current) {
        activeRangeKeyRef.current = null;
        setLoading(false);
      }
    }
  }, [currentRangeKey, dateRange]);

  useEffect(() => {
    void loadTrendData();
    return () => {
      requestIdRef.current += 1;
      activeRangeKeyRef.current = null;
    };
  }, [loadTrendData]);

  // 接口仍只返回真实记录；图表轴补齐自然日，避免跳天记录造成视觉断裂。
  const chartPoints = useMemo(
    () => fillTrendDateRange(points, dateRange ?? {}),
    [dateRange, points],
  );

  const trendData = useMemo<ChartDatum[]>(
    () =>
      calculateMovingAverages(chartPoints, movingAverageWindow).map((point) => ({
        recordDate: point.recordDate,
        weight: point.weight,
        bodyFatPercentage: point.bodyFatPercentage,
        waistCircumference: point.waistCircumference,
        weightMovingAverage: point.weightMovingAverage,
        bodyFatMovingAverage: point.bodyFatMovingAverage,
        waistMovingAverage: point.waistMovingAverage,
        calories: point.calories,
        protein: point.protein,
        carbs: point.carbs,
        fat: point.fat,
        targetCalories: point.target?.calories ?? null,
        targetProtein: point.target?.protein ?? null,
        targetCarbs: point.target?.carbs ?? null,
        targetFat: point.target?.fat ?? null,
      })),
    [chartPoints, movingAverageWindow],
  );

  const weeklyData = useMemo<ChartDatum[]>(
    () =>
      calculateWeeklyAverages(chartPoints).map((point) => ({
        recordDate: point.recordDate,
        weekLabel: point.weekLabel,
        weight: point.weight,
        calories: point.calories,
      })),
    [chartPoints],
  );

  const bodyCharts = [
    {
      title: '体重趋势',
      description: `体重原始记录与 ${movingAverageWindow} 日移动平均，缺失记录不会按 0 补齐。`,
      keys: ['weight', 'weightMovingAverage'],
      series: [
        chartSeries('weight', '体重', '#0f766e', 'kg'),
        chartSeries('weightMovingAverage', `${movingAverageWindow} 日平均`, '#f97316', 'kg', true),
      ],
    },
    {
      title: '体脂率趋势',
      description: `体脂率原始记录与 ${movingAverageWindow} 日移动平均。`,
      keys: ['bodyFatPercentage', 'bodyFatMovingAverage'],
      series: [
        chartSeries('bodyFatPercentage', '体脂率', '#2563eb', '%'),
        chartSeries('bodyFatMovingAverage', `${movingAverageWindow} 日平均`, '#f97316', '%', true),
      ],
    },
    {
      title: '腰围趋势',
      description: `腰围原始记录与 ${movingAverageWindow} 日移动平均。`,
      keys: ['waistCircumference', 'waistMovingAverage'],
      series: [
        chartSeries('waistCircumference', '腰围', '#7c3aed', 'cm'),
        chartSeries('waistMovingAverage', `${movingAverageWindow} 日平均`, '#f97316', 'cm', true),
      ],
    },
  ];

  const nutritionCharts = [
    {
      title: '每日热量摄入趋势',
      description: '仅统计已开启“计入营养”的饮食快照。',
      keys: ['calories'],
      series: [chartSeries('calories', '热量', '#f97316', 'kcal')],
    },
    {
      title: '每日蛋白质摄入趋势',
      description: '按保存时的营养快照汇总，不受食物库后续编辑影响。',
      keys: ['protein'],
      series: [chartSeries('protein', '蛋白质', '#10b981', 'g')],
    },
    {
      title: '每日碳水摄入趋势',
      description: '没有饮食记录的日期保持缺失，不显示为 0。',
      keys: ['carbs'],
      series: [chartSeries('carbs', '碳水', '#3b82f6', 'g')],
    },
    {
      title: '每日脂肪摄入趋势',
      description: '鱼油等已开启营养统计的补剂包含在汇总中。',
      keys: ['fat'],
      series: [chartSeries('fat', '脂肪', '#8b5cf6', 'g')],
    },
  ];

  const selectedComparison =
    comparisonOptions.find((option) => option.value === comparisonMetric) ?? comparisonOptions[0];
  const comparisonKeys = [selectedComparison.value, selectedComparison.targetKey];
  const comparisonSeries = [
    chartSeries(
      selectedComparison.value,
      `实际${selectedComparison.label}`,
      selectedComparison.color,
      selectedComparison.unit,
    ),
    chartSeries(
      selectedComparison.targetKey,
      `目标${selectedComparison.label}`,
      '#64748b',
      selectedComparison.unit,
      true,
    ),
  ];
  const comparisonRows = visibleRows(trendData, comparisonKeys);
  const weeklyWeightRows = visibleRows(weeklyData, ['weight']);
  const weeklyCalorieRows = visibleRows(weeklyData, ['calories']);
  const rangeLabel = dateRange
    ? `${dateRange.startDate ?? '最早'} 至 ${dateRange.endDate ?? '今天'}`
    : '日期范围无效';
  const dataMatchesCurrentRange = currentRangeKey !== null && loadedRangeKey === currentRangeKey;

  return (
    <div className="min-h-full p-6">
      <div className="mx-auto max-w-[1680px] space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">趋势图表</h1>
            <p className="mt-1 text-sm text-slate-500">
              查看身体与营养变化；图例可隐藏曲线，底部滑块可缩放时间范围。
            </p>
          </div>
          <button
            className={secondaryButtonClass}
            disabled={loading || !dateRange}
            onClick={() => void loadTrendData()}
            type="button"
          >
            {loading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            刷新数据
          </button>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-52">
              <label className="text-xs font-medium text-slate-600" htmlFor="trend-range">
                时间范围
              </label>
              <select
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
                id="trend-range"
                onChange={(event) => setRangePreset(event.target.value as TrendRangePreset)}
                value={rangePreset}
              >
                {rangeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {rangePreset === 'custom' ? (
              <>
                <label className="text-xs font-medium text-slate-600">
                  开始日期
                  <input
                    className="mt-1.5 block rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                    onChange={(event) => setCustomStartDate(event.target.value)}
                    type="date"
                    value={customStartDate}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  结束日期
                  <input
                    className="mt-1.5 block rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                    onChange={(event) => setCustomEndDate(event.target.value)}
                    type="date"
                    value={customEndDate}
                  />
                </label>
              </>
            ) : null}
            <div className="min-w-44">
              <label className="text-xs font-medium text-slate-600" htmlFor="moving-average">
                身体数据移动平均
              </label>
              <select
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
                id="moving-average"
                onChange={(event) =>
                  setMovingAverageWindow(Number(event.target.value) as MovingAverageWindow)
                }
                value={movingAverageWindow}
              >
                {MOVING_AVERAGE_WINDOWS.map((days) => (
                  <option key={days} value={days}>
                    {days} 日平均
                  </option>
                ))}
              </select>
            </div>
            <div className="ml-auto text-right text-xs leading-5 text-slate-500">
              <p>{rangeLabel}</p>
              <p>{loading ? '正在读取…' : `读取到 ${points.length} 个有记录的日期`}</p>
            </div>
          </div>
        </section>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!error && !loading && dataMatchesCurrentRange && points.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-slate-500">
            <CalendarRange className="mb-3 size-8 text-slate-300" />
            <p className="text-sm font-medium">所选范围内还没有身体或饮食记录</p>
            <p className="mt-1 text-xs">记录数据后返回本页即可查看趋势。</p>
          </div>
        ) : null}

        {dateRange && dataMatchesCurrentRange && points.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {bodyCharts.map((chart) => {
              const rows = visibleRows(trendData, chart.keys);
              return (
                <ChartCard
                  csvColumns={chartCsvColumns(chart.series)}
                  csvRows={rows}
                  description={chart.description}
                  hasData={rows.length > 0}
                  key={chart.title}
                  suggestedName={`${chart.title}-${dateRange.startDate}-${dateRange.endDate}`}
                  title={chart.title}
                >
                  <TimeSeriesChart
                    data={rows}
                    emptyMessage="所选范围内没有这项身体数据"
                    series={chart.series}
                  />
                </ChartCard>
              );
            })}

            {nutritionCharts.map((chart) => {
              const rows = visibleRows(trendData, chart.keys);
              return (
                <ChartCard
                  csvColumns={chartCsvColumns(chart.series)}
                  csvRows={rows}
                  description={chart.description}
                  hasData={rows.length > 0}
                  key={chart.title}
                  suggestedName={`${chart.title}-${dateRange.startDate}-${dateRange.endDate}`}
                  title={chart.title}
                >
                  <TimeSeriesChart
                    data={rows}
                    emptyMessage="所选范围内没有这项营养数据"
                    series={chart.series}
                  />
                </ChartCard>
              );
            })}

            <ChartCard
              actions={
                <select
                  aria-label="选择对比指标"
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-500"
                  onChange={(event) => setComparisonMetric(event.target.value as ComparisonMetric)}
                  value={comparisonMetric}
                >
                  {comparisonOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              }
              csvColumns={chartCsvColumns(comparisonSeries)}
              csvRows={comparisonRows}
              description="选择一种指标，对比每日实际摄入和当天饮食方案目标。"
              hasData={comparisonRows.length > 0}
              suggestedName={`${selectedComparison.label}摄入与目标-${dateRange.startDate}-${dateRange.endDate}`}
              title="摄入量与目标量对比"
            >
              <TimeSeriesChart
                data={comparisonRows}
                emptyMessage="所选范围内没有可对比的摄入与目标数据"
                series={comparisonSeries}
              />
            </ChartCard>

            <ChartCard
              csvColumns={[
                { dataKey: 'recordDate', header: '周起始日期' },
                { dataKey: 'weight', header: '周平均体重(kg)' },
              ]}
              csvRows={weeklyWeightRows}
              description="以周一为每周起点，仅对该周实际记录的体重求平均。"
              hasData={weeklyWeightRows.length > 0}
              suggestedName={`每周平均体重-${dateRange.startDate}-${dateRange.endDate}`}
              title="每周平均体重"
            >
              <TimeSeriesChart
                data={weeklyWeightRows}
                emptyMessage="所选范围内没有可计算的每周体重"
                series={[chartSeries('weight', '周平均体重', '#0f766e', 'kg')]}
                xAxisLabelKey="weekLabel"
              />
            </ChartCard>

            <ChartCard
              csvColumns={[
                { dataKey: 'recordDate', header: '周起始日期' },
                { dataKey: 'calories', header: '周平均热量(kcal)' },
              ]}
              csvRows={weeklyCalorieRows}
              description="以周一为每周起点，仅对该周存在饮食记录的日期求平均。"
              hasData={weeklyCalorieRows.length > 0}
              suggestedName={`每周平均热量-${dateRange.startDate}-${dateRange.endDate}`}
              title="每周平均热量"
            >
              <TimeSeriesChart
                data={weeklyCalorieRows}
                emptyMessage="所选范围内没有可计算的每周热量"
                series={[chartSeries('calories', '周平均热量', '#f97316', 'kcal')]}
                xAxisLabelKey="weekLabel"
              />
            </ChartCard>
          </div>
        ) : null}
      </div>
    </div>
  );
}
