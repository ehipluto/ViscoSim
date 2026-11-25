import {
  clampBaseViscosityMpas,
  computeApparentViscosityPaS,
  DEFAULT_FLUID_CONFIG,
  getGridResolutionForQuality,
  getViscosityColorHex,
  MAX_VISCOSITY_MPAS,
  MIN_VISCOSITY_MPAS,
  SHEAR_REGULARIZATION_S_INV,
} from '../constants/fluids';
import {
  ConfigValidationResult,
  FluidConfig,
  InteractionEvent,
  InteractionTraceV2,
  PersistedConfigV2,
  QualityLevel,
  RheologyModel,
  SimulationMetrics,
  TimeSeriesPoint,
} from '../types/rheology';

export const SOLVER_VERSION = '2.0.0-si-picard-mg';
export const STORAGE_KEY_V2 = 'viscosim.config.v2';
export const STORAGE_KEY_V1 = 'viscosim.config.v1';

const VALID_MODELS: readonly RheologyModel[] = ['newtonian', 'power-law', 'herschel-bulkley'];
const VALID_QUALITIES: readonly QualityLevel[] = ['low', 'standard', 'high'];
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Valida rigorosamente ed esegue la migrazione (v1 -> v2) di qualsiasi configurazione
 * proveniente da localStorage, URL query parameter o file JSON importato.
 */
export function validateAndMigrateFluidConfig(input: unknown): ConfigValidationResult {
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, warnings, error: 'Formato configurazione non valido (atteso oggetto JSON).' };
  }

  let rawCfg: Record<string, unknown> = input;
  if ('schemaVersion' in input) {
    if (input.schemaVersion === 2 && isPlainObject(input.config)) {
      rawCfg = input.config;
    } else if (input.schemaVersion === 1 && isPlainObject(input.config)) {
      rawCfg = input.config;
      warnings.push('Configurazione migrata automaticamente dallo schema v1 allo schema v2.');
    } else if (input.schemaVersion !== 1 && input.schemaVersion !== 2) {
      return {
        ok: false,
        warnings,
        error: `Versione schema non supportata: ${String(input.schemaVersion)}.`,
      };
    }
  } else {
    warnings.push('Configurazione legacy priva di versione schema: applicata migrazione v2.');
  }

  const rawModel = rawCfg.model;
  if (typeof rawModel !== 'string' || !VALID_MODELS.includes(rawModel as RheologyModel)) {
    return { ok: false, warnings, error: 'Modello reologico mancante o non riconosciuto.' };
  }
  const model = rawModel as RheologyModel;

  const rawVisc = Number(rawCfg.viscosityMpas);
  if (!Number.isFinite(rawVisc)) {
    return { ok: false, warnings, error: 'Valore di viscosità non numerico o non finito.' };
  }
  let viscosityMpas = rawVisc;
  if (rawVisc <= 0) {
    viscosityMpas = MIN_VISCOSITY_MPAS;
    warnings.push(`Viscosità nulla non ammessa dal dominio fisico: impostata al minimo ${MIN_VISCOSITY_MPAS} mPa·s.`);
  } else if (rawVisc < MIN_VISCOSITY_MPAS || rawVisc > MAX_VISCOSITY_MPAS) {
    viscosityMpas = clampBaseViscosityMpas(rawVisc);
    warnings.push(`Viscosità limitata all’intervallo consentito [${MIN_VISCOSITY_MPAS}, ${MAX_VISCOSITY_MPAS}] mPa·s.`);
  }

  const rawFlowIndex = Number(rawCfg.flowIndex ?? 1.0);
  if (!Number.isFinite(rawFlowIndex)) {
    return { ok: false, warnings, error: 'Indice di flusso n non valido.' };
  }
  const flowIndex = Math.max(0.15, Math.min(1.8, rawFlowIndex));
  if (flowIndex !== rawFlowIndex) {
    warnings.push('Indice di flusso n ricondotto nell’intervallo [0.15, 1.80].');
  }

  const rawYield = Number(rawCfg.yieldStressPa ?? 0);
  if (!Number.isFinite(rawYield)) {
    return { ok: false, warnings, error: 'Sforzo di snervamento τy non valido.' };
  }
  const yieldStressPa = Math.max(0, Math.min(500, rawYield));
  if (yieldStressPa !== rawYield) {
    warnings.push('Sforzo di snervamento τy ricondotto nell’intervallo [0, 500] Pa.');
  }

  const rawPapanastasiou = Number(rawCfg.papanastasiouM ?? DEFAULT_FLUID_CONFIG.papanastasiouM);
  const papanastasiouM = Number.isFinite(rawPapanastasiou)
    ? Math.max(0.5, Math.min(20, rawPapanastasiou))
    : DEFAULT_FLUID_CONFIG.papanastasiouM;

  const rawDensity = Number(rawCfg.densityKgM3);
  if (!Number.isFinite(rawDensity)) {
    return { ok: false, warnings, error: 'Densità ρ non valida.' };
  }
  const densityKgM3 = Math.max(500, Math.min(2500, rawDensity));
  if (densityKgM3 !== rawDensity) {
    warnings.push('Densità ρ ricondotta nell’intervallo [500, 2500] kg/m³.');
  }

  const rawTank = Number(rawCfg.tankDiameterMm);
  if (!Number.isFinite(rawTank)) {
    return { ok: false, warnings, error: 'Diametro vasca D non valido.' };
  }
  const tankDiameterMm = Math.max(50, Math.min(600, rawTank));

  const maxAllowedStirrer = Math.min(80, Math.floor(tankDiameterMm * 0.7));
  const rawStirrer = Number(rawCfg.stirrerDiameterMm);
  if (!Number.isFinite(rawStirrer)) {
    return { ok: false, warnings, error: 'Diametro asta d non valido.' };
  }
  const stirrerDiameterMm = Math.max(6, Math.min(maxAllowedStirrer, rawStirrer));
  if (stirrerDiameterMm !== rawStirrer) {
    warnings.push(`Diametro asta d adattato a [6, ${maxAllowedStirrer}] mm per coerenza geometrica con D.`);
  }

  const color =
    typeof rawCfg.color === 'string' && HEX_COLOR_RE.test(rawCfg.color.trim())
      ? rawCfg.color.trim()
      : getViscosityColorHex(viscosityMpas);

  const enableSmagorinsky = Boolean(rawCfg.enableSmagorinsky ?? false);
  const rawCs = Number(rawCfg.smagorinskyCs ?? DEFAULT_FLUID_CONFIG.smagorinskyCs);
  const smagorinskyCs = Number.isFinite(rawCs)
    ? Math.max(0.05, Math.min(0.3, rawCs))
    : DEFAULT_FLUID_CONFIG.smagorinskyCs;

  const quality: QualityLevel =
    typeof rawCfg.quality === 'string' && VALID_QUALITIES.includes(rawCfg.quality as QualityLevel)
      ? (rawCfg.quality as QualityLevel)
      : 'standard';

  const presetId = typeof rawCfg.presetId === 'string' && rawCfg.presetId.length > 0 ? rawCfg.presetId : null;
  const name =
    typeof rawCfg.name === 'string' && rawCfg.name.trim().length > 0
      ? rawCfg.name.trim().slice(0, 64)
      : 'Fluido Personalizzato';

  const normalizedModelValues =
    model === 'newtonian'
      ? { flowIndex: 1.0, yieldStressPa: 0 }
      : model === 'power-law'
      ? { flowIndex, yieldStressPa: 0 }
      : { flowIndex, yieldStressPa };

  return {
    ok: true,
    warnings,
    config: {
      presetId,
      name,
      model,
      viscosityMpas,
      flowIndex: normalizedModelValues.flowIndex,
      yieldStressPa: normalizedModelValues.yieldStressPa,
      papanastasiouM,
      densityKgM3,
      tankDiameterMm,
      stirrerDiameterMm,
      color,
      enableSmagorinsky,
      smagorinskyCs,
      quality,
    },
  };
}

