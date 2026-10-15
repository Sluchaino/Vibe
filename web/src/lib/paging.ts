export class PageRequestGate {
  private path = ''
  private sequence = 0
  select(path: string) { if (this.path !== path) { this.path = path; this.sequence++ } }
  begin(path: string) { this.select(path); return { path, sequence: ++this.sequence } }
  accepts(request: { path: string; sequence: number }) { return request.path === this.path && request.sequence === this.sequence }
  invalidate() { this.sequence++ }
}
