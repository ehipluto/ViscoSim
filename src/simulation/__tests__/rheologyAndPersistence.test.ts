import { describe, expect, it } from 'vitest';
import {
  clampBaseViscosityMpas,
  clampToSolverViscosityDomainPaS,
  computeApparentViscosityPaS,
  computeShearStressPa,
  DEFAULT_FLUID_CONFIG,
  MAX_SOLVER_VISCOSITY_PAS,
  MAX_VISCOSITY_MPAS,
  MIN_SOLVER_VISCOSITY_PAS,
  MIN_VISCOSITY_MPAS,
  SHEAR_REGULARIZATION_S_INV,
} from '../../constants/fluids';
import {
  decodeConfigFromUrlParam,
  encodeConfigToUrlParam,
  validateAndMigrateFluidConfig,
} from '../persistence';

describe('Leggi Costitutive e Unità SI', () => {
  it('esclude rigorosamente la viscosità nulla dal dominio utente e mantiene coerenza Newtoniana', () => {
    expect(clampBaseViscosityMpas(0)).toBe(MIN_VISCOSITY_MPAS);
    expect(clampBaseViscosityMpas(-5)).toBe(MIN_VISCOSITY_MPAS);
    expect(clampBaseViscosityMpas(1e9)).toBe(MAX_VISCOSITY_MPAS);

    const water = { ...DEFAULT_FLUID_CONFIG, model: 'newtonian' as const, viscosityMpas: 1.0 };
    expect(computeApparentViscosityPaS(0, water)).toBeCloseTo(1e-3, 12);
    expect(computeApparentViscosityPaS(1000, water)).toBeCloseTo(1e-3, 12);
    expect(computeShearStressPa(0, water)).toBe(0);
    expect(computeShearStressPa(500, water)).toBeCloseTo(0.5, 12);
  });

  it('rispetta la formula regolarizzata Power-Law senza clamping silenziosi e con stress monotono', () => {
    const shearThin = {
      ...DEFAULT_FLUID_CONFIG,
      model: 'power-law' as const,
      viscosityMpas: 1000, // K = 1.0 Pa*s^n
      flowIndex: 0.6,
    };

    // A taglio nullo la regolarizzazione produce plateau finito coerente e tau(0) = 0
    const mu0 = computeApparentViscosityPaS(0, shearThin);
    const expectedMu0 = 1.0 * Math.pow(SHEAR_REGULARIZATION_S_INV, 0.6 - 1);
    expect(mu0).toBeCloseTo(expectedMu0, 8);
    expect(computeShearStressPa(0, shearThin)).toBe(0);

    // Verifica assenza di clamp artificiali ad alto/basso taglio rispetto alla formula chiusa
    let prevTau = 0;
    for (const g of [1e-3, 1e-2, 0.1, 1, 10, 100, 1000, 10000]) {
      const gEff = Math.hypot(g, SHEAR_REGULARIZATION_S_INV);
      const expectedMu = 1.0 * Math.pow(gEff, -0.4);
      const actualMu = computeApparentViscosityPaS(g, shearThin);
      expect(Math.abs(actualMu - expectedMu) / expectedMu).toBeLessThan(1e-12);

      const tau = computeShearStressPa(g, shearThin);
      expect(tau).toBeGreaterThan(prevTau);
      prevTau = tau;
    }

    // Dilatante (n > 1) a viscosità estrema K = 500 Pa*s^n non troncato arbitrariamente a 1200 Pa*s
    const thick = {
      ...DEFAULT_FLUID_CONFIG,
      model: 'power-law' as const,
      viscosityMpas: 500000,
      flowIndex: 1.5,
    };
    const muHigh = computeApparentViscosityPaS(100, thick);
    expect(muHigh).toBeGreaterThan(4000);
  });

  it('verifica Herschel-Bulkley (Papanastasiou) a taglio nullo, asintoto e combinazioni estreme', () => {
    const hb = {
      ...DEFAULT_FLUID_CONFIG,
      model: 'herschel-bulkley' as const,
      viscosityMpas: 50000, // K = 50 Pa*s^n
      flowIndex: 0.4,
      yieldStressPa: 180,
      papanastasiouM: 2.5,
    };

    const muZero = computeApparentViscosityPaS(0, hb);
    expect(Number.isFinite(muZero)).toBe(true);
    expect(muZero).toBeGreaterThan(hb.yieldStressPa * hb.papanastasiouM * 0.5);
    expect(computeShearStressPa(0, hb)).toBe(0);

    // Per m * gamma >> 1 deve avvicinarsi a tau_y + K * gamma^n entro lo scarto esponenziale e^(-m*gamma)
    const gHigh = 100;
    const tauHigh = computeShearStressPa(gHigh, hb);
    const asymptoticTau = hb.yieldStressPa + 50 * Math.pow(gHigh, hb.flowIndex);
    expect(Math.abs(tauHigh - asymptoticTau) / asymptoticTau).toBeLessThan(1e-6);

    // Combinazione estrema: tau_y = 500 Pa, m = 20 s, K = 500 Pa*s^n
    const extreme = {
      ...hb,
      viscosityMpas: 500000,
      yieldStressPa: 500,
      papanastasiouM: 20,
      flowIndex: 0.15,
    };
    const muExtreme = computeApparentViscosityPaS(1e-4, extreme);
    expect(Number.isFinite(muExtreme)).toBe(true);
    const bounded = clampToSolverViscosityDomainPaS(muExtreme);
    expect(bounded.value).toBeLessThanOrEqual(MAX_SOLVER_VISCOSITY_PAS);
    expect(bounded.value).toBeGreaterThanOrEqual(MIN_SOLVER_VISCOSITY_PAS);
    expect(bounded.clamped).toBe(muExtreme > MAX_SOLVER_VISCOSITY_PAS);
  });

  it('mostra la sensibilità attesa al parametro di regolarizzazione solo vicino a gamma -> 0', () => {
    const cfg = {
      ...DEFAULT_FLUID_CONFIG,
      model: 'power-law' as const,
      viscosityMpas: 5000,
      flowIndex: 0.5,
    };
    const muRegSmall = computeApparentViscosityPaS(1e-4, cfg, 1e-4);
    const muRegStd = computeApparentViscosityPaS(1e-4, cfg, 1e-3);
    expect(muRegSmall).toBeGreaterThan(muRegStd);

    // Ad alto shear rate (100 s^-1) la differenza relativa dovuta alla regolarizzazione deve essere trascurabile (< 1e-9)
    const muHighA = computeApparentViscosityPaS(100, cfg, 1e-4);
    const muHighB = computeApparentViscosityPaS(100, cfg, 1e-3);
    expect(Math.abs(muHighA - muHighB) / muHighB).toBeLessThan(1e-9);
  });
});

