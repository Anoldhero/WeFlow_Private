export class LatestRequest {
  private revision = 0
  begin(): () => boolean {
    const revision = ++this.revision
    return () => this.revision === revision
  }
  invalidate(): void { this.revision++ }
}

export function scopedEvidence<T extends { id: string }>(id: string, report: { evidence?: T[] } | null, pending?: T[]): T | undefined {
  return (report ? report.evidence : pending)?.find(message => message.id === id)
}
