import { getGridResolutionForQuality } from '../constants/fluids';
import {
  FluidConfig,
  ProbeSample,
  QualityLevel,
  ScaleRange,
  SimulationMetrics,
  VisualizationMode,
} from '../types/rheology';
import { NavierStokesSolver } from './navierStokesSolver';

export type WorkerCommand =
  | { type: 'init'; config: FluidConfig }
  | {
      type: 'step';
      seqId: number;
      dt: number;
      config: FluidConfig;
      mode: VisualizationMode;
      includeVectors: boolean;
      renderFps: number;
      solverUps: number;
      stir?: { x0: number; y0: number; x1: number; y1: number; dt: number } | null;
      probe?: { xNorm: number; yNorm: number } | null;
    }
  | { type: 'reset'; config: FluidConfig }
  | { type: 'setQuality'; quality: QualityLevel; config: FluidConfig }
  | { type: 'reclaim'; fieldBuffer?: ArrayBuffer; vectorBuffer?: ArrayBuffer };

export type WorkerResponse =
  | { type: 'ready'; gridN: number }
  | {
      type: 'frame';
      seqId: number;
      gridN: number;
      fieldBuffer: ArrayBuffer;
      vectorBuffer?: ArrayBuffer;
      vectorCount: number;
      scaleRange: ScaleRange;
      metrics: SimulationMetrics;
      probe: ProbeSample | null;
      stepMs: number;
    };

export interface WorkerProtocolResult {
  response?: WorkerResponse;
  transferables: Transferable[];
}

const MAX_VECTOR_SAMPLES = 400; // <= (128/6)^2

export function createWorkerProtocolHandler(initialQuality: QualityLevel = 'standard') {
  let currentQuality: QualityLevel = initialQuality;
  let solver = new NavierStokesSolver(getGridResolutionForQuality(currentQuality), {
    type: 'cylindrical-tank',
  });

  const fieldPool: ArrayBuffer[] = [];
  const vectorPool: ArrayBuffer[] = [];

  const acquireFieldBuffer = (gridN: number): ArrayBuffer => {
    const neededBytes = gridN * gridN * 4;
    while (fieldPool.length > 0) {
      const buf = fieldPool.pop()!;
      if (buf.byteLength === neededBytes) return buf;
    }
    return new ArrayBuffer(neededBytes);
  };

  const acquireVectorBuffer = (): ArrayBuffer => {
    const neededBytes = MAX_VECTOR_SAMPLES * 4 * 4;
    while (vectorPool.length > 0) {
      const buf = vectorPool.pop()!;
      if (buf.byteLength === neededBytes) return buf;
    }
    return new ArrayBuffer(neededBytes);
  };

  const handleMessage = (cmd: WorkerCommand): WorkerProtocolResult => {
    if (cmd.type === 'reclaim') {
      if (cmd.fieldBuffer && cmd.fieldBuffer.byteLength > 0 && fieldPool.length < 4) {
        fieldPool.push(cmd.fieldBuffer);
      }
      if (cmd.vectorBuffer && cmd.vectorBuffer.byteLength > 0 && vectorPool.length < 4) {
        vectorPool.push(cmd.vectorBuffer);
      }
      return { transferables: [] };
    }

    if (cmd.type === 'init') {
      if (cmd.config.quality !== currentQuality) {
        currentQuality = cmd.config.quality;
        solver = new NavierStokesSolver(getGridResolutionForQuality(currentQuality), {
          type: 'cylindrical-tank',
        });
      }
      solver.reset(cmd.config.viscosityMpas * 1e-3);
      return {
        response: { type: 'ready', gridN: solver.n },
        transferables: [],
      };
    }

    if (cmd.type === 'setQuality') {
      const targetN = getGridResolutionForQuality(cmd.quality);
      currentQuality = cmd.quality;
      if (solver.n !== targetN) {
        solver = new NavierStokesSolver(targetN, { type: 'cylindrical-tank' });
        solver.reset(cmd.config.viscosityMpas * 1e-3);
        fieldPool.length = 0;
      }
      return {
        response: { type: 'ready', gridN: solver.n },
        transferables: [],
      };
    }

    if (cmd.type === 'reset') {
      solver.reset(cmd.config.viscosityMpas * 1e-3);
      return {
        response: { type: 'ready', gridN: solver.n },
        transferables: [],
      };
    }

    // cmd.type === 'step'
    const targetN = getGridResolutionForQuality(cmd.config.quality);
    if (solver.n !== targetN) {
      currentQuality = cmd.config.quality;
      solver = new NavierStokesSolver(targetN, { type: 'cylindrical-tank' });
      solver.reset(cmd.config.viscosityMpas * 1e-3);
      fieldPool.length = 0;
    }

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (cmd.stir) {
      solver.applyStirrerImpulse(
        cmd.stir.x0,
        cmd.stir.y0,
        cmd.stir.x1,
        cmd.stir.y1,
        cmd.stir.dt,
        cmd.config
      );
    }
    solver.step(cmd.dt, cmd.config);

    const scaleRange = solver.prepareRenderFields(cmd.mode);
    const fieldBuffer = acquireFieldBuffer(solver.n);
    solver.packRenderBytes(new Uint8Array(fieldBuffer), cmd.mode);

    let vectorBuffer: ArrayBuffer | undefined;
    let vectorCount = 0;
    const transferables: Transferable[] = [fieldBuffer];

    if (cmd.includeVectors) {
      vectorBuffer = acquireVectorBuffer();
      const vecArr = new Float32Array(vectorBuffer);
      vectorCount = solver.packVectorSamples(vecArr, 6);
      transferables.push(vectorBuffer);
    }

    const probe = cmd.probe
      ? solver.sampleProbe(cmd.probe.xNorm, cmd.probe.yNorm, cmd.config)
      : null;

    const metrics = solver.getMetrics(cmd.config, scaleRange, cmd.renderFps, cmd.solverUps);
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    return {
      response: {
        type: 'frame',
        seqId: cmd.seqId,
        gridN: solver.n,
        fieldBuffer,
        vectorBuffer,
        vectorCount,
        scaleRange,
        metrics,
        probe,
        stepMs: t1 - t0,
      },
      transferables,
    };
  };

  return {
    handleMessage,
    getGridN: () => solver.n,
    getPoolSizes: () => ({ field: fieldPool.length, vector: vectorPool.length }),
  };
}
