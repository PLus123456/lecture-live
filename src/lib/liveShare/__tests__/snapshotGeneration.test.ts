import { describe, expect, it } from 'vitest';
import { LiveSnapshotGenerationRegistry } from '@/lib/liveShare/snapshotGeneration';

describe('LiveSnapshotGenerationRegistry', () => {
  it('同链接重连复用当前世代，新链接接管会使旧世代失效', () => {
    const registry = new LiveSnapshotGenerationRegistry();
    const first = registry.activate('session-1', 'link-a');
    expect(registry.getActiveGenerationId('session-1')).toBe(first.generationId);
    const reconnect = registry.activate('session-1', 'link-a');
    expect(first.changed).toBe(false);
    expect(reconnect).toEqual({
      generationId: first.generationId,
      changed: false,
    });

    const replacement = registry.activate('session-1', 'link-b');
    expect(replacement.changed).toBe(true);
    expect(registry.isActive('session-1', first.generationId)).toBe(false);
    expect(registry.isActive('session-1', replacement.generationId)).toBe(true);
    expect(registry.getActiveGenerationId('session-1')).toBe(
      replacement.generationId
    );
  });

  it('迟到 A 不能删除 B；B 撤权后同 linkId 重启也获得全新世代', () => {
    const registry = new LiveSnapshotGenerationRegistry();
    const oldGeneration = registry.activate('session-1', 'link-a');
    const currentGeneration = registry.activate('session-1', 'link-b');

    expect(
      registry.invalidate('session-1', oldGeneration.generationId)
    ).toBe(false);
    expect(
      registry.isActive('session-1', currentGeneration.generationId)
    ).toBe(true);

    expect(
      registry.invalidate('session-1', currentGeneration.generationId)
    ).toBe(true);
    expect(registry.getActiveGenerationId('session-1')).toBeUndefined();
    const restarted = registry.activate('session-1', 'link-b');
    expect(restarted.generationId).not.toBe(currentGeneration.generationId);
  });
});
