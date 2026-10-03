import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  Field,
  primaryButtonClass,
  secondaryButtonClass,
  TextInput,
} from '../components/ui/FormControls';
import { Modal } from '../components/ui/Modal';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useAppStore } from '../stores/app-store';
import type { BodyRecord, BodyRecordInput } from '../types/models';
import { formatChineseDate, todayString } from '../utils/date';

interface BodyFormSeed {
  recordDate: string;
  weight: number | null;
  bodyFatPercentage: number | null;
  waistCircumference: number | null;
  note: string;
}

type BodyDialogState =
  | { mode: 'closed' }
  | { mode: 'create'; seed?: BodyFormSeed }
  | { mode: 'edit'; record: BodyRecord };

interface BodyRecordFormProps {
  state: Exclude<BodyDialogState, { mode: 'closed' }>;
  existingRecords: BodyRecord[];
  onCancel: () => void;
  onSubmit: (input: BodyRecordInput) => Promise<void>;
}

function BodyRecordForm({ state, existingRecords, onCancel, onSubmit }: BodyRecordFormProps) {
  const initial =
    state.mode === 'edit'
      ? state.record
      : (state.seed ?? {
          recordDate: todayString(),
          weight: null,
          bodyFatPercentage: null,
          waistCircumference: null,
          note: '',
        });
  const [recordDate, setRecordDate] = useState(initial.recordDate);
  const [weight, setWeight] = useState(initial.weight === null ? '' : String(initial.weight));
  const [bodyFat, setBodyFat] = useState(
    initial.bodyFatPercentage === null ? '' : String(initial.bodyFatPercentage),
  );
  const [waist, setWaist] = useState(
    initial.waistCircumference === null ? '' : String(initial.waistCircumference),
  );
  const [note, setNote] = useState(initial.note);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = [weight, bodyFat, waist].map((value) => (value === '' ? null : Number(value)));
    if (!recordDate) {
      setError('请选择记录日期');
      return;
    }
    if (values.some((value) => value !== null && (!Number.isFinite(value) || value <= 0))) {
      setError('身体数据必须是大于 0 的数字，未记录的项目可以留空');
      return;
    }
    if (values[1] !== null && values[1] > 100) {
      setError('体脂率不能大于 100%');
      return;
    }
    const duplicate = existingRecords.find(
      (record) =>
        record.recordDate === recordDate &&
        (state.mode !== 'edit' || record.id !== state.record.id),
    );
    if (duplicate && !window.confirm('该日期已有记录，是否覆盖？')) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        recordDate,
        weight: values[0],
        bodyFatPercentage: values[1],
        waistCircumference: values[2],
        note: note.trim(),
      });
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      {error ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}
      <Field
        label="日期 *"
        hint={state.mode === 'edit' ? '编辑时保留原日期，避免意外产生重复记录' : undefined}
      >
        <TextInput
          disabled={state.mode === 'edit'}
          onChange={(event) => setRecordDate(event.target.value)}
          required
          type="date"
          value={recordDate}
        />
      </Field>
      <div className="grid grid-cols-3 gap-4">
        <Field label="体重 (kg)">
          <TextInput
            autoFocus
            min="0.01"
            onChange={(event) => setWeight(event.target.value)}
            placeholder="可留空"
            step="0.01"
            type="number"
            value={weight}
          />
        </Field>
        <Field label="体脂率 (%)">
          <TextInput
            max="100"
            min="0.1"
            onChange={(event) => setBodyFat(event.target.value)}
            placeholder="可留空"
            step="0.1"
            type="number"
            value={bodyFat}
          />
        </Field>
        <Field label="腰围 (cm)">
          <TextInput
            min="0.1"
            onChange={(event) => setWaist(event.target.value)}
            placeholder="可留空"
            step="0.1"
            type="number"
            value={waist}
          />
        </Field>
      </div>
      <Field label="备注">
        <textarea
          className="mt-1.5 min-h-24 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          placeholder="可留空"
          value={note}
        />
      </Field>
      <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
        <button className={secondaryButtonClass} onClick={onCancel} type="button">
          取消
        </button>
        <button className={primaryButtonClass} disabled={submitting} type="submit">
          {submitting ? '正在保存…' : '保存记录'}
        </button>
      </div>
    </form>
  );
}

