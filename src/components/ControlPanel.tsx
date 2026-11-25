import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  clampBaseViscosityMpas,
  findNearestFluidPreset,
  FLUID_PRESETS,
  formatViscosityDisplay,
  getViscosityColorHex,
  MAX_VISCOSITY_MPAS,
  MIN_LOG_VISCOSITY,
  MIN_VISCOSITY_MPAS,
} from '../constants/fluids';
import { FluidConfig, FluidPreset, QualityLevel } from '../types/rheology';
import InfoTooltip from './InfoTooltip';

type FluidBehaviorId = 'constant' | 'shear-thinning' | 'shear-thickening' | 'yield-plastic';

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
      'La viscosità fisica resta costante con lo shear. Sceglilo per liquidi puri, solventi, oli e miele.',
  },
  {
    id: 'shear-thinning',
    label: 'Fluidifica agitando',
    hint: 'Vernici, sangue, gel',
    techLabel: 'Power-Law (n < 1)',
    description:
      'Da fermo ha viscosità apparente elevata, ma scende sotto sforzo di taglio. Tipico di vernici, polimeri e gel.',
  },
  {
    id: 'shear-thickening',
    label: 'Addensa agitando',
    hint: 'Amido, miscele dense',
    techLabel: 'Power-Law (n > 1)',
    description:
      'Scorre bene a bassa velocità, ma la viscosità apparente cresce con il tasso di taglio.',
  },
  {
    id: 'yield-plastic',
    label: 'Pasta con soglia',
    hint: 'Ketchup, creme, stucco',
    techLabel: 'Herschel-Bulkley (τy > 0)',
    description:
      'Comportamento viscoplastico regolarizzato Papanastasiou: scorre pienamente solo dove τ supera τy.',
  },
];

function getActiveBehavior(config: FluidConfig): FluidBehaviorId {
  if (config.model === 'newtonian') return 'constant';
  if (config.model === 'herschel-bulkley') return 'yield-plastic';
  return config.flowIndex > 1 ? 'shear-thickening' : 'shear-thinning';
}

const QUICK_VISCOSITY_STOPS: Array<{ label: string; value: number }> = [
  { label: '0.01', value: MIN_VISCOSITY_MPAS },
  { label: '1', value: 1 },
  { label: '100', value: 100 },
  { label: '1.4k', value: 1412 },
  { label: '10k', value: 10000 },
  { label: '50k', value: 50000 },
  { label: '500k', value: 500000 },
];

const QUALITY_OPTIONS: Array<{ id: QualityLevel; label: string }> = [
  { id: 'low', label: '64×64 (Leggera)' },
  { id: 'standard', label: '96×96 (Standard)' },
  { id: 'high', label: '128×128 (Alta)' },
];

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

interface ControlPanelProps {
  config: FluidConfig;
  viscosityInput: string;
  onViscosityInputChange: (text: string) => void;
  onConfigChange: React.Dispatch<React.SetStateAction<FluidConfig>>;
  onApplyPreset: (preset: FluidPreset) => void;
}

