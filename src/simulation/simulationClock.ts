export const SIMULATION_STEP_SEC = 1 / 60;
const STEP_MS = SIMULATION_STEP_SEC * 1000;

export class SimulationClock {
  private cursorMs: number;

  constructor(nowMs: number) {
    this.cursorMs = nowMs;
  }

  reset(nowMs: number): void {
    this.cursorMs = nowMs;
  }

  advance(nowMs: number, step: (timeMs: number) => void): void {
    for (let i = 0; i < 3 && this.cursorMs + STEP_MS <= nowMs + 1e-6; i++) {
      this.cursorMs += STEP_MS;
      step(this.cursorMs);
    }
  }
}

interface PointerPoint {
  timeMs: number;
  x: number;
  y: number;
  kind: 'down' | 'move' | 'up';
}

export class PointerPath {
  private pending: PointerPoint[] = [];
  private last: PointerPoint | undefined;
  private position: { x: number; y: number } | undefined;

  push(point: PointerPoint): void {
    this.pending.push(point);
  }

  clear(): void {
    this.pending.length = 0;
    this.last = undefined;
    this.position = undefined;
  }

  sample(timeMs: number): [number, number, number, number] | undefined {
    while (this.pending.length && this.pending[0].timeMs <= timeMs) {
      this.last = this.pending.shift();
      if (this.last?.kind === 'down') this.position = this.last;
    }
    const past = this.last;
    const next = this.pending[0];
    const previous = this.position;
    if (!past || !previous) return;

    const ratio = next && next.kind !== 'down' && past.kind !== 'up' && next.timeMs > past.timeMs
      ? (timeMs - past.timeMs) / (next.timeMs - past.timeMs)
      : 0;
    const x = next ? past.x + ratio * (next.x - past.x) : past.x;
    const y = next ? past.y + ratio * (next.y - past.y) : past.y;
    this.position = past.kind === 'up' ? undefined : { x, y };
    return [previous.x, previous.y, x, y];
  }

  get hasPendingInput(): boolean {
    return this.pending.length > 0 || this.position !== undefined;
  }
}
