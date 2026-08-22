/**
 * 把同一 session 的内存快照绑定到一次具体的 ShareLink 世代。
 * generationId 不是 linkId 本身：同一链接在安全撤权/宽限结束后重新激活，也必须拿到
 * 新世代，确保旧的异步读盘结果永远不能因 linkId 相同而回填。
 */
export class LiveSnapshotGenerationRegistry {
  private readonly generations = new Map<
    string,
    { linkId: string; generationId: string }
  >();
  private nextGeneration = 1;

  activate(
    sessionId: string,
    linkId: string
  ): { generationId: string; changed: boolean } {
    const current = this.generations.get(sessionId);
    if (current?.linkId === linkId) {
      return { generationId: current.generationId, changed: false };
    }

    const generationId = String(this.nextGeneration);
    this.nextGeneration += 1;
    this.generations.set(sessionId, { linkId, generationId });
    return { generationId, changed: current !== undefined };
  }

  isActive(sessionId: string, generationId: string): boolean {
    return this.generations.get(sessionId)?.generationId === generationId;
  }

  getActiveGenerationId(sessionId: string): string | undefined {
    return this.generations.get(sessionId)?.generationId;
  }

  getActive(
    sessionId: string
  ): { linkId: string; generationId: string } | undefined {
    const current = this.generations.get(sessionId);
    return current ? { ...current } : undefined;
  }

  /** expected 不匹配时保留新世代，防止迟到的旧连接删除新主持人的状态。 */
  invalidate(sessionId: string, expectedGeneration?: string): boolean {
    if (
      expectedGeneration !== undefined &&
      !this.isActive(sessionId, expectedGeneration)
    ) {
      return false;
    }
    this.generations.delete(sessionId);
    return true;
  }

  clear(): void {
    this.generations.clear();
  }
}
