import { Save } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { getErrorMessage } from '../services/api';
import { useAppStore } from '../stores/app-store';
import type { BodyRecord } from '../types/models';
import { primaryButtonClass, TextInput } from './ui/FormControls';

interface BodyQuickCardProps {
  record: BodyRecord | null;
}

interface BodyFields {
  weight: string;
  bodyFatPercentage: string;
  waistCircumference: string;
}

function toFields(record: BodyRecord | null): BodyFields {
  return {
    weight: record?.weight === null || record?.weight === undefined ? '' : String(record.weight),
    bodyFatPercentage:
      record?.bodyFatPercentage === null || record?.bodyFatPercentage === undefined
        ? ''
        : String(record.bodyFatPercentage),
    waistCircumference:
      record?.waistCircumference === null || record?.waistCircumference === undefined
        ? ''
        : String(record.waistCircumference),
  };
}

export function BodyQuickCard({ record }: BodyQuickCardProps) {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const saveBodyRecord = useAppStore((state) => state.saveBodyRecord);
  const [fields, setFields] = useState(() => toFields(record));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setFields(toFields(record));
    setError(null);
  }, [record, selectedDate]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.values(fields).map((value) => (value === '' ? null : Number(value)));
    if (values.some((value) => value !== null && (!Number.isFinite(value) || value <= 0))) {
      setError('身体数据必须是大于 0 的数字，未记录的项目可以留空');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await saveBodyRecord({
        recordDate: selectedDate,
        weight: values[0],
        bodyFatPercentage: values[1],
        waistCircumference: values[2],
        note: record?.note ?? '',
      });
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-900">当日身体数据</h2>
          <p className="mt-0.5 text-xs text-slate-500">同一天重复保存会更新原记录</p>
        </div>
      </div>
      <form className="flex items-end gap-3" onSubmit={handleSubmit}>
        <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
          体重 (kg)
          <TextInput
            aria-label="体重，单位千克"
            min="0.01"
            onChange={(event) => setFields((value) => ({ ...value, weight: event.target.value }))}
            placeholder="--"
            step="0.01"
            type="number"
            value={fields.weight}
          />
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
          体脂率 (%)
          <TextInput
            aria-label="体脂率，百分比"
            max="100"
            min="0.1"
            onChange={(event) =>
              setFields((value) => ({ ...value, bodyFatPercentage: event.target.value }))
            }
            placeholder="--"
            step="0.1"
            type="number"
            value={fields.bodyFatPercentage}
          />
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
          腰围 (cm)
          <TextInput
            aria-label="腰围，单位厘米"
            min="0.1"
            onChange={(event) =>
              setFields((value) => ({ ...value, waistCircumference: event.target.value }))
            }
            placeholder="--"
            step="0.1"
            type="number"
            value={fields.waistCircumference}
          />
        </label>
        <button
          className={`${primaryButtonClass} h-[38px] shrink-0`}
          disabled={submitting}
          type="submit"
        >
          <Save className="size-4" />
          {submitting ? '保存中' : '保存'}
        </button>
      </form>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </section>
  );
}
