import {
  Activity,
  BarChart3,
  ClipboardList,
  DatabaseBackup,
  History,
  Library,
  Pill,
  Settings,
  Utensils,
} from 'lucide-react';
import type { ComponentType } from 'react';

import { useAppStore, type PageId } from '../stores/app-store';

interface NavigationItem {
  id: PageId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  enabled: boolean;
  phase?: string;
}

const navigationItems: NavigationItem[] = [
  { id: 'today', label: '今日记录', icon: Utensils, enabled: true },
  { id: 'body', label: '身体数据', icon: Activity, enabled: true },
  { id: 'trends', label: '趋势图表', icon: BarChart3, enabled: true },
  { id: 'plans', label: '饮食方案', icon: ClipboardList, enabled: true },
  { id: 'foods', label: '食物库', icon: Library, enabled: true },
  { id: 'supplements', label: '补剂库', icon: Pill, enabled: true },
  { id: 'history', label: '历史记录', icon: History, enabled: true },
  {
    id: 'transfer',
    label: '数据导入导出',
    icon: DatabaseBackup,
    enabled: true,
  },
  { id: 'settings', label: '设置', icon: Settings, enabled: false, phase: '后续阶段' },
];

export function Sidebar() {
  const currentPage = useAppStore((state) => state.currentPage);
  const setPage = useAppStore((state) => state.setPage);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-slate-200">
      <div className="border-b border-slate-800 px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500 text-slate-950">
            <Utensils className="size-5" />
          </div>
          <div>
            <p className="font-semibold text-white">饮食记录助手</p>
            <p className="mt-0.5 text-xs text-slate-400">本地数据 · 离线可用</p>
          </div>
        </div>
      </div>

      <nav aria-label="主导航" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const active = currentPage === item.id;
          return (
            <button
              aria-current={active ? 'page' : undefined}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition focus-visible:outline-2 focus-visible:outline-emerald-400 ${
                active
                  ? 'bg-emerald-500 font-medium text-slate-950'
                  : item.enabled
                    ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    : 'cursor-not-allowed text-slate-500'
              }`}
              disabled={!item.enabled}
              key={item.id}
              onClick={() => item.enabled && setPage(item.id)}
              title={item.enabled ? item.label : `${item.phase}开发`}
              type="button"
            >
              <Icon className="size-4.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {!item.enabled ? (
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                  {item.phase}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-800 px-5 py-4 text-xs leading-5 text-slate-500">
        本地饮食与补剂管理
        <br />
        数据仅保存在本机
      </div>
    </aside>
  );
}
