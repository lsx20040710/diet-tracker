import { create } from 'zustand';

interface ConfirmationRequest {
  message: string;
  resolve: (accepted: boolean) => void;
}

interface ConfirmationState {
  request: ConfirmationRequest | null;
  confirm: (message: string) => Promise<boolean>;
  settle: (accepted: boolean) => void;
}

export const useConfirmationStore = create<ConfirmationState>((set, get) => ({
  request: null,
  confirm: (message) => {
    if (get().request) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => set({ request: { message, resolve } }));
  },
  settle: (accepted) => {
    const request = get().request;
    if (!request) return;
    set({ request: null });
    request.resolve(accepted);
  },
}));

export function confirmAction(message: string): Promise<boolean> {
  return useConfirmationStore.getState().confirm(message);
}
