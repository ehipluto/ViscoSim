import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';
import FluidViewport from './components/FluidViewport';
import InfoTooltip from './components/InfoTooltip';
import MixingChart from './components/MixingChart';
import RheologyChart from './components/RheologyChart';
import {
  computeApparentViscosityPaS,
  computeShearStressPa,
  DEFAULT_FLUID_CONFIG,
  findNearestFluidPreset,
  FLUID_PRESETS,
  formatViscosityDisplay,
  getViscosityColorHex,
  MAX_VISCOSITY_MPAS,
  MIN_LOG_VISCOSITY,
} from './constants/fluids';
import {
  FluidConfig,
  FluidPreset,
  RheologyModel,
  SimulationMetrics,
  TimeSeriesPoint,
  VisualizationMode,
} from './types/rheology';

type FluidBehaviorId = 'constant' | 'shear-thinning' | 'shear-thickening' | 'yield-plastic';

const MODEL_LABELS: Record<RheologyModel, string> = {
  newtonian: 'Newtoniano',
  'power-law': 'Power-Law',
  'herschel-bulkley': 'Herschel-Bulkley',
};

const BEHAVIOR_OPTIONS: Array<{
  id: FluidBehaviorId;
  label: string;
  hint: string;
  techLabel: string;
  description: string;
}> = [
  {
    id: 'constant',
    label: 'Costante',
    hint: 'Acqua, oli, miele',
    techLabel: 'Newtoniano (n = 1)',
    description:
      'La viscosità non cambia mai, sia che mescoli piano sia forte. Sceglilo per liquidi puri, solventi, oli e miele.',
  },
  {
    id: 'shear-thinning',
    label: 'Fluidifica agitando',
    hint: 'Vernici, sangue, gel',
    techLabel: 'Power-Law (n < 1)',
    description:
      'Da fermo è più denso, ma diventa subito più leggero e scorrevole mentre lo mescoli. Tipico di vernici, polimeri e gel.',
  },
  {
    id: 'shear-thickening',
    label: 'Addensa agitando',
    hint: 'Amido, miscele dense',
    techLabel: 'Power-Law (n > 1)',
    description:
      'Scorre bene se mosso piano, ma oppone una resistenza molto maggiore se mescoli con forza o velocità.',
  },
  {
    id: 'yield-plastic',
    label: 'Pasta con soglia',
    hint: 'Ketchup, creme, stucco',
    techLabel: 'Herschel-Bulkley (τy > 0)',
    description:
      'Da fermo resta compatto come un solido e scorre solo dove applichi abbastanza forza da superare la soglia τy.',
  },
];

function getActiveBehavior(config: FluidConfig): FluidBehaviorId {
  if (config.model === 'newtonian') return 'constant';
  if (config.model === 'herschel-bulkley') return 'yield-plastic';
  return config.flowIndex > 1 ? 'shear-thickening' : 'shear-thinning';
}

const QUICK_VISCOSITY_STOPS: Array<{ label: string; value: number }> = [
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: '100', value: 100 },
  { label: '1.4k', value: 1412 },
  { label: '10k', value: 10000 },
  { label: '50k', value: 50000 },
  { label: '500k', value: 500000 },
];

const REGIME_STYLES: Record<
  SimulationMetrics['regime'],
  { glyph: string; className: string }
> = {
  'Stokes / Creeping': { glyph: '●', className: 'text-sky-400' },
  Laminare: { glyph: '●', className: 'text-emerald-400' },
  Transizione: { glyph: '▲', className: 'text-amber-400' },
  Turbolento: { glyph: '■', className: 'text-rose-400' },
};

const INITIAL_METRICS: SimulationMetrics = {
  elapsedSec: 0,
  reynolds: 0,
  regime: 'Laminare',
  maxSpeedMs: 0,
  meanShearRate: 0,
  maxShearRate: 0,
  maxShearStressPa: 0,
  effectiveViscosityMpas: DEFAULT_FLUID_CONFIG.viscosityMpas,
  mixingIndex: 0,
  kineticEnergyMjKg: 0,
  scaleRange: {
    min: 0,
    mid: 50,
    max: 100,
    unit: '',
    label: 'Moto del Fluido',
  },
};

