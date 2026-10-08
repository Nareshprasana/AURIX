// @aurix/api — localhost-only stub (Phase 1). No routes beyond health.
export function health(): { ok: boolean; phase: string } {
  return { ok: true, phase: 'Phase 1 foundation' };
}
