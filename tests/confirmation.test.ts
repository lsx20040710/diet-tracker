import { afterEach, describe, expect, it } from 'vitest';

import { confirmAction, useConfirmationStore } from '../src/stores/confirmation-store';

describe('异步操作确认', () => {
  afterEach(() => useConfirmationStore.getState().settle(false));

  it('确认等待期间不阻塞后续任务，接受后只完成一次', async () => {
    const result = confirmAction('确定删除记录吗？');
    let continued = false;
    await Promise.resolve().then(() => {
      continued = true;
    });
    expect(continued).toBe(true);
    expect(useConfirmationStore.getState().request?.message).toBe('确定删除记录吗？');
    useConfirmationStore.getState().settle(true);
    useConfirmationStore.getState().settle(false);
    await expect(result).resolves.toBe(true);
    expect(useConfirmationStore.getState().request).toBeNull();
  });

  it('取消不执行操作，并允许再次确认', async () => {
    const canceled = confirmAction('确定清空吗？');
    useConfirmationStore.getState().settle(false);
    await expect(canceled).resolves.toBe(false);
    const accepted = confirmAction('确定删除吗？');
    useConfirmationStore.getState().settle(true);
    await expect(accepted).resolves.toBe(true);
  });

  it('重复点击不覆盖仍在等待的确认，也不会留下未完成的请求', async () => {
    const first = confirmAction('第一个操作');
    await expect(confirmAction('重复操作')).resolves.toBe(false);
    expect(useConfirmationStore.getState().request?.message).toBe('第一个操作');
    useConfirmationStore.getState().settle(true);
    await expect(first).resolves.toBe(true);
  });
});
