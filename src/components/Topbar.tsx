import { CalendarDays, CheckCircle2, CircleAlert, Plus, Scale, Save } from 'lucide-react';

import { useAppStore } from '../stores/app-store';
import { formatChineseDate } from '../utils/date';

interface TopbarProps {
  onQuickWeight: () => void;
  onQuickFood: () => void;
  quickActionsDisabled?: boolean;
}

export function Topbar({ onQuickWeight, onQuickFood, quickActionsDisabled = false }: TopbarProps) {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const dashboard = useAppStore((state) => state.dashboard);
  const saveStatus = useAppStore((state) => state.saveStatus);
  const setPage = useAppStore((state) => state.setPage);
  const dashboardMatchesDate = dashboard?.date === selectedDate;
  const displayedPlanName =
    dashboard?.dailyPlan?.planName ?? dashboard?.activePlan?.name ?? '尚未设置';

  const status = {
    saved: {
      label: '已保存到本机',
      icon: CheckCircle2,
      className: 'text-emerald-700 bg-emerald-50',
    },
    saving: {
      label: '正在保存…',
      icon: Save,
      className: 'text-sky-700 bg-sky-50',
    },
    error: {
      label: '保存失败',
      icon: CircleAlert,
      className: 'text-red-700 bg-red-50',
    },
  }[saveStatus];
  const StatusIcon = status.icon;

  return (
    <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="flex min-w-0 items-center gap-5">
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <CalendarDays className="size-4 text-slate-400" />
          <span className="whitespace-nowrap font-medium">{formatChineseDate(selectedDate)}</span>
        </div>
        <button
          className="min-w-0 rounded-lg bg-slate-100 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-200"
          onClick={() => setPage('plans')}
          title={dashboardMatchesDate ? `前往饮食方案：${displayedPlanName}` : '正在读取饮食方案'}
          type="button"
        >
          当前方案：
          <span className="inline-block max-w-48 truncate align-bottom font-semibold text-slate-900">
            {dashboardMatchesDate ? displayedPlanName : '正在读取…'}
          </span>
        </button>
        <div
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ${status.className}`}
        >
          <StatusIcon className={`size-3.5 ${saveStatus === 'saving' ? 'animate-pulse' : ''}`} />
          {status.label}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={quickActionsDisabled}
          onClick={onQuickWeight}
          type="button"
        >
          <Scale className="size-4" />
          快速记录体重
        </button>
        <button
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={quickActionsDisabled}
          onClick={onQuickFood}
          type="button"
        >
          <Plus className="size-4" />
          快速添加食物
        </button>
      </div>
    </header>
  );
}
