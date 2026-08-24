// L29：翻译任务文件的原子落盘。
//
// tmp 文件名原来是固定的（`source.pdf.tmp` / `mono.pdf.tmp`）：同一个 taskId 只要有两个
// 写入者并存（跨代重派、双进程 tick 同时收割、重传撞上在途收割），两条 writeFile 会交错写
// 同一个 tmp，随后各自 rename —— 落地一个前后半段来自不同来源的撕裂 PDF。
// rename 的原子性只保证读者看到的要么旧要么新，挡不住 tmp 自身被写花。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeFileMock, renameMock, mkdirMock, rmMock, readFileMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
  renameMock: vi.fn(),
  mkdirMock: vi.fn(),
  rmMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: writeFileMock,
    rename: renameMock,
    mkdir: mkdirMock,
    rm: rmMock,
    readFile: readFileMock,
  },
}));

import { saveOutputFile, saveSourceFile } from '@/lib/translate/taskStorage';

beforeEach(() => {
  vi.clearAllMocks();
  writeFileMock.mockResolvedValue(undefined);
  renameMock.mockResolvedValue(undefined);
  mkdirMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
});

function tmpPathsWritten(): string[] {
  return writeFileMock.mock.calls.map(([p]) => p as string);
}

describe('saveOutputFile / saveSourceFile — tmp 名唯一 (L29)', () => {
  it('同一任务同一变体连写两次 → 两个不同的 tmp 路径，rename 目标相同', async () => {
    await saveOutputFile('task1', 'mono', Buffer.from('a'));
    await saveOutputFile('task1', 'mono', Buffer.from('b'));

    const [tmpA, tmpB] = tmpPathsWritten();
    expect(tmpA).not.toBe(tmpB);
    expect(tmpA.endsWith('.tmp')).toBe(true);
    expect(tmpB.endsWith('.tmp')).toBe(true);

    const renameTargets = renameMock.mock.calls.map(([, to]) => to as string);
    expect(renameTargets[0]).toBe(renameTargets[1]);
    expect(renameTargets[0].endsWith('mono.pdf')).toBe(true);
    // tmp 与最终文件必须不是同一个路径（否则 rename 无意义）
    expect(renameMock.mock.calls[0][0]).toBe(tmpA);
    expect(renameMock.mock.calls[0][0]).not.toBe(renameTargets[0]);
  });

  it('源文件同理：两次保存不共用一个 tmp', async () => {
    await saveSourceFile('task1', Buffer.from('a'));
    await saveSourceFile('task1', Buffer.from('b'));

    const [tmpA, tmpB] = tmpPathsWritten();
    expect(tmpA).not.toBe(tmpB);
    expect(renameMock.mock.calls[0][1]).toBe(renameMock.mock.calls[1][1]);
  });

  it('写失败 → 立即清掉半截 tmp 并把错误抛给调用方', async () => {
    writeFileMock.mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(saveOutputFile('task1', 'dual', Buffer.from('x'))).rejects.toThrow('ENOSPC');

    expect(renameMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledWith(tmpPathsWritten()[0], { force: true });
  });
});