describe('Persistenza Versionata e Validazione Schema v2', () => {
  it('migra correttamente schema v1 con viscosità nulla al minimo consentito', () => {
    const legacy = {
      model: 'newtonian',
      viscosityMpas: 0,
      flowIndex: 1,
      yieldStressPa: 0,
      densityKgM3: 1000,
      tankDiameterMm: 200,
      stirrerDiameterMm: 16,
      color: '#06b6d4',
    };
    const res = validateAndMigrateFluidConfig(legacy);
    expect(res.ok).toBe(true);
    expect(res.config?.viscosityMpas).toBe(MIN_VISCOSITY_MPAS);
    expect(res.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('respinge payload corrotti, modelli sconosciuti e NaN', () => {
    expect(validateAndMigrateFluidConfig(null).ok).toBe(false);
    expect(validateAndMigrateFluidConfig({ model: 'inviscid', viscosityMpas: 1 }).ok).toBe(false);
    expect(validateAndMigrateFluidConfig({ model: 'newtonian', viscosityMpas: NaN }).ok).toBe(false);
    expect(validateAndMigrateFluidConfig({ schemaVersion: 99, config: {} }).ok).toBe(false);
  });

  it('mantiene coerenza geometrica asta-vasca e round-trip URL esatto', () => {
    const custom = {
      ...DEFAULT_FLUID_CONFIG,
      presetId: null,
      name: 'Emulsione Test',
      model: 'herschel-bulkley' as const,
      viscosityMpas: 4500,
      flowIndex: 0.55,
      yieldStressPa: 35,
      enableSmagorinsky: true,
      smagorinskyCs: 0.16,
      quality: 'high' as const,
    };
    const encoded = encodeConfigToUrlParam(custom);
    const decoded = decodeConfigFromUrlParam(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.config).toEqual(custom);
  });
});