const ControlPanel: React.FC<ControlPanelProps> = ({
  config,
  viscosityInput,
  onViscosityInputChange,
  onConfigChange,
  onApplyPreset,
}) => {
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);

  const nearestPreset = useMemo(
    () => findNearestFluidPreset(config.viscosityMpas),
    [config.viscosityMpas]
  );

  const sliderPos = useMemo(() => {
    const minLog = Math.log10(MIN_LOG_VISCOSITY);
    const maxLog = Math.log10(MAX_VISCOSITY_MPAS);
    const clamped = clampBaseViscosityMpas(config.viscosityMpas);
    return ((Math.log10(clamped) - minLog) / (maxLog - minLog)) * 100;
  }, [config.viscosityMpas]);

  const applyCustomViscosity = (rawVal: number) => {
    const clamped = Number.isFinite(rawVal)
      ? clampBaseViscosityMpas(rawVal)
      : MIN_VISCOSITY_MPAS;
    const formatted =
      clamped < 1
        ? clamped.toFixed(2)
        : clamped < 10
        ? String(Number(clamped.toFixed(2)))
        : String(Math.round(clamped * 100) / 100);
    onViscosityInputChange(formatted);
    onConfigChange((prev) => ({
      ...prev,
      presetId: null,
      name: 'Fluido Personalizzato',
      viscosityMpas: clamped,
      color: getViscosityColorHex(clamped),
    }));
  };

  const handleViscosityTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    onViscosityInputChange(raw);
    if (raw === '' || raw === '.') return;
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= MIN_VISCOSITY_MPAS) {
      const clamped = clampBaseViscosityMpas(parsed);
      onConfigChange((prev) => ({
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
    const minLog = Math.log10(MIN_LOG_VISCOSITY);
    const maxLog = Math.log10(MAX_VISCOSITY_MPAS);
    const val = Math.pow(10, minLog + (pct / 100) * (maxLog - minLog));
    const rounded =
      val < 1 ? Number(val.toFixed(2)) : val < 10 ? Number(val.toFixed(1)) : Math.round(val);
    applyCustomViscosity(rounded);
  };

  const handleBehaviorChange = (behavior: FluidBehaviorId) => {
    onConfigChange((prev) => {
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
      const autoYield = Math.min(
        250,
        Math.max(12, Math.round(Math.pow(Math.max(10, prev.viscosityMpas), 0.36)))
      );
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

  return (
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
            Inserisci viscosità personalizzata in mPa·s (0.01 - 500000)
          </label>
          <div className="relative flex items-center">
            <input
              id="viscosity-custom-input"
              type="number"
              min={MIN_VISCOSITY_MPAS}
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
          <p className="mt-1.5 text-[11px] text-slate-400">
            Intervallo configurabile: {MIN_VISCOSITY_MPAS} – 500.000 mPa·s (dominio fisico continuo viscoso).
          </p>
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
            <span>0.01</span>
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
                description="Costante (Newtoniano), Fluidifica agitando (Power-Law n<1), Addensa agitando (Power-Law n>1), Pasta con soglia (Herschel-Bulkley regolarizzato Papanastasiou)."
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
              if (found) onApplyPreset(found);
            }}
            className="w-full bg-[#07090E] border border-slate-700 focus:border-cyan-400 focus:outline-none rounded-lg px-3 py-2.5 text-sm text-slate-100 min-h-[42px]"
          >
            <option value="custom">
              Personalizzato ({formatViscosityDisplay(config.viscosityMpas)} mPa·s)
            </option>
            {FLUID_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({formatViscosityDisplay(p.viscosityMpas)} mPa·s)
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 leading-relaxed">
            {config.presetId
              ? nearestPreset.description
              : 'Configurazione personalizzata attiva. Modifica liberamente parametri reologici, geometria o risoluzione griglia.'}
          </p>
        </div>

        <div className="pt-2 border-t border-slate-800/80">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="w-full flex items-center justify-between py-2 text-xs font-semibold text-slate-200 hover:text-cyan-300 transition-colors min-h-[40px]"
          >
            <span>Parametri Reologici, Geometria e Opzioni CFD</span>
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
                      description="n = 1 costante (Newtoniano); n < 1 pseudoplastico; n > 1 dilatante."
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
                      onConfigChange((prev) => ({
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
                      description="Soglia di sforzo sotto la quale il fluido viscoplastico resta in stato di plug quasi-rigido."
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
                      onConfigChange((prev) => ({
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
                    htmlFor="input-papanastasiou"
                    className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                  >
                    <span>Esponente m (s)</span>
                    <InfoTooltip
                      title="Parametro Papanastasiou m (s)"
                      description="Controlla la rapidità della transizione regolarizzata τ = τy·(1 - exp(-m·γ̇)) + K·γ̇^n. Valori più alti avvicinano il modello plastico ideale."
                    />
                  </label>
                  <BufferedNumberInput
                    id="input-papanastasiou"
                    min={0.5}
                    max={20}
                    step={0.5}
                    disabled={config.model !== 'herschel-bulkley'}
                    value={config.papanastasiouM}
                    onCommit={(val) =>
                      onConfigChange((prev) => ({
                        ...prev,
                        presetId: null,
                        name: 'Fluido Personalizzato',
                        papanastasiouM: val,
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
                      description="Massa del fluido per unità di volume (acqua ≈ 1000 kg/m³)."
                    />
                  </label>
                  <BufferedNumberInput
                    id="input-density"
                    min={500}
                    max={2500}
                    step={10}
                    value={config.densityKgM3}
                    onCommit={(val) =>
                      onConfigChange((prev) => ({
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
                    htmlFor="input-tank-diameter"
                    className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                  >
                    <span>Diametro Vasca D (mm)</span>
                  </label>
                  <BufferedNumberInput
                    id="input-tank-diameter"
                    min={50}
                    max={600}
                    step={10}
                    value={config.tankDiameterMm}
                    onCommit={(val) =>
                      onConfigChange((prev) => ({ ...prev, tankDiameterMm: val }))
                    }
                    className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-sm font-mono tabular-nums text-slate-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="input-stirrer-diameter"
                    className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                  >
                    <span>Diametro Asta d (mm)</span>
                  </label>
                  <BufferedNumberInput
                    id="input-stirrer-diameter"
                    min={6}
                    max={80}
                    step={2}
                    value={config.stirrerDiameterMm}
                    onCommit={(val) =>
                      onConfigChange((prev) => ({ ...prev, stirrerDiameterMm: val }))
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
                      onConfigChange((prev) => ({
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
                    htmlFor="select-grid-quality"
                    className="flex items-center gap-1 text-[11px] text-slate-400 mb-1"
                  >
                    <span>Griglia CFD</span>
                    <InfoTooltip
                      title="Risoluzione Griglia Numerica"
                      description="Seleziona il numero di celle N×N del solutore senza modificare alcun parametro fisico del fluido."
                    />
                  </label>
                  <select
                    id="select-grid-quality"
                    value={config.quality}
                    onChange={(e) =>
                      onConfigChange((prev) => ({
                        ...prev,
                        quality: e.target.value as QualityLevel,
                      }))
                    }
                    className="w-full h-[38px] bg-[#07090E] border border-slate-700 rounded px-2.5 text-xs text-slate-100"
                  >
                    {QUALITY_OPTIONS.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800/80 space-y-2.5">
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={config.enableSmagorinsky}
                    onChange={(e) =>
                      onConfigChange((prev) => ({
                        ...prev,
                        enableSmagorinsky: e.target.checked,
                      }))
                    }
                    className="mt-0.5 rounded border-slate-700 bg-[#07090E] text-cyan-400 focus:ring-cyan-500"
                  />
                  <span className="text-xs text-slate-300 leading-snug">
                    <span className="font-medium text-slate-200 inline-flex items-center gap-1">
                      Dissipazione sottogriglia Smagorinsky 2D (sperimentale)
                      <InfoTooltip
                        title="Limiti Modello Smagorinsky 2D"
                        description="Aggiunge una viscosità numerica locale μ_sgs = ρ·(Cs·h)²·γ̇ ai soli fini di stabilizzazione su gradienti sottili. Non modella la cascata turbolenta 3D e resta disattivato di default."
                      />
                    </span>
                    <span className="block text-[11px] text-slate-400 mt-0.5">
                      Opzionale; mantenuto separato da μ_app fisica.
                    </span>
                  </span>
                </label>

                {config.enableSmagorinsky && (
                  <div className="pl-6">
                    <label
                      htmlFor="input-smagorinsky-cs"
                      className="block text-[11px] text-slate-400 mb-1"
                    >
                      Costante numerica Cs (0.05 – 0.30)
                    </label>
                    <BufferedNumberInput
                      id="input-smagorinsky-cs"
                      min={0.05}
                      max={0.3}
                      step={0.01}
                      value={config.smagorinskyCs}
                      onCommit={(val) =>
                        onConfigChange((prev) => ({ ...prev, smagorinskyCs: val }))
                      }
                      className="w-32 bg-[#07090E] border border-slate-700 rounded px-3 py-1.5 text-xs font-mono tabular-nums text-slate-100"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default ControlPanel;
