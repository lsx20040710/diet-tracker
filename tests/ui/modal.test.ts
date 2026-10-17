import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '../../src/components/ui/Modal';
import { ConfirmationDialog } from '../../src/components/ui/ConfirmationDialog';
import { confirmAction, useConfirmationStore } from '../../src/stores/confirmation-store';

describe('弹窗交互焦点', () => {
  let root: Root;
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frame) =>
      window.clearTimeout(frame),
    );
    container = document.createElement('div');
    trigger = document.createElement('button');
    document.body.append(trigger, container);
    trigger.focus();
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useConfirmationStore.getState().settle(false);
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderDialog(onClose: () => void, closeDisabled = false, open = true) {
    await act(async () => {
      root.render(
        createElement(Modal, {
          open,
          closeDisabled,
          title: '编辑记录',
          onClose,
          children: createElement('input', { 'aria-label': '记录内容' }),
        }),
      );
      vi.runAllTimers();
    });
    await act(async () => vi.runAllTimers());
    return document.querySelector('input') as HTMLInputElement;
  }

  it('父级回调改变时保留正在编辑字段的焦点和光标', async () => {
    const input = await renderDialog(vi.fn());
    input.focus();
    input.value = '连续输入';
    input.setSelectionRange(2, 2);
    await renderDialog(vi.fn());
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
  });

  it('保存状态改变时不重置焦点，Esc 使用最新关闭状态和回调', async () => {
    const firstClose = vi.fn();
    const nextClose = vi.fn();
    const input = await renderDialog(firstClose);
    input.focus();
    await renderDialog(nextClose, true);
    expect(document.activeElement).toBe(input);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(firstClose).not.toHaveBeenCalled();
    expect(nextClose).not.toHaveBeenCalled();
    await renderDialog(nextClose);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(nextClose).toHaveBeenCalledOnce();
  });

  it('真正关闭时恢复打开前的焦点', async () => {
    const input = await renderDialog(vi.fn());
    input.focus();
    await renderDialog(vi.fn(), false, false);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('嵌套确认可取消且只处理顶层 Esc，随后继续编辑原表单', async () => {
    const closeEditor = vi.fn();
    let confirmation: Promise<boolean> | undefined;
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement(Modal, {
            open: true,
            title: '编辑记录',
            onClose: closeEditor,
            children: createElement('button', {
              id: 'overwrite',
              onClick: () => {
                confirmation = confirmAction('该日期已有记录，是否覆盖？');
              },
              children: '保存',
            }),
          }),
          createElement(ConfirmationDialog),
        ),
      );
    });
    await act(async () => vi.runAllTimers());
    const saveButton = document.getElementById('overwrite') as HTMLButtonElement;
    saveButton.focus();
    await act(async () => saveButton.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(confirmation).resolves.toBe(false);
    expect(closeEditor).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(saveButton);
  });
});
