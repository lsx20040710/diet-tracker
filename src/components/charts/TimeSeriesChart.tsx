import { useState } from 'react';
import {
  Brush,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface ChartDatum {
  recordDate: string;
  [key: string]: string | number | null;
}

export interface ChartSeries {
  dataKey: string;
  name: string;
  color: string;
  unit: string;
  dashed?: boolean;
}

interface TimeSeriesChartProps {
  data: ChartDatum[];
  series: ChartSeries[];
  emptyMessage: string;
  xAxisLabelKey?: string;
}

function formatValue(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatTooltipValue(
  value: number | string | ReadonlyArray<number | string> | undefined,
): string {
  if (value === undefined) return '—';
  if (typeof value === 'number') return formatValue(value);
  if (typeof value === 'string') return value;
  return value.map((item) => (typeof item === 'number' ? formatValue(item) : item)).join(' - ');
}

/** 图例按钮保留所有序列入口，被隐藏的曲线可随时重新显示。 */
export function TimeSeriesChart({
  data,
  series,
  emptyMessage,
  xAxisLabelKey = 'recordDate',
}: TimeSeriesChartProps) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());

  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl bg-slate-50 text-sm text-slate-500">
        {emptyMessage}
      </div>
    );
  }

  function toggleSeries(dataKey: string) {
    setHiddenSeries((current) => {
      const next = new Set(current);
      if (next.has(dataKey)) next.delete(dataKey);
      else next.add(dataKey);
      return next;
    });
  }

  const visibleRangeKey = [
    data[0]?.recordDate,
    data[data.length - 1]?.recordDate,
    data.length,
    series.map((item) => `${item.dataKey}:${item.name}`).join('|'),
  ].join('-');

  return (
    <div>
      <div className="mb-2 flex min-h-8 flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {series.map((item) => {
          const hidden = hiddenSeries.has(item.dataKey);
          return (
            <button
              aria-pressed={!hidden}
              className={`inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs transition ${
                hidden ? 'text-slate-400 line-through' : 'text-slate-700 hover:bg-slate-50'
              }`}
              key={item.dataKey}
              onClick={() => toggleSeries(item.dataKey)}
              title={`${hidden ? '显示' : '隐藏'}${item.name}`}
              type="button"
            >
              <span
                className="h-0.5 w-5 rounded-full"
                style={{ backgroundColor: hidden ? '#cbd5e1' : item.color }}
              />
              {item.name}
            </button>
          );
        })}
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer height="100%" width="100%">
          <LineChart
            data={data}
            key={visibleRangeKey}
            margin={{ bottom: 4, left: 0, right: 18, top: 8 }}
          >
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey={xAxisLabelKey}
              minTickGap={28}
              stroke="#94a3b8"
              tick={{ fill: '#64748b', fontSize: 11 }}
              tickFormatter={(value: string) =>
                /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : value
              }
            />
            <YAxis
              domain={['auto', 'auto']}
              stroke="#94a3b8"
              tick={{ fill: '#64748b', fontSize: 11 }}
              tickFormatter={(value: number) => formatValue(value)}
              width={54}
            />
            <Tooltip
              contentStyle={{
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                boxShadow: '0 8px 24px rgb(15 23 42 / 0.12)',
                fontSize: 12,
              }}
              formatter={(value, name) => {
                const definition = series.find((item) => item.name === String(name));
                return [`${formatTooltipValue(value)} ${definition?.unit ?? ''}`, name];
              }}
              labelFormatter={(label) => `日期：${String(label)}`}
            />
            {/* Legend 负责图表语义，实际交互入口由上方常驻图例按钮提供。 */}
            <Legend content={() => null} />
            {/* 空日期不代表数值为 0，允许折线跨越缺失值并保留单点可见性。 */}
            {series.map((item) => (
              <Line
                activeDot={{ r: 4 }}
                connectNulls
                dataKey={item.dataKey}
                dot={
                  data.filter((point) => typeof point[item.dataKey] === 'number').length === 1
                    ? { fill: item.color, r: 4, stroke: '#ffffff', strokeWidth: 1 }
                    : false
                }
                hide={hiddenSeries.has(item.dataKey)}
                isAnimationActive={false}
                key={item.dataKey}
                name={item.name}
                stroke={item.color}
                strokeDasharray={item.dashed ? '6 4' : undefined}
                strokeWidth={item.dashed ? 1.8 : 2.2}
                type="monotone"
              />
            ))}
            <Brush
              dataKey={xAxisLabelKey}
              fill="#f8fafc"
              height={24}
              stroke="#94a3b8"
              tickFormatter={(value: string) =>
                /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : value
              }
              travellerWidth={8}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
