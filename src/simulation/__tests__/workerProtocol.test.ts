import { describe, expect, it } from 'vitest';
import { DEFAULT_FLUID_CONFIG } from '../../constants/fluids';
import { createWorkerProtocolHandler } from '../workerProtocol';

describe('Protocollo Worker, Transferable Pooling e Coerenza Qualità', () => {
  it('esegue init, step, reclaim pooling senza allocazioni crescenti e drop sicuro di qualità senza alterare i parametri fisici', () => {
    const handler = createWorkerProtocolHandler('standard');
    const cfg = { ...DEFAULT_FLUID_CONFIG, viscosityMpas: 450, densityKgM3: 1120 };

    const initRes = handler.handleMessage({ type: 'init', config: cfg });
    expect(initRes.response?.type).toBe('ready');
    if (initRes.response?.type === 'ready') {
      expect(initRes.response.gridN).toBe(96);
    }

    // Primo step con vettori e sonda
    const step1 = handler.handleMessage({
      type: 'step',
      seqId: 1,
      dt: 0.016,
      config: cfg,
      mode: 'velocity',
      includeVectors: true,
      renderFps: 60,
      solverUps: 60,
      stir: { x0: 0.4, y0: 0.5, x1: 0.55, y1: 0.5, dt: 0.016 },
      probe: { xNorm: 0.5, yNorm: 0.5 },
    });

    expect(step1.response?.type).toBe('frame');
    if (step1.response?.type !== 'frame') return;
    expect(step1.response.seqId).toBe(1);
    expect(step1.response.gridN).toBe(96);
    expect(step1.response.fieldBuffer.byteLength).toBe(96 * 96 * 4);
    expect(step1.response.vectorBuffer).toBeDefined();
    expect(step1.transferables.length).toBe(2);
    expect(step1.response.probe?.active).toBe(true);
    expect(step1.response.metrics.diagnostics.gridN).toBe(96);

    // Restituisce i buffer al pool
    handler.handleMessage({
      type: 'reclaim',
      fieldBuffer: step1.response.fieldBuffer,
      vectorBuffer: step1.response.vectorBuffer,
    });
    expect(handler.getPoolSizes()).toEqual({ field: 1, vector: 1 });

    // Secondo step: deve riutilizzare esattamente gli stessi ArrayBuffer dal pool!
    const step2 = handler.handleMessage({
      type: 'step',
      seqId: 2,
      dt: 0.016,
      config: cfg,
      mode: 'velocity',
      includeVectors: true,
      renderFps: 60,
      solverUps: 60,
      probe: null,
    });
    expect(step2.response?.type).toBe('frame');
    if (step2.response?.type === 'frame') {
      expect(step2.response.fieldBuffer).toBe(step1.response.fieldBuffer);
      expect(step2.response.vectorBuffer).toBe(step1.response.vectorBuffer);
      expect(handler.getPoolSizes()).toEqual({ field: 0, vector: 0 });
    }

    // Cambio qualità a high (128x128) non altera i parametri fisici configurati
    const qRes = handler.handleMessage({
      type: 'setQuality',
      quality: 'high',
      config: { ...cfg, quality: 'high' },
    });
    expect(qRes.response?.type).toBe('ready');
    expect(handler.getGridN()).toBe(128);
    expect(cfg.viscosityMpas).toBe(450);
    expect(cfg.densityKgM3).toBe(1120);
  });
});