export function BodyDataPage() {
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [records, setRecords] = useState<BodyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dialog, setDialog] = useState<BodyDialogState>({ mode: 'closed' });

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = unwrapApiResult(await getDietTrackerApi().listBodyRecords());
      setRecords(
        [...result].sort((left, right) => right.recordDate.localeCompare(left.recordDate)),
      );
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const visibleRecords = useMemo(
    () =>
      records.filter(
        (record) =>
          (!startDate || record.recordDate >= startDate) &&
          (!endDate || record.recordDate <= endDate),
      ),
    [endDate, records, startDate],
  );

  async function saveRecord(input: BodyRecordInput) {
    beginSaving();
    try {
      unwrapApiResult(await getDietTrackerApi().upsertBodyRecord(input));
      setDialog({ mode: 'closed' });
      await Promise.all([loadRecords(), loadDashboard()]);
      finishSaving();
    } catch (saveError) {
      reportSaveError(getErrorMessage(saveError));
      throw saveError;
    }
  }

  async function deleteRecord(record: BodyRecord) {
    if (!window.confirm(`确定删除 ${record.recordDate} 的身体数据吗？`)) return;
    setError(null);
    beginSaving();
    try {
      unwrapApiResult(await getDietTrackerApi().deleteBodyRecord(record.id));
      await Promise.all([loadRecords(), loadDashboard()]);
      finishSaving();
    } catch (deleteError) {
      const message = getErrorMessage(deleteError);
      setError(message);
      reportSaveError(message);
    }
  }

  function copyPrevious() {
    const previous = records[0];
    if (!previous) return;
    setDialog({
      mode: 'create',
      seed: {
        recordDate: todayString(),
        weight: previous.weight,
        bodyFatPercentage: previous.bodyFatPercentage,
        waistCircumference: previous.waistCircumference,
        note: previous.note,
      },
    });
  }

  return (
    <div className="mx-auto flex h-full max-w-[1500px] flex-col p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">身体数据</h1>
          <p className="mt-1 text-sm text-slate-500">
            同一日期只保留一条记录，空白项目不会被强制填写。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            disabled={records.length === 0}
            onClick={copyPrevious}
            type="button"
          >
            <Copy className="size-4" />
            复制上一条
          </button>
          <button
            className={primaryButtonClass}
            onClick={() => setDialog({ mode: 'create' })}
            type="button"
          >
            <Plus className="size-4" />
            新增记录
          </button>
        </div>
      </div>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-end gap-3 border-b border-slate-200 p-4">
          <Field label="开始日期">
            <TextInput
              className="w-44"
              onChange={(event) => setStartDate(event.target.value)}
              type="date"
              value={startDate}
            />
          </Field>
          <Field label="结束日期">
            <TextInput
              className="w-44"
              onChange={(event) => setEndDate(event.target.value)}
              type="date"
              value={endDate}
            />
          </Field>
          {startDate || endDate ? (
            <button
              className="mb-0.5 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
              onClick={() => {
                setStartDate('');
                setEndDate('');
              }}
              type="button"
            >
              清除筛选
            </button>
          ) : null}
          <span className="ml-auto pb-2 text-sm text-slate-500">
            {visibleRecords.length} 条记录
          </span>
        </div>
        {error ? (
          <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
            <button
              className="ml-3 font-medium underline"
              onClick={() => void loadRecords()}
              type="button"
            >
              重试
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-500 shadow-[0_1px_0_#e2e8f0]">
              <tr>
                <th className="px-5 py-3">日期</th>
                <th className="px-4 py-3 text-right">体重 (kg)</th>
                <th className="px-4 py-3 text-right">体脂率 (%)</th>
                <th className="px-4 py-3 text-right">腰围 (cm)</th>
                <th className="px-4 py-3">备注</th>
                <th className="px-5 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleRecords.map((record) => (
                <tr className="hover:bg-slate-50" key={record.id}>
                  <td className="px-5 py-4 font-medium text-slate-900">
                    {formatChineseDate(record.recordDate)}
                  </td>
                  <td className="px-4 py-4 text-right text-slate-700">{record.weight ?? '—'}</td>
                  <td className="px-4 py-4 text-right text-slate-700">
                    {record.bodyFatPercentage ?? '—'}
                  </td>
                  <td className="px-4 py-4 text-right text-slate-700">
                    {record.waistCircumference ?? '—'}
                  </td>
                  <td className="max-w-sm truncate px-4 py-4 text-slate-500" title={record.note}>
                    {record.note || '—'}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex justify-end gap-1">
                      <button
                        aria-label={`编辑 ${record.recordDate}`}
                        className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        onClick={() => setDialog({ mode: 'edit', record })}
                        type="button"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        aria-label={`删除 ${record.recordDate}`}
                        className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        onClick={() => void deleteRecord(record)}
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
          {!loading && visibleRecords.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center text-sm text-slate-500">
              <p>{records.length ? '当前日期范围内没有记录' : '还没有身体数据'}</p>
              <button
                className="mt-3 font-medium text-emerald-700"
                onClick={() => setDialog({ mode: 'create' })}
                type="button"
              >
                新增第一条记录
              </button>
            </div>
          ) : loading ? (
            <div className="flex h-56 items-center justify-center text-sm text-slate-500">
              正在读取身体数据…
            </div>
          ) : null}
        </div>
      </section>

      <Modal
        onClose={() => setDialog({ mode: 'closed' })}
        open={dialog.mode !== 'closed'}
        title={dialog.mode === 'edit' ? '编辑身体数据' : '新增身体数据'}
        widthClassName="max-w-xl"
      >
        {dialog.mode !== 'closed' ? (
          <BodyRecordForm
            existingRecords={records}
            onCancel={() => setDialog({ mode: 'closed' })}
            onSubmit={saveRecord}
            state={dialog}
          />
        ) : null}
      </Modal>
    </div>
  );
}