export function wrapPersistedConfigV2(config: FluidConfig): PersistedConfigV2 {
  return {
    schemaVersion: 2,
    units: {
      viscosity: 'mPa*s',
      yieldStress: 'Pa',
      papanastasiouM: 's',
      density: 'kg/m^3',
      length: 'mm',
    },
    config,
  };
}

export function encodeConfigToUrlParam(config: FluidConfig): string {
  const payload = JSON.stringify(wrapPersistedConfigV2(config));
  const bytes = new TextEncoder().encode(payload);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConfigFromUrlParam(encoded: string): ConfigValidationResult {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const bin = atob(padded + '='.repeat(padLen));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    return validateAndMigrateFluidConfig(JSON.parse(json));
  } catch {
    return { ok: false, warnings: [], error: 'Parametro URL di configurazione corrotto o illeggibile.' };
  }
}

export function loadInitialConfigFromBrowser(): {
  config: FluidConfig;
  warnings: string[];
  source: 'url' | 'localStorage' | 'default';
} {
  if (typeof window === 'undefined') {
    return { config: DEFAULT_FLUID_CONFIG, warnings: [], source: 'default' };
  }

  const params = new URLSearchParams(window.location.search);
  const urlCfg = params.get('cfg');
  if (urlCfg) {
    const res = decodeConfigFromUrlParam(urlCfg);
    if (res.ok && res.config) {
      return { config: res.config, warnings: res.warnings, source: 'url' };
    }
  }

  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const res = validateAndMigrateFluidConfig(JSON.parse(rawV2));
      if (res.ok && res.config) {
        return { config: res.config, warnings: res.warnings, source: 'localStorage' };
      }
    }
    const rawV1 = window.localStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const res = validateAndMigrateFluidConfig(JSON.parse(rawV1));
      if (res.ok && res.config) {
        return { config: res.config, warnings: res.warnings, source: 'localStorage' };
      }
    }
  } catch {
    // Accesso localStorage negato o JSON corrotto: fallback controllato ai predefiniti
  }

  return { config: DEFAULT_FLUID_CONFIG, warnings: [], source: 'default' };
}

