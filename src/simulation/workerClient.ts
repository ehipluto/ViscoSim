import {
  FluidConfig,
  InteractionEvent,
  ProbeSample,
  QualityLevel,
  ScaleRange,
  SimulationMetrics,
  VisualizationMode,
} from '../types/rheology';
import { createWorkerProtocolHandler, WorkerCommand, WorkerResponse } from './workerProtocol';

export interface FrameSnapshot {
  seqId: number;
  gridN: number;
  fieldBytes: Uint8Array;
  vectors: Float32Array | null;
  vectorCount: number;
  scaleRange: ScaleRange;
  metrics: SimulationMetrics;
  probe: ProbeSample | null;
  stepMs: number;
}

export class SimulationController {
  private worker: Worker | null = null;
  private localFallback: ReturnType<typeof createWorkerProtocolHandler> | null = null;
  private disposed = false;

  private nextSeqId = 1;
  private lastAcceptedSeqId = 0;
  private inFlight = false;

  private renderFrameTimes: number[] = [];
  private solverStepTimes: number[] = [];
  private latestSnapshot: FrameSnapshot | null = null;
  private interactionEvents: InteractionEvent[] = [];

  constructor(initialConfig: FluidConfig) {
    if (typeof Worker !== 'undefined') {
      try {
        const w = new Worker(new URL('./cfdWorker.ts', import.meta.url), {
          type: 'module',
        });
        w.onmessage = (e: MessageEvent<WorkerResponse>) => this.handleWorkerMessage(e.data);
        w.onerror = () => {
          this.switchToFallback(initialConfig);
        };
        this.worker = w;
        this.postCommand({ type: 'init', config: initialConfig });
        return;
      } catch {
        // Fallback controllato su thread principale con time-budgeting se Worker non disponibile
      }
    }
    this.switchToFallback(initialConfig);
  }

  private switchToFallback(config: FluidConfig): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.inFlight = false;
    this.localFallback = createWorkerProtocolHandler(config.quality);
    this.localFallback.handleMessage({ type: 'init', config });
  }

  private postCommand(cmd: WorkerCommand, transferables?: Transferable[]): void {
    if (this.disposed) return;
    if (this.worker) {
      this.worker.postMessage(cmd, transferables ?? []);
    } else if (this.localFallback) {
      const res = this.localFallback.handleMessage(cmd);
      if (res.response) {
        this.handleWorkerMessage(res.response);
      }
    }
  }

  private handleWorkerMessage(msg: WorkerResponse): void {
    if (this.disposed) return;
    if (msg.type === 'ready') {
      return;
    }

    this.inFlight = false;

    // Scarta snapshot obsoleti rispetto al seqId già accettato e ricicla subito i buffer
    if (msg.seqId < this.lastAcceptedSeqId) {
      this.reclaimBuffers(msg.fieldBuffer, msg.vectorBuffer);
      return;
    }
    this.lastAcceptedSeqId = msg.seqId;

    const now = performance.now();
    this.solverStepTimes.push(now);
    const cutoff = now - 1000;
    while (this.solverStepTimes.length > 0 && this.solverStepTimes[0] < cutoff) {
      this.solverStepTimes.shift();
    }

    // Ricicla i buffer dello snapshot precedente ormai sostituito
    if (this.latestSnapshot) {
      const oldField = this.latestSnapshot.fieldBytes.buffer;
      const oldVec = this.latestSnapshot.vectors?.buffer;
      this.reclaimBuffers(
        oldField instanceof ArrayBuffer ? oldField : undefined,
        oldVec instanceof ArrayBuffer ? oldVec : undefined
      );
    }

    this.latestSnapshot = {
      seqId: msg.seqId,
      gridN: msg.gridN,
      fieldBytes: new Uint8Array(msg.fieldBuffer),
      vectors: msg.vectorBuffer ? new Float32Array(msg.vectorBuffer) : null,
      vectorCount: msg.vectorCount,
      scaleRange: msg.scaleRange,
      metrics: msg.metrics,
      probe: msg.probe,
      stepMs: msg.stepMs,
    };
  }

  private reclaimBuffers(fieldBuffer?: ArrayBuffer, vectorBuffer?: ArrayBuffer): void {
    if (!fieldBuffer && !vectorBuffer) return;
    const tx: Transferable[] = [];
    if (fieldBuffer) tx.push(fieldBuffer);
    if (vectorBuffer) tx.push(vectorBuffer);
    this.postCommand(
      { type: 'reclaim', fieldBuffer, vectorBuffer },
      this.worker ? tx : undefined
    );
  }

  public recordRenderTick(): number {
    const now = performance.now();
    this.renderFrameTimes.push(now);
    const cutoff = now - 1000;
    while (this.renderFrameTimes.length > 0 && this.renderFrameTimes[0] < cutoff) {
      this.renderFrameTimes.shift();
    }
    return this.renderFrameTimes.length;
  }

  public getRenderFps(): number {
    return this.renderFrameTimes.length;
  }

  public getSolverUps(): number {
    return this.solverStepTimes.length;
  }

  public requestStep(params: {
    dt: number;
    config: FluidConfig;
    mode: VisualizationMode;
    includeVectors: boolean;
    stir?: { x0: number; y0: number; x1: number; y1: number; dt: number } | null;
    probe?: { xNorm: number; yNorm: number } | null;
  }): void {
    if (this.disposed) return;

    if (params.stir) {
      this.interactionEvents.push({
        type: 'stir',
        stepIndex: this.nextSeqId,
        tSimSec: this.latestSnapshot?.metrics.elapsedSec ?? 0,
        x0Norm: Number(params.stir.x0.toFixed(4)),
        y0Norm: Number(params.stir.y0.toFixed(4)),
        x1Norm: Number(params.stir.x1.toFixed(4)),
        y1Norm: Number(params.stir.y1.toFixed(4)),
        dtSec: Number(params.stir.dt.toFixed(4)),
      });
      if (this.interactionEvents.length > 2000) {
        this.interactionEvents.shift();
      }
    }

    // Backpressure: non accoda più di un frame in volo verso il worker per mantenere 60 FPS reattivi
    if (this.inFlight && this.worker) {
      return;
    }

    const seqId = this.nextSeqId++;
    this.inFlight = true;
    this.postCommand({
      type: 'step',
      seqId,
      dt: params.dt,
      config: params.config,
      mode: params.mode,
      includeVectors: params.includeVectors,
      renderFps: this.getRenderFps(),
      solverUps: this.getSolverUps(),
      stir: params.stir,
      probe: params.probe,
    });
  }

  public setQuality(quality: QualityLevel, config: FluidConfig): void {
    this.inFlight = false;
    this.latestSnapshot = null;
    this.postCommand({ type: 'setQuality', quality, config });
  }

  public reset(config: FluidConfig): void {
    this.inFlight = false;
    this.latestSnapshot = null;
    this.interactionEvents.push({
      type: 'reset',
      stepIndex: this.nextSeqId,
      tSimSec: 0,
      dtSec: 0,
      x0Norm: 0.5,
      y0Norm: 0.5,
      x1Norm: 0.5,
      y1Norm: 0.5,
    });
    this.postCommand({ type: 'reset', config });
  }

  public consumeLatestSnapshot(): FrameSnapshot | null {
    return this.latestSnapshot;
  }

  public getInteractionEvents(): InteractionEvent[] {
    return [...this.interactionEvents];
  }

  public isUsingWorker(): boolean {
    return this.worker !== null;
  }

  public dispose(): void {
    this.disposed = true;
    this.latestSnapshot = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.localFallback = null;
  }
}
