import { useConfirmationStore } from '../../stores/confirmation-store';
import { primaryButtonClass, secondaryButtonClass } from './FormControls';
import { Modal } from './Modal';

export function ConfirmationDialog() {
  const request = useConfirmationStore((state) => state.request);
  const settle = useConfirmationStore((state) => state.settle);

  return (
    <Modal
      onClose={() => settle(false)}
      open={request !== null}
      title="确认操作"
      widthClassName="max-w-md"
    >
      <p className="text-sm leading-6 text-slate-700">{request?.message}</p>
      <div className="mt-5 flex justify-end gap-3 border-t border-slate-200 pt-5">
        <button
          autoFocus
          className={secondaryButtonClass}
          onClick={() => settle(false)}
          type="button"
        >
          取消
        </button>
        <button className={primaryButtonClass} onClick={() => settle(true)} type="button">
          确定
        </button>
      </div>
    </Modal>
  );
}