export function saveConfigToLocalStorage(config: FluidConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(wrapPersistedConfigV2(config)));
  } catch {
    // Quota esaurita o contesto privato
  }
}

export function buildInteractionTraceV2(
  initialConfig: FluidConfig,
  events: InteractionEvent[],
  seed = 1
): InteractionTraceV2 {
  return {
    schemaVersion: 2,
    solverVersion: SOLVER_VERSION,
    gridN: getGridResolutionForQuality(initialConfig.quality),
    seed,
    exportedAt: new Date().toISOString(),
    initialConfig,
    events,
    note: 'La riproducibilita della traccia si riferisce alla stessa piattaforma/motore e sequenza discreta di input; il determinismo bit-per-bit tra architetture IEEE-754/browser differenti non e garantito senza verifica dedicata.',
  };
}

export function buildCsvReport(
  config: FluidConfig,
  metrics: SimulationMetrics,
  history: TimeSeriesPoint[]
): string {
  const modelLabels: Record<RheologyModel, string> = {
    newtonian: 'Newtoniano',
    'power-law': 'Power-Law',
    'herschel-bulkley': 'Herschel-Bulkley (Papanastasiou)',
  };

  const lines: string[] = [
    'ViscoSim CFD Report',
    `Schema Versione,2`,
    `Versione Solutore,${SOLVER_VERSION}`,
    `Griglia (celle),${metrics.diagnostics.gridN}x${metrics.diagnostics.gridN}`,
    `Fluido,${config.name}`,
    `Modello Reologico,${modelLabels[config.model]}`,
    `Consistenza / Viscosita base K (mPa*s),${config.viscosityMpas}`,
    `Indice di Flusso n (adimensionale),${config.model === 'newtonian' ? 1 : config.flowIndex}`,
    `Sforzo di Snervamento tau_y (Pa),${config.model === 'herschel-bulkley' ? config.yieldStressPa : 0}`,
    `Parametro Papanastasiou m (s),${config.model === 'herschel-bulkley' ? config.papanastasiouM : 0}`,
    `Regolarizzazione Taglio Zero gamma_reg (1/s),${SHEAR_REGULARIZATION_S_INV}`,
    `Modello Smagorinsky 2D (sperimentale),${config.enableSmagorinsky ? `Attivo (Cs=${config.smagorinskyCs})` : 'Disattivato'}`,
    `Densita rho (kg/m^3),${config.densityKgM3}`,
    `Diametro Vasca D (mm),${config.tankDiameterMm}`,
    `Diametro Asta d (mm),${config.stirrerDiameterMm}`,
    `Stato Convergenza Solutore,${metrics.diagnostics.convergenceStatus}`,
    `Divergenza RMS Normalizzata,${metrics.diagnostics.divRms.toExponential(4)}`,
    `Divergenza Max Normalizzata,${metrics.diagnostics.divMax.toExponential(4)}`,
    '',
    'Curva Reologica Teorica Regolarizzata',
    'Tasso di Taglio (1/s),Sforzo di Taglio (Pa),Viscosita Apparente Fisica (mPa*s)',
  ];

  for (let i = 0; i <= 20; i++) {
    const gamma = Math.pow(10, -1 + (i / 20) * 4);
    const tau = computeApparentViscosityPaS(gamma, config) * gamma;
    const muMpas = computeApparentViscosityPaS(gamma, config) * 1000;
    lines.push(`${gamma.toFixed(4)},${tau.toFixed(6)},${muMpas.toFixed(4)}`);
  }

  lines.push('');
  lines.push('Serie Temporale Vasca');
  lines.push('Tempo Simulato (s),Indice Miscelazione Danckwerts (%),Energia Cinetica Specifica (mJ/kg)');
  history.forEach((pt) => {
    lines.push(`${pt.timeSec.toFixed(3)},${pt.mixingIndex.toFixed(2)},${pt.kineticEnergyMjKg.toFixed(4)}`);
  });

  return lines.join('\n');
}
