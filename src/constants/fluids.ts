import { FluidConfig, FluidPreset } from '../types/rheology';

export const MIN_LOG_VISCOSITY = 0.01;
export const MAX_VISCOSITY_MPAS = 500000;
export const MAX_NEWTONIAN_VISCOSITY_MPAS = 5000000;

export const FLUID_PRESETS: FluidPreset[] = [
  {
    id: 'acetone',
    name: 'Acetone',
    category: 'Solvente Newtoniano',
    model: 'newtonian',
    viscosityMpas: 0.32,
    flowIndex: 1.0,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 784,
    color: '#38bdf8',
    description: 'Solvente organico a bassissima viscosità a 20 °C. Rapida transizione turbolenta anche a basse velocità.'
  },
  {
    id: 'water',
    name: 'Acqua Distillata',
    category: 'Riferimento Newtoniano',
    model: 'newtonian',
    viscosityMpas: 1.0,
    flowIndex: 1.0,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 998,
    color: '#06b6d4',
    description: 'Fluido Newtoniano di riferimento a 20 °C. I vortici persistono a lungo prima della dissipazione viscosa.'
  },
  {
    id: 'milk',
    name: 'Latte Intero',
    category: 'Sospensione Colloidale',
    model: 'newtonian',
    viscosityMpas: 3.0,
    flowIndex: 1.0,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 1030,
    color: '#e2e8f0',
    description: 'Emulsione grasso-proteica a comportamento pressoché Newtoniano a temperatura ambiente.'
  },
  {
    id: 'blood',
    name: 'Sangue Intero (37 °C)',
    category: 'Fluido Pseudoplastico',
    model: 'power-law',
    viscosityMpas: 14,
    flowIndex: 0.78,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 1060,
    color: '#ef4444',
    description: 'Fluido shear-thinning (n = 0.78): la viscosità apparente diminuisce nelle zone ad alto gradiente di taglio.'
  },
  {
    id: 'olive-oil',
    name: 'Olio di Oliva',
    category: 'Olio Vegetale Newtoniano',
    model: 'newtonian',
    viscosityMpas: 84,
    flowIndex: 1.0,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 915,
    color: '#84cc16',
    description: 'Viscosità moderata Newtoniana. Moto laminare regolare con rapida attenuazione dei vortici secondari.'
  },
  {
    id: 'sae30',
    name: 'Olio Motore SAE 30',
    category: 'Lubrificante Industriale',
    model: 'newtonian',
    viscosityMpas: 250,
    flowIndex: 1.0,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 880,
    color: '#f59e0b',
    description: 'Lubrificante minerale calibrato per sostenere film idrodinamici stabili sotto carico meccanico.'
  },
  {
    id: 'cornstarch',
    name: 'Sospensione Amido (Dilatante)',
    category: 'Fluido Dilatante',
    model: 'power-law',
    viscosityMpas: 450,
    flowIndex: 1.42,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 1220,
    color: '#cbd5e1',
    description: 'Fluido shear-thickening (n = 1.42): oppone resistenza crescente all’aumentare della velocità di agitazione.'
  },
  {
    id: 'glycerin',
    name: 'Glicerina Pura',
    category: 'Standard di Calibrazione',
    model: 'newtonian',
    viscosityMpas: 1412,
    flowIndex: 1.0,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 1261,
    color: '#94a3b8',
    description: 'Fluido Newtoniano altamente viscoso utilizzato come standard di taratura per viscosimetri.'
  },
  {
    id: 'honey',
    name: 'Miele d’Api',
    category: 'Soluzione Zuccherina Densa',
    model: 'newtonian',
    viscosityMpas: 10000,
    flowIndex: 1.0,
    yieldStressPa: 0,
    papanastasiouM: 1.5,
    densityKgM3: 1420,
    color: '#d97706',
    description: 'Regime laminare viscoso (Stokes): trascinamento diffuso e arresto quasi immediato al cessare dello sforzo.'
  },
  {
    id: 'ketchup',
    name: 'Ketchup Industriale',
    category: 'Plastico Pseudoplastico',
    model: 'herschel-bulkley',
    viscosityMpas: 50000,
    flowIndex: 0.34,
    yieldStressPa: 18,
    papanastasiouM: 2.0,
    densityKgM3: 1120,
    color: '#dc2626',
    description: 'Modello Herschel-Bulkley: forma una caverna fluida attorno all’agitatore mentre le zone esterne restano ferme.'
  },
  {
    id: 'peanut-butter',
    name: 'Pasta Lipidica / Burro d’Arachidi',
    category: 'Fluido Plastico Denso',
    model: 'herschel-bulkley',
    viscosityMpas: 250000,
    flowIndex: 0.42,
    yieldStressPa: 140,
    papanastasiouM: 2.5,
    densityKgM3: 1090,
    color: '#b45309',
    description: 'Elevato sforzo di snervamento (τy = 140 Pa) con forte deformazione localizzata e zone morte periferiche.'
  },
  {
    id: 'cement-slurry',
    name: 'Stucco / Malta Cementizia',
    category: 'Pasta Tissotropica Estrema',
    model: 'herschel-bulkley',
    viscosityMpas: 500000,
    flowIndex: 0.55,
    yieldStressPa: 320,
    papanastasiouM: 2.5,
    densityKgM3: 1950,
    color: '#78716c',
    description: 'Sospensione minerale ad altissima consistenza e snervamento. Richiede elevato taglio locale per fluire.'
  }
];

