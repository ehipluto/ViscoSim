import { describe, expect, it } from 'vitest';
import { DEFAULT_FLUID_CONFIG, FLUID_PRESETS } from '../../constants/fluids';
import { FluidConfig } from '../../types/rheology';
import { NavierStokesSolver } from '../navierStokesSolver';
import baselineSnapshot from './baselineMetrics.json';

describe('Stabilità Numerica, Conservazione Massa/Tracciante e Regressione', () => {
  it('sweep completo 0.01 – 500.000 mPa·s: divergenza, CFL, flusso netto al contorno e dissipazione passiva', () => {
    const solver = new NavierStokesSolver(64, { type: 'cylindrical-tank' });
    const viscosities = [0.01, 0.32, 1, 14, 450, 1412, 10000, 50000, 250000, 500000];

    for (const vMpas of viscosities) {
      const preset = FLUID_PRESETS.find((p) => p.viscosityMpas === vMpas);
      const cfg: FluidConfig = preset
        ? { ...DEFAULT_FLUID_CONFIG, ...preset, presetId: preset.id }
        : { ...DEFAULT_FLUID_CONFIG, presetId: null, viscosityMpas: vMpas };

      solver.reset(vMpas * 1e-3);

      // Fase 1: agitazione circolare
      for (let s = 0; s < 8; s++) {
        const a0 = s * 0.35;
        const a1 = (s + 1) * 0.35;
        solver.applyStirrerImpulse(
          0.5 + 0.18 * Math.cos(a0),
          0.5 + 0.18 * Math.sin(a0),
          0.5 + 0.18 * Math.cos(a1),
          0.5 + 0.18 * Math.sin(a1),
          0.016,
          cfg
        );
        solver.step(0.016, cfg);
      }

      const diagStir = solver.getDiagnostics();
      expect(Number.isFinite(diagStir.divRms)).toBe(true);
      expect(diagStir.courantNumber).toBeLessThanOrEqual(0.66);
      expect(diagStir.divRms).toBeLessThan(1e-3);
      expect(Math.abs(diagStir.netBoundaryFlux)).toBeLessThan(1e-5);
      expect(['converged', 'under-relaxed', 'load-shedding']).toContain(diagStir.convergenceStatus);

      // Fase 2: rilascio senza forzanti -> decadimento energia cinetica
      let prevEk = diagStir.kineticEnergyJKg;
      for (let s = 0; s < 6; s++) {
        solver.step(0.016, cfg);
        const ek = solver.getDiagnostics().kineticEnergyJKg;
        expect(ek).toBeLessThanOrEqual(prevEk * 1.005 + 1e-9);
        prevEk = ek;
      }
    }
  }, 45000);

  it('sweep multifattoriale su densità, geometrie estreme e modelli reologici', () => {
    const solver = new NavierStokesSolver(64, { type: 'cylindrical-tank' });
    const combos: Array<Partial<FluidConfig>> = [
      { model: 'newtonian', viscosityMpas: 0.01, densityKgM3: 600, tankDiameterMm: 100, stirrerDiameterMm: 20 },
      { model: 'power-law', viscosityMpas: 1200, flowIndex: 0.3, densityKgM3: 1400, tankDiameterMm: 300, stirrerDiameterMm: 12 },
      { model: 'power-law', viscosityMpas: 500, flowIndex: 1.65, densityKgM3: 1800, tankDiameterMm: 200, stirrerDiameterMm: 30 },
      { model: 'herschel-bulkley', viscosityMpas: 150000, flowIndex: 0.45, yieldStressPa: 400, densityKgM3: 2200, tankDiameterMm: 450, stirrerDiameterMm: 50 },
    ];

    for (const partial of combos) {
      const cfg = { ...DEFAULT_FLUID_CONFIG, ...partial };
      solver.reset(cfg.viscosityMpas * 1e-3);
      for (let s = 0; s < 10; s++) {
        solver.applyStirrerImpulse(0.45, 0.45, 0.55, 0.52, 0.016, cfg);
        solver.step(0.016, cfg);
      }
      const d = solver.getDiagnostics();
      expect(Number.isFinite(d.kineticEnergyJKg)).toBe(true);
      expect(d.divRms).toBeLessThan(1e-3);
      expect(d.courantNumber).toBeLessThanOrEqual(0.66);
    }
  }, 25000);

  it('conservazione massa integrale del tracciante e crescita miscelazione Danckwerts', () => {
    const solver = new NavierStokesSolver(64, { type: 'cylindrical-tank' });
    const cfg = { ...DEFAULT_FLUID_CONFIG, viscosityMpas: 2.0 };
    solver.reset(2e-3);

    const mass0 = solver.computeTracerMassIntegral(cfg);
    const m0 = solver.getMetrics(cfg, solver.getActiveScaleRange('velocity')).mixingIndex;

    for (let s = 0; s < 40; s++) {
      const a0 = s * 0.3;
      const a1 = (s + 1) * 0.3;
      solver.applyStirrerImpulse(
        0.5 + 0.2 * Math.cos(a0),
        0.5 + 0.2 * Math.sin(a0),
        0.5 + 0.2 * Math.cos(a1),
        0.5 + 0.2 * Math.sin(a1),
        0.016,
        cfg
      );
      solver.step(0.016, cfg);
    }

    const massEnd = solver.computeTracerMassIntegral(cfg);
    const relMassErr = Math.abs(massEnd - mass0) / mass0;
    const mEnd = solver.getMetrics(cfg, solver.getActiveScaleRange('velocity')).mixingIndex;

    expect(relMassErr).toBeLessThan(0.025);
    expect(mEnd).toBeGreaterThan(m0);
  }, 25000);

  it('preserva il vincolo CFL tramite substep adattivi e rallentamento esplicito invece di violare CFL', () => {
    const solver = new NavierStokesSolver(96, { type: 'cylindrical-tank' });
    const cfg = { ...DEFAULT_FLUID_CONFIG, tankDiameterMm: 100, viscosityMpas: 1.0 };
    solver.reset(1e-3);

    // Impulso ad alta velocità + passo richiesto ampio (0.033 s)
    solver.applyStirrerImpulse(0.25, 0.5, 0.75, 0.5, 0.008, cfg);
    solver.step(0.033, cfg);

    const diag = solver.getDiagnostics();
    expect(diag.courantNumber).toBeLessThanOrEqual(0.651);
    expect(diag.substepsLastStep).toBeGreaterThan(1);
  }, 15000);

  it('distingue Reynolds a fluido fermo (= 0) da fluido in moto e separa mu_sgs sperimentale (off di default)', () => {
    const solver = new NavierStokesSolver(64, { type: 'cylindrical-tank' });
    const cfgOff = { ...DEFAULT_FLUID_CONFIG, enableSmagorinsky: false };
    solver.reset(1e-3);

    const restMetrics = solver.getMetrics(cfgOff, solver.getActiveScaleRange('velocity'));
    expect(restMetrics.reynolds).toBe(0);
    expect(restMetrics.regime).toBe('Fermo');
    expect(restMetrics.sgsMeanViscosityMpas).toBe(0);

    solver.applyStirrerImpulse(0.4, 0.5, 0.6, 0.5, 0.016, cfgOff);
    solver.step(0.016, cfgOff);
    const activeOff = solver.getMetrics(cfgOff, solver.getActiveScaleRange('velocity'));
    expect(activeOff.reynolds).toBeGreaterThan(100);
    expect(activeOff.sgsMeanViscosityMpas).toBe(0);

    // Con Smagorinsky attivo esplicitamente, mu_sgs > 0 e resta separata
    const cfgOn = { ...cfgOff, enableSmagorinsky: true, smagorinskyCs: 0.16 };
    solver.applyStirrerImpulse(0.4, 0.5, 0.6, 0.5, 0.016, cfgOn);
    solver.step(0.016, cfgOn);
    const activeOn = solver.getMetrics(cfgOn, solver.getActiveScaleRange('velocity'));
    expect(activeOn.diagnostics.sgsMaxViscosityMpas).toBeGreaterThan(0);
  }, 15000);

  it('non regredisce rispetto alla baseline v1 sulla divergenza normalizzata post-decadimento', () => {
    const solver = new NavierStokesSolver(96, { type: 'cylindrical-tank' });
    for (const ref of baselineSnapshot.cases) {
      const preset = FLUID_PRESETS.find((p) => p.id === ref.id);
      const cfg: FluidConfig = preset
        ? { ...DEFAULT_FLUID_CONFIG, ...preset, presetId: preset.id }
        : {
            ...DEFAULT_FLUID_CONFIG,
            presetId: null,
            viscosityMpas: ref.id === 'custom-0.01' ? 0.01 : 500000,
          };

      solver.reset(cfg.viscosityMpas * 1e-3);
      for (let s = 0; s < 5; s++) {
        const a0 = s * 0.4;
        const a1 = (s + 1) * 0.4;
        solver.applyStirrerImpulse(
          0.5 + 0.18 * Math.cos(a0),
          0.5 + 0.18 * Math.sin(a0),
          0.5 + 0.18 * Math.cos(a1),
          0.5 + 0.18 * Math.sin(a1),
          0.016,
          cfg
        );
        solver.step(0.016, cfg);
      }
      for (let s = 0; s < 5; s++) {
        solver.step(0.016, cfg);
      }
      const diag = solver.getDiagnostics();
      // Tolleriamo margine minimo se baseline era già prossima a tolleranza PCG
      expect(diag.divRms).toBeLessThanOrEqual(Math.max(1e-4, ref.divRmsNorm * 1.1));
    }
  }, 60000);
});