interface BufferedNumberInputProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onCommit: (nextValue: number) => void;
  className?: string;
}

const BufferedNumberInput: React.FC<BufferedNumberInputProps> = ({
  id,
  value,
  min,
  max,
  step,
  disabled = false,
  onCommit,
  className = '',
}) => {
  const [draft, setDraft] = useState<string>(String(value));
  const [focused, setFocused] = useState<boolean>(false);

  useEffect(() => {
    if (!focused) {
      setDraft(String(value));
    }
  }, [value, focused]);

  const commitDraft = (raw: string) => {
    const parsed = parseFloat(raw);
    const next = Number.isFinite(parsed)
      ? Math.max(min, Math.min(max, parsed))
      : value;
    setDraft(String(next));
    if (next !== value) {
      onCommit(next);
    }
  };

  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw === '' || raw === '-' || raw === '.') return;
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
          onCommit(parsed);
        }
      }}
      onBlur={() => {
        setFocused(false);
        commitDraft(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
};

export default function App() {
  const [config, setConfig] = useState<FluidConfig>(DEFAULT_FLUID_CONFIG);
  const [viscosityInput, setViscosityInput] = useState<string>(
    String(DEFAULT_FLUID_CONFIG.viscosityMpas)
  );
  const [mode, setMode] = useState<VisualizationMode>('fluid');
  const [showVectors, setShowVectors] = useState<boolean>(false);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<SimulationMetrics>(INITIAL_METRICS);
  const [history, setHistory] = useState<TimeSeriesPoint[]>([]);

  const lastSampleTimeRef = useRef<number>(-1);

  const handleResetComplete = useCallback(() => {
    lastSampleTimeRef.current = -1;
    setHistory([]);
    setMetrics(INITIAL_METRICS);
  }, []);

  const handleMetricsUpdate = useCallback((next: SimulationMetrics) => {
    setMetrics(next);
    if (next.elapsedSec - lastSampleTimeRef.current >= 0.4) {
      lastSampleTimeRef.current = next.elapsedSec;
      setHistory((prev) => {
        const point: TimeSeriesPoint = {
          timeSec: next.elapsedSec,
          mixingIndex: next.mixingIndex,
          kineticEnergyMjKg: next.kineticEnergyMjKg,
        };
        const updated = [...prev, point];
        return updated.length > 150 ? updated.slice(updated.length - 150) : updated;
      });
    }
  }, []);

  const nearestPreset = useMemo(
    () => findNearestFluidPreset(config.viscosityMpas),
    [config.viscosityMpas]
  );

  const sliderPos = useMemo(() => {
    if (config.viscosityMpas <= 0) return 0;
    const minLog = Math.log10(MIN_LOG_VISCOSITY);
    const maxLog = Math.log10(MAX_VISCOSITY_MPAS);
    const clamped = Math.max(MIN_LOG_VISCOSITY, Math.min(MAX_VISCOSITY_MPAS, config.viscosityMpas));
    return ((Math.log10(clamped) - minLog) / (maxLog - minLog)) * 100;
  }, [config.viscosityMpas]);

  const applyCustomViscosity = (rawVal: number, textVal?: string) => {
    const clamped = Number.isFinite(rawVal)
      ? Math.max(0, Math.min(MAX_VISCOSITY_MPAS, rawVal))
      : 0;
    if (textVal !== undefined) {
      setViscosityInput(textVal);
    } else {
      setViscosityInput(
        clamped === 0 ? '0' : clamped < 1 ? clamped.toFixed(2) : String(Math.round(clamped * 100) / 100)
      );
    }
    setConfig((prev) => ({
      ...prev,
      presetId: null,
      name: 'Fluido Personalizzato',
      viscosityMpas: clamped,
      color: getViscosityColorHex(clamped),
    }));
  };

  const handleViscosityTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setViscosityInput(raw);
    if (raw === '' || raw === '.') return;
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      const clamped = Math.max(0, Math.min(MAX_VISCOSITY_MPAS, parsed));
      setConfig((prev) => ({
        ...prev,
        presetId: null,
        name: 'Fluido Personalizzato',
        viscosityMpas: clamped,
        color: getViscosityColorHex(clamped),
      }));
    }
  };

  const handleViscosityBlur = () => {
    const parsed = parseFloat(viscosityInput);
    if (!Number.isFinite(parsed)) {
      applyCustomViscosity(config.viscosityMpas);
    } else {
      applyCustomViscosity(parsed);
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pct = parseFloat(e.target.value);
    if (pct <= 0.15) {
      applyCustomViscosity(0, '0');
      return;
    }
    const minLog = Math.log10(MIN_LOG_VISCOSITY);
    const maxLog = Math.log10(MAX_VISCOSITY_MPAS);
    const val = Math.pow(10, minLog + (pct / 100) * (maxLog - minLog));
    const rounded = val < 1 ? Number(val.toFixed(2)) : val < 10 ? Number(val.toFixed(1)) : Math.round(val);
    applyCustomViscosity(rounded);
  };

  const applyPreset = (preset: FluidPreset) => {
    setViscosityInput(String(preset.viscosityMpas));
    setConfig((prev) => ({
      ...prev,
      presetId: preset.id,
      name: preset.name,
      model: preset.model,
      viscosityMpas: preset.viscosityMpas,
      flowIndex: preset.flowIndex,
      yieldStressPa: preset.yieldStressPa,
      papanastasiouM: preset.papanastasiouM,
      densityKgM3: preset.densityKgM3,
      color: preset.color,
    }));
  };

  const handleBehaviorChange = (behavior: FluidBehaviorId) => {
    setConfig((prev) => {
      const customColor = prev.presetId ? getViscosityColorHex(prev.viscosityMpas) : prev.color;
      if (behavior === 'constant') {
        return {
          ...prev,
          presetId: null,
          name: 'Fluido Personalizzato',
          model: 'newtonian',
          flowIndex: 1.0,
          yieldStressPa: 0,
          color: customColor,
        };
      }
      if (behavior === 'shear-thinning') {
        return {
          ...prev,
          presetId: null,
          name: 'Fluido Personalizzato',
          model: 'power-law',
          flowIndex: prev.flowIndex < 1 ? prev.flowIndex : 0.65,
          yieldStressPa: 0,
          color: customColor,
        };
      }
      if (behavior === 'shear-thickening') {
        return {
          ...prev,
          presetId: null,
          name: 'Fluido Personalizzato',
          model: 'power-law',
          flowIndex: prev.flowIndex > 1 ? prev.flowIndex : 1.38,
          yieldStressPa: 0,
          color: customColor,
        };
      }
      const autoYield = Math.min(250, Math.max(12, Math.round(Math.pow(Math.max(10, prev.viscosityMpas), 0.36))));
      return {
        ...prev,
        presetId: null,
        name: 'Fluido Personalizzato',
        model: 'herschel-bulkley',
        flowIndex: prev.flowIndex === 1 || prev.flowIndex > 1 ? 0.45 : prev.flowIndex,
        yieldStressPa: prev.yieldStressPa > 0 ? prev.yieldStressPa : autoYield,
        color: customColor,
      };
    });
  };

  const handleExportCsv = () => {
    const lines: string[] = [
      'ViscoSim CFD Report',
      `Fluido,${config.name}`,
      `Modello Reologico,${MODEL_LABELS[config.model]}`,
      `Viscosita / Consistenza K (mPa*s),${config.viscosityMpas}`,
      `Indice di Flusso n,${config.model === 'newtonian' ? 1 : config.flowIndex}`,
      `Sforzo di Snervamento tau_y (Pa),${config.model === 'herschel-bulkley' ? config.yieldStressPa : 0}`,
      `Densita (kg/m3),${config.densityKgM3}`,
      `Diametro Vasca (mm),${config.tankDiameterMm}`,
      `Diametro Asta (mm),${config.stirrerDiameterMm}`,
      '',
      'Curva Reologica Teorica',
      'Tasso di Taglio (1/s),Sforzo di Taglio (Pa),Viscosita Apparente (mPa*s)',
    ];

    for (let i = 0; i <= 20; i++) {
      const gamma = Math.pow(10, -1 + (i / 20) * 4);
      const tau = computeShearStressPa(gamma, config);
      const muMpas = computeApparentViscosityPaS(gamma, config) * 1000;
      lines.push(`${gamma.toFixed(4)},${tau.toFixed(6)},${muMpas.toFixed(4)}`);
    }

    lines.push('');
    lines.push('Serie Temporale Vasca');
    lines.push('Tempo (s),Indice Miscelazione (%),Energia Cinetica (mJ/kg)');
    history.forEach((pt) => {
      lines.push(`${pt.timeSec.toFixed(2)},${pt.mixingIndex.toFixed(2)},${pt.kineticEnergyMjKg.toFixed(4)}`);
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `viscosim-report-${Math.round(config.viscosityMpas)}mpas.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const regimeBadge = REGIME_STYLES[metrics.regime];

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 bg-[#07090E]/95 sticky top-0 z-30 backdrop-blur-sm">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4 sm:gap-8">
          <a
            href="#simulatore"
            className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
          >
            ViscoSim
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            <a
              href="#simulatore"
              className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              Simulatore
            </a>
            <a
              href="#reologia"
              className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              Curva Reologica
            </a>
            <a
              href="#riferimenti"
              className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              Riferimenti Fluidi
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[38px]"
            >
              <Download size={14} />
              Esporta CSV
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 space-y-8">
        <section
          id="simulatore"
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
        >
          <aside className="lg:col-span-5 xl:col-span-4 space-y-4">
            <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-5 space-y-5">
              <div className="flex items-baseline justify-between gap-2">
                <h1 className="text-base font-semibold text-slate-100">
                  Viscosità Dinamica / Consistenza
                </h1>
                <span className="inline-flex items-center gap-1.5 text-xs font-mono text-cyan-400 whitespace-nowrap">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full border border-white/25 shrink-0"
                    style={{ backgroundColor: config.color }}
                    aria-hidden="true"
                  />
                  {config.presetId ? `Preset: ${config.name}` : 'Valore personalizzato'}
                </span>
              </div>

              <div>
                <label htmlFor="viscosity-custom-input" className="sr-only">
                  Inserisci viscosità personalizzata in mPa·s
                </label>
                <div className="relative flex items-center">
                  <input
                    id="viscosity-custom-input"
                    type="number"
                    min={0}
                    max={MAX_VISCOSITY_MPAS}
                    step="any"
                    inputMode="decimal"
                    value={viscosityInput}
                    onChange={handleViscosityTextChange}
                    onBlur={handleViscosityBlur}
                    className="w-full bg-[#07090E] border border-slate-700 focus:border-cyan-400 focus:outline-none rounded-lg pl-4 pr-24 py-3 text-2xl sm:text-3xl font-mono font-semibold tabular-nums text-slate-100"
                    placeholder="1.0"
                  />
                  <span className="absolute right-4 text-xs font-mono text-slate-400 pointer-events-none">
                    mPa·s (cP)
                  </span>
                </div>
                {config.viscosityMpas === 0 && (
                  <p className="mt-1.5 text-xs text-slate-400">
                    Limite inferiore applicato al solutore: 0.01 mPa·s (regime quasi-inviscido).
                  </p>
                )}
              </div>

              <div className="space-y-2.5">
                <input
                  type="range"
                  aria-label="Scala logaritmica viscosità"
                  min={0}
                  max={100}
                  step={0.1}
                  value={sliderPos}
                  onChange={handleSliderChange}
                  className="w-full lab-slider cursor-pointer"
                />
                <div className="flex justify-between text-[11px] font-mono text-slate-400 tabular-nums">
                  <span>0</span>
                  <span>1</span>
                  <span>100</span>
                  <span>10k</span>
                  <span>500k</span>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-1">
                {QUICK_VISCOSITY_STOPS.map((stop) => {
                  const isMatch = Math.abs(config.viscosityMpas - stop.value) < 0.005;
                  return (
                    <button
                      key={stop.label}
                      type="button"
                      onClick={() => applyCustomViscosity(stop.value)}
                      className={`py-2 text-xs font-mono tabular-nums rounded border transition-colors min-h-[38px] ${
                        isMatch
                          ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                          : 'bg-[#07090E] border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      {stop.label}
                    </button>
                  );
                })}
              </div>

              <div className="pt-3 border-t border-slate-800/80 text-xs text-slate-400 flex items-center justify-between gap-2">
                <span>Riferimento più vicino</span>
                <span className="font-mono text-slate-200 tabular-nums truncate">
                  {nearestPreset.name} · {formatViscosityDisplay(nearestPreset.viscosityMpas)} mPa·s
                </span>
              </div>
            </div>

            <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-5 space-y-4">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="block text-xs font-medium text-slate-300">
                      Come si comporta il fluido?
                    </span>
                    <InfoTooltip
                      title="Come scegliere il comportamento"
                      description="Se scorre sempre uguale usa 'Costante'. Se agitando diventa più fluido (vernici, gel) usa 'Fluidifica agitando'. Se agitando si indurisce usa 'Addensa agitando'. Se da fermo resta come crema o pasta usa 'Pasta con soglia'."
                    />
                  </div>
                  <span className="text-[11px] font-mono text-slate-400">
                    {BEHAVIOR_OPTIONS.find((b) => b.id === getActiveBehavior(config))?.techLabel}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  {BEHAVIOR_OPTIONS.map((opt) => {
                    const active = getActiveBehavior(config) === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleBehaviorChange(opt.id)}
                        className={`px-3 py-2.5 text-left rounded-lg border transition-colors min-h-[54px] ${
                          active
                            ? 'bg-cyan-500/15 border-cyan-500/50 text-slate-100'
                            : 'bg-[#07090E] border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className={`text-xs font-semibold ${active ? 'text-cyan-300' : 'text-slate-200'}`}>
                          {opt.label}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                          {opt.hint}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  {BEHAVIOR_OPTIONS.find((b) => b.id === getActiveBehavior(config))?.description}
                </p>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="preset-fluid-select"
                  className="block text-xs font-medium text-slate-300"
                >
                  Carica Fluido di Riferimento (Modificabile)
                </label>
                <select
                  id="preset-fluid-select"
                  value={config.presetId ?? 'custom'}
                  onChange={(e) => {
                    const found = FLUID_PRESETS.find((p) => p.id === e.target.value);
                    if (found) applyPreset(found);
                  }}
                  className="w-full bg-[#07090E] border border-slate-700 focus:border-cyan-400 focus:outline-none rounded-lg px-3 py-2.5 text-sm text-slate-100 min-h-[42px]"
                >
                  <option value="custom">Personalizzato ({formatViscosityDisplay(config.viscosityMpas)} mPa·s)</option>
                  {FLUID_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({formatViscosityDisplay(p.viscosityMpas)} mPa·s)
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {config.presetId
                    ? nearestPreset.description
                    : 'Configurazione personalizzata attiva. Modifica liberamente viscosità, indice n, snervamento o geometria.'}
                </p>
              </div>

              <div className="pt-2 border-t border-slate-800/80">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  aria-expanded={advancedOpen}
                  className="w-full flex items-center justify-between py-2 text-xs font-semibold text-slate-200 hover:text-cyan-300 transition-colors min-h-[40px]"
                >
                  <span>Parametri Reologici e Geometria Vasca</span>
                  {advancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {advancedOpen && (
                  <div className="pt-3 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor="input-flow-index"
                          className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                        >
                          <span>Indice di flusso n</span>
                          <InfoTooltip
                            title="Indice di flusso (n)"
                            description="Indica come cambia la viscosità mescolando: n = 1 costante (Newtoniano); n < 1 il fluido si fluidifica sotto sforzo (es. ketchup); n > 1 si addensa (es. amido)."
                          />
                        </label>
                        <BufferedNumberInput
                          id="input-flow-index"
                          min={0.15}
                          max={1.8}
                          step={0.05}
                          disabled={config.model === 'newtonian'}
                          value={config.model === 'newtonian' ? 1 : config.flowIndex}
                          onCommit={(val) =>
                            setConfig((prev) => ({
                              ...prev,
                              presetId: null,
                              name: 'Fluido Personalizzato',
                              flowIndex: val,
                              color: prev.presetId ? getViscosityColorHex(prev.viscosityMpas) : prev.color,
                            }))
                          }
                          className="w-full bg-[#07090E] border border-slate-700 disabled:opacity-45 rounded px-3 py-2 text-sm font-mono tabular-nums text-slate-100"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="input-yield-stress"
                          className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                        >
                          <span>Snervamento τy (Pa)</span>
                          <InfoTooltip
                            title="Sforzo di snervamento (τy)"
                            description="È la spinta minima per rompere la struttura interna del fluido e farlo scorrere. Sotto questo valore (lontano dall’asta) il materiale resta immobile come un solido."
                          />
                        </label>
                        <BufferedNumberInput
                          id="input-yield-stress"
                          min={0}
                          max={500}
                          step={1}
                          disabled={config.model !== 'herschel-bulkley'}
                          value={config.model === 'herschel-bulkley' ? config.yieldStressPa : 0}
                          onCommit={(val) =>
                            setConfig((prev) => ({
                              ...prev,
                              presetId: null,
                              name: 'Fluido Personalizzato',
                              yieldStressPa: val,
                              color: prev.presetId ? getViscosityColorHex(prev.viscosityMpas) : prev.color,
                            }))
                          }
                          className="w-full bg-[#07090E] border border-slate-700 disabled:opacity-45 rounded px-3 py-2 text-sm font-mono tabular-nums text-slate-100"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="input-density"
                          className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                        >
                          <span>Densità ρ (kg/m³)</span>
                          <InfoTooltip
                            title="Densità (ρ)"
                            description="Massa del fluido per unità di volume (acqua ≈ 1000). Più alta è la densità, maggiore è l’inerzia del liquido: i vortici persistono di più e sale il numero di Reynolds."
                          />
                        </label>
                        <BufferedNumberInput
                          id="input-density"
                          min={500}
                          max={2500}
                          step={10}
                          value={config.densityKgM3}
                          onCommit={(val) =>
                            setConfig((prev) => ({
                              ...prev,
                              presetId: null,
                              name: 'Fluido Personalizzato',
                              densityKgM3: val,
                              color: prev.presetId ? getViscosityColorHex(prev.viscosityMpas) : prev.color,
                            }))
                          }
                          className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-sm font-mono tabular-nums text-slate-100"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="input-fluid-color"
                          className="block text-[11px] text-slate-400 mb-1"
                        >
                          Colore Fluido
                        </label>
                        <input
                          id="input-fluid-color"
                          type="color"
                          value={config.color}
                          onChange={(e) =>
                            setConfig((prev) => ({
                              ...prev,
                              presetId: null,
                              name: 'Fluido Personalizzato',
                              color: e.target.value,
                            }))
                          }
                          className="w-full h-[38px] bg-[#07090E] border border-slate-700 rounded px-1 py-1 cursor-pointer"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="input-tank-diameter"
                          className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                        >
                          <span>Diametro Vasca D</span>
                          <InfoTooltip
                            title="Diametro Vasca D (mm)"
                            description="Larghezza interna del recipiente. Una vasca più grande aumenta la distanza dalle pareti, lasciando più spazio al flusso ma richiedendo più movimento per omogeneizzare i bordi."
                          />
                        </label>
                        <BufferedNumberInput
                          id="input-tank-diameter"
                          min={50}
                          max={600}
                          step={10}
                          value={config.tankDiameterMm}
                          onCommit={(val) =>
                            setConfig((prev) => ({ ...prev, tankDiameterMm: val }))
                          }
                          className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-sm font-mono tabular-nums text-slate-100"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="input-stirrer-diameter"
                          className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                        >
                          <span>Diametro Asta d</span>
                          <InfoTooltip
                            title="Diametro Asta d (mm)"
                            description="Spessore dell’agitatore manuale. Un’asta più larga sposta una massa maggiore di fluido ad ogni passata, allarga la scia e aumenta il numero di Reynolds."
                          />
                        </label>
                        <BufferedNumberInput
                          id="input-stirrer-diameter"
                          min={6}
                          max={80}
                          step={2}
                          value={config.stirrerDiameterMm}
                          onCommit={(val) =>
                            setConfig((prev) => ({ ...prev, stirrerDiameterMm: val }))
                          }
                          className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-sm font-mono tabular-nums text-slate-100"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </aside>

          <div className="lg:col-span-7 xl:col-span-8 space-y-4">
            <FluidViewport
              config={config}
              mode={mode}
              onModeChange={setMode}
              showVectors={showVectors}
              onToggleVectors={() => setShowVectors((v) => !v)}
              onMetricsUpdate={handleMetricsUpdate}
              onResetComplete={handleResetComplete}
            />

            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
              <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-3.5">
                <div className="text-[11px] text-slate-400 flex items-center justify-between gap-1">
                  <span>Num. Reynolds</span>
                  <InfoTooltip
                    title="Numero di Reynolds (Re)"
                    description="Rapporto tra inerzia del moto e attrito viscoso. Valori bassi indicano flusso ordinato e lento; valori alti (>2300) indicano transizione verso vortici e turbolenza."
                  />
                </div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
                  {metrics.reynolds >= 100
                    ? Math.round(metrics.reynolds).toLocaleString('it-IT')
                    : metrics.reynolds.toFixed(2)}
                </div>
                <div className={`mt-1 text-[11px] font-medium ${regimeBadge.className}`}>
                  {regimeBadge.glyph} {metrics.regime}
                </div>
              </div>

              <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-3.5">
                <div className="text-[11px] text-slate-400 flex items-center justify-between gap-1">
                  <span>Visc. Apparente Media</span>
                  <InfoTooltip
                    title="Viscosità Apparente Media"
                    description="Resistenza effettiva media opposta dal fluido in vasca in questo istante. Nei fluidi non-Newtoniani varia in tempo reale mentre mescoli."
                  />
                </div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
                  {formatViscosityDisplay(metrics.effectiveViscosityMpas)}
                </div>
                <div className="mt-1 text-[11px] font-mono text-slate-400">mPa·s</div>
              </div>

              <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-3.5">
                <div className="text-[11px] text-slate-400 flex items-center justify-between gap-1">
                  <span>Velocità Picco</span>
                  <InfoTooltip
                    title="Velocità Picco (m/s)"
                    description="Velocità lineare massima raggiunta dal fluido all’interno del recipiente nell’istante corrente."
                  />
                </div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-cyan-400">
                  {metrics.maxSpeedMs.toFixed(2)}
                </div>
                <div className="mt-1 text-[11px] font-mono text-slate-400">m/s</div>
              </div>

              <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-3.5">
                <div className="text-[11px] text-slate-400 flex items-center justify-between gap-1">
                  <span>Taglio Picco γ̇</span>
                  <InfoTooltip
                    title="Tasso di Taglio Picco (γ̇)"
                    description="Intensità massima con cui gli strati adiacenti di fluido scorrono l’uno sull’altro attorno all’asta (in s⁻¹)."
                  />
                </div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
                  {metrics.maxShearRate.toFixed(1)}
                </div>
                <div className="mt-1 text-[11px] font-mono text-slate-400">s⁻¹</div>
              </div>

              <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-3.5">
                <div className="text-[11px] text-slate-400 flex items-center justify-between gap-1">
                  <span>Sforzo Picco τ</span>
                  <InfoTooltip
                    title="Sforzo di Taglio Picco (τ)"
                    description="Pressione tangenziale massima (in Pascal) necessaria per deformare e trascinare il fluido vicino all’agitatore."
                  />
                </div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-amber-400">
                  {metrics.maxShearStressPa >= 100
                    ? Math.round(metrics.maxShearStressPa).toLocaleString('it-IT')
                    : metrics.maxShearStressPa.toFixed(2)}
                </div>
                <div className="mt-1 text-[11px] font-mono text-slate-400">Pa</div>
              </div>

              <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-3.5">
                <div className="text-[11px] text-slate-400 flex items-center justify-between gap-1">
                  <span>Omogeneità M(t)</span>
                  <InfoTooltip
                    title="Indice di Omogeneità M(t)"
                    description="Misura quanto il fluido si è mescolato nello spazio (indice di Danckwerts): 0% indica fluido fermo non mescolato, 100% indica miscelazione completa."
                  />
                </div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-emerald-400">
                  {metrics.mixingIndex.toFixed(1)}
                </div>
                <div className="mt-1 text-[11px] font-mono text-slate-400">% Danckwerts</div>
              </div>
            </div>
          </div>
        </section>

        <section id="reologia" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <RheologyChart config={config} operatingShearRate={metrics.meanShearRate} />
          <MixingChart history={history} />
        </section>

        <section id="riferimenti" className="bg-[#0F141D] border border-slate-800 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Tabella Comparativa Fluidi Industriali
              </h2>
              <p className="text-xs text-slate-400">
                Seleziona una riga per caricare i parametri reologici calibrati come punto di partenza modificabile.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 pr-4 font-medium">Fluido</th>
                  <th className="py-2.5 px-3 font-medium">Classe Reologica</th>
                  <th className="py-2.5 px-3 font-medium text-right">K / μ (mPa·s)</th>
                  <th className="py-2.5 px-3 font-medium text-right">Indice n</th>
                  <th className="py-2.5 px-3 font-medium text-right">τy (Pa)</th>
                  <th className="py-2.5 pl-3 font-medium text-right">ρ (kg/m³)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                {FLUID_PRESETS.map((preset) => {
                  const selected = config.presetId === preset.id;
                  return (
                    <tr
                      key={preset.id}
                      onClick={() => applyPreset(preset)}
                      className={`cursor-pointer transition-colors ${
                        selected ? 'bg-cyan-500/10 text-cyan-200' : 'hover:bg-slate-800/40 text-slate-200'
                      }`}
                    >
                      <td className="py-2.5 pr-4 font-sans font-medium whitespace-nowrap">
                        {preset.name}
                      </td>
                      <td className="py-2.5 px-3 font-sans text-slate-400 whitespace-nowrap">
                        {MODEL_LABELS[preset.model]} · {preset.category}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {formatViscosityDisplay(preset.viscosityMpas)}
                      </td>
                      <td className="py-2.5 px-3 text-right">{preset.flowIndex.toFixed(2)}</td>
                      <td className="py-2.5 px-3 text-right">{preset.yieldStressPa}</td>
                      <td className="py-2.5 pl-3 text-right">{preset.densityKgM3}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