export const DEFAULT_FLUID_CONFIG: FluidConfig = {
  presetId: 'water',
  name: 'Acqua Distillata',
  model: 'newtonian',
  viscosityMpas: 1.0,
  flowIndex: 1.0,
  yieldStressPa: 0,
  papanastasiouM: 1.5,
  densityKgM3: 998,
  tankDiameterMm: 200,
  stirrerDiameterMm: 16,
  color: '#06b6d4'
};

export function getEffectiveBaseViscosityMpas(viscosityMpas: number, model: FluidConfig['model'] = 'newtonian'): number {
  if (!Number.isFinite(viscosityMpas) || viscosityMpas <= 0) {
    return MIN_LOG_VISCOSITY;
  }
  return Math.min(getViscosityInputLimit(model), Math.max(MIN_LOG_VISCOSITY, viscosityMpas));
}

export function getViscosityInputLimit(model: FluidConfig['model']): number {
  return model === 'newtonian' ? MAX_NEWTONIAN_VISCOSITY_MPAS : MAX_VISCOSITY_MPAS;
}

export function getViscosityColorHex(viscosityMpas: number): string {
  const eff = Math.max(0.5, getEffectiveBaseViscosityMpas(viscosityMpas));
  const t = Math.max(
    0,
    Math.min(
      1,
      (Math.log10(eff) - Math.log10(0.5)) / (Math.log10(MAX_NEWTONIAN_VISCOSITY_MPAS) - Math.log10(0.5))
    )
  );

  const stops: Array<[number, number, number, number]> = [
    [0.0, 56, 189, 248],
    [0.25, 34, 211, 238],
    [0.5, 234, 179, 8],
    [0.75, 249, 115, 22],
    [1.0, 239, 68, 68],
  ];

  let s0 = stops[0];
  let s1 = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      s0 = stops[i];
      s1 = stops[i + 1];
      break;
    }
  }
  const f = (t - s0[0]) / (s1[0] - s0[0] || 1);
  const r = Math.round(s0[1] + (s1[1] - s0[1]) * f);
  const g = Math.round(s0[2] + (s1[2] - s0[2]) * f);
  const b = Math.round(s0[3] + (s1[3] - s0[3]) * f);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function computeApparentViscosityPaS(shearRate: number, config: FluidConfig): number {
  const kPaS = getEffectiveBaseViscosityMpas(config.viscosityMpas, config.model) / 1000;
  if (config.model === 'newtonian') {
    return kPaS;
  }

  const gamma = Math.max(0, shearRate);
  const n = config.flowIndex;
  const powerTerm = kPaS * Math.pow(Math.max(0.05, gamma), n - 1);

  if (config.model === 'power-law') {
    return Math.min(1200, Math.max(1e-5, powerTerm));
  }

  const tauY = Math.max(0, config.yieldStressPa);
  const m = Math.max(0.5, config.papanastasiouM);
  const yieldTerm = gamma === 0 ? tauY * m : (-tauY * Math.expm1(-m * gamma)) / gamma;
  return Math.min(1500, Math.max(1e-5, yieldTerm + powerTerm));
}

export function computeShearStressPa(shearRate: number, config: FluidConfig): number {
  const gamma = Math.max(0, shearRate);
  if (gamma === 0) {
    return 0;
  }
  return computeApparentViscosityPaS(gamma, config) * gamma;
}

export function getRheologyInputUnit(model: FluidConfig['model']): string {
  return model === 'newtonian' ? 'mPa·s' : 'mPa·sⁿ';
}

export function findNearestFluidPreset(viscosityMpas: number): FluidPreset {
  const target = getEffectiveBaseViscosityMpas(viscosityMpas);
  const targetLog = Math.log10(target);
  let best = FLUID_PRESETS[0];
  let bestDiff = Infinity;

  for (let i = 0; i < FLUID_PRESETS.length; i++) {
    if (FLUID_PRESETS[i].model !== 'newtonian') continue;
    const diff = Math.abs(Math.log10(FLUID_PRESETS[i].viscosityMpas) - targetLog);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = FLUID_PRESETS[i];
    }
  }
  return best;
}

export function formatViscosityDisplay(value: number): string {
  if (value === 0) return '0';
  if (value < 1) return value.toFixed(2);
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toLocaleString('it-IT');
}
