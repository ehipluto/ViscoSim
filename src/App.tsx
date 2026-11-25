import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, Box, ChartNoAxesCombined, Check, ChevronDown, Download, Droplet, Gauge, LibraryBig, Moon, Settings2, SlidersHorizontal, Sun, Waves, X } from 'lucide-react';
import FluidViewport from './components/FluidViewport';
import { copy, formatInput, formatReading, presetName, readPreference, savePreference, type Language } from './locale';
import { GRID_N } from './simulation/cfdEngine';
import { SIMULATION_STEP_SEC } from './simulation/simulationClock';
import InfoTooltip from './components/InfoTooltip';
import MixingChart from './components/MixingChart';
import RheologyChart from './components/RheologyChart';
import {
  computeApparentViscosityPaS,
  computeShearStressPa,
  DEFAULT_FLUID_CONFIG,
  FLUID_PRESETS,
  getViscosityColorHex,
  getRheologyInputUnit,
  getViscosityInputLimit,
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

const MODEL_LABELS = { newtonian: 'newtonian', 'power-law': 'powerLaw', 'herschel-bulkley': 'herschelBulkley' } as const satisfies Record<RheologyModel, keyof typeof copy.en>;
const BEHAVIOR_OPTIONS = [
  { id: 'constant', label: 'constant', description: 'constantHelp' },
  { id: 'shear-thinning', label: 'thinning', description: 'thinningHelp' },
  { id: 'shear-thickening', label: 'thickening', description: 'thickeningHelp' },
  { id: 'yield-plastic', label: 'yieldPlastic', description: 'yieldPlasticHelp' },
] as const;

const PRESET_TILES = ([
  { id: 'water', label: 'water' },
  { id: 'olive-oil', label: 'oil' },
  { id: 'honey', label: 'honey' },
] as const).flatMap(({ id, label }) => {
  const preset = FLUID_PRESETS.find((fluid) => fluid.id === id);
  return preset ? [{ preset, label }] : [];
});

function getActiveBehavior(config: FluidConfig): FluidBehaviorId {
  if (config.model === 'newtonian') return 'constant';
  if (config.model === 'herschel-bulkley') return 'yield-plastic';
  return config.flowIndex > 1 ? 'shear-thickening' : 'shear-thinning';
}

const INITIAL_METRICS: SimulationMetrics = {
  elapsedSec: 0,
  reynolds: 0,
  maxSpeedMs: 0,
  meanShearRate: 0,
  maxShearRate: 0,
  maxShearStressPa: 0,
  effectiveViscosityMpas: DEFAULT_FLUID_CONFIG.viscosityMpas,
  mixingIndex: 0,
  stressSolveResidual: 0,
  kineticEnergyMjKg: 0,
  scaleRange: {
    min: 0,
    mid: 50,
    max: 100,
    unit: '',
    label: '',
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
  const [language, setLanguage] = useState<Language>(() => readPreference('viscosim-language') === 'it' ? 'it' : 'en');
  const [darkMode, setDarkMode] = useState(() => readPreference('viscosim-theme') === 'dark');
  const t = copy[language];
  const [config, setConfig] = useState<FluidConfig>(DEFAULT_FLUID_CONFIG);
  const [viscosityInput, setViscosityInput] = useState<string>(
    formatInput(language, DEFAULT_FLUID_CONFIG.viscosityMpas)
  );
  const [inputError, setInputError] = useState(false);
  const [chartsOpen, setChartsOpen] = useState(false);
  const [mode, setMode] = useState<VisualizationMode>('fluid');
  const [showVectors, setShowVectors] = useState<boolean>(false);
  const libraryRef = useRef<HTMLDialogElement>(null);
  const [metrics, setMetrics] = useState<SimulationMetrics>(INITIAL_METRICS);
  const [history, setHistory] = useState<TimeSeriesPoint[]>([]);

  const lastSampleTimeRef = useRef<number>(-1);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t.pageTitle;
    document.querySelector('meta[name="description"]')?.setAttribute('content', t.pageDescription);
    savePreference('viscosim-language', language);
  }, [language, t]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    savePreference('viscosim-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const changeLanguage = (nextLanguage: Language) => {
    setLanguage(nextLanguage);
    if (!inputError) setViscosityInput(formatInput(nextLanguage, config.viscosityMpas));
  };

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
          kineticEnergyMjKg: next.kineticEnergyMjKg,
        };
        const updated = [...prev, point];
        return updated.length > 150 ? updated.slice(updated.length - 150) : updated;
      });
    }
  }, []);

  const viscosityLimit = getViscosityInputLimit(config.model);
  const sliderPos = useMemo(() => {
    const minLog = Math.log10(MIN_LOG_VISCOSITY);
    const maxLog = Math.log10(viscosityLimit);
    const clamped = Math.max(MIN_LOG_VISCOSITY, Math.min(viscosityLimit, config.viscosityMpas));
    return ((Math.log10(clamped) - minLog) / (maxLog - minLog)) * 100;
  }, [config.viscosityMpas, viscosityLimit]);

  const applyCustomViscosity = (rawVal: number) => {
    const clamped = Number.isFinite(rawVal)
      ? Math.max(MIN_LOG_VISCOSITY, Math.min(viscosityLimit, rawVal))
      : MIN_LOG_VISCOSITY;
    setInputError(false);
    setViscosityInput(formatInput(language, clamped));
    setConfig((prev) => ({
      ...prev,
      presetId: null,
      name: 'Custom fluid',
      viscosityMpas: clamped,
      color: getViscosityColorHex(clamped),
    }));
  };

  const handleViscosityTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setViscosityInput(e.target.value);
    setInputError(false);
  };

  const handleViscosityBlur = () => {
    const raw = viscosityInput.trim();
    const parsed = /^\d+(?:[.,]\d+)?$/.test(raw) ? Number(raw.replace(',', '.')) : NaN;
    if (!Number.isFinite(parsed) || parsed < MIN_LOG_VISCOSITY || parsed > viscosityLimit) {
      setInputError(true);
      return;
    }
    if (parsed !== config.viscosityMpas) applyCustomViscosity(parsed);
    else setViscosityInput(formatInput(language, parsed));
    setInputError(false);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pct = parseFloat(e.target.value);
    const minLog = Math.log10(MIN_LOG_VISCOSITY);
    const maxLog = Math.log10(viscosityLimit);
    const val = Math.pow(10, minLog + (pct / 100) * (maxLog - minLog));
    const rounded = val < 1 ? Number(val.toFixed(2)) : val < 10 ? Number(val.toFixed(1)) : Math.round(val);
    applyCustomViscosity(rounded);
  };

  const applyPreset = (preset: FluidPreset) => {
    setInputError(false);
    setViscosityInput(formatInput(language, preset.viscosityMpas));
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
    const parameter = behavior === 'constant' ? config.viscosityMpas : Math.min(config.viscosityMpas, MAX_VISCOSITY_MPAS);
    setViscosityInput(formatInput(language, parameter));
    setInputError(false);
    setConfig((current) => {
      const prev = { ...current, viscosityMpas: parameter };
      const customColor = prev.presetId ? getViscosityColorHex(prev.viscosityMpas) : prev.color;
      if (behavior === 'constant') {
        return {
          ...prev,
          presetId: null,
          name: 'Custom fluid',
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
          name: 'Custom fluid',
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
          name: 'Custom fluid',
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
        name: 'Custom fluid',
        model: 'herschel-bulkley',
        flowIndex: prev.flowIndex === 1 || prev.flowIndex > 1 ? 0.45 : prev.flowIndex,
        yieldStressPa: prev.yieldStressPa > 0 ? prev.yieldStressPa : autoYield,
        color: customColor,
      };
    });
  };

  const materialName = config.presetId ? presetName(language, config.presetId, config.name) : t.customFluid;
  const handleExportCsv = () => {
    const row = (...cells: (string | number)[]) => cells.map((cell) => {
      const text = String(cell);
      return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    }).join(',');
    const lines = [
      'ViscoSim CFD',
      row(t.csvMethod, t.modelTag),
      row(t.csvGrid, GRID_N + 'x' + GRID_N),
      row(t.csvStep, SIMULATION_STEP_SEC),
      row(t.fluid, materialName),
      row(t.csvModel, t[MODEL_LABELS[config.model]]),
      row(config.model === 'newtonian' ? t.csvViscosityInput : t.csvConsistencyInput, config.viscosityMpas),
      row(t.flowIndex, config.model === 'newtonian' ? 1 : config.flowIndex),
      row(t.yieldStress + ' (Pa)', config.model === 'herschel-bulkley' ? config.yieldStressPa : 0),
      row(t.density + ' (kg/m3)', config.densityKgM3),
      row(t.tankDiameter + ' (mm)', config.tankDiameterMm),
      row(t.rodDiameter + ' (mm)', config.stirrerDiameterMm),
      ...(config.model === 'newtonian' ? [] : [row(t.stressResidual, metrics.stressSolveResidual)]),
      '',
      t.csvCurve,
      row(t.shearRate + ' (1/s)', t.shear + ' (Pa)', t.csvViscosity),
    ];

    for (let i = 0; i <= 20; i++) {
      const gamma = Math.pow(10, -1 + (i / 20) * 4);
      const tau = computeShearStressPa(gamma, config);
      const muMpas = computeApparentViscosityPaS(gamma, config) * 1000;
      lines.push(`${gamma.toFixed(4)},${tau.toFixed(6)},${muMpas.toFixed(4)}`);
    }

    lines.push('');
    lines.push(t.csvTimeSeries);
    lines.push(row(t.csvTime, t.energy + ' (mJ/kg)'));
    history.forEach((pt) => {
      lines.push(`${pt.timeSec.toFixed(2)},${pt.kineticEnergyMjKg.toFixed(4)}`);
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

  const parameterLabel = config.model === 'newtonian' ? t.viscosity : t.consistency;
  const inputUnit = getRheologyInputUnit(config.model);


  const updateFluid = (changes: Partial<FluidConfig>) => {
    setConfig((prev) => ({ ...prev, presetId: null, name: 'Custom fluid', ...changes }));
  };
  const behavior = BEHAVIOR_OPTIONS.find(({ id }) => id === getActiveBehavior(config)) ?? BEHAVIOR_OPTIONS[0];
  const metricValues = [
    { label: t.peakSpeed, value: formatReading(language, metrics.maxSpeedMs, 3), unit: 'm/s', Icon: Gauge },
    { label: t.meanShear, value: formatReading(language, metrics.meanShearRate, 2), unit: 's⁻¹', Icon: Activity },
    { label: t.apparentViscosity, value: formatReading(language, metrics.effectiveViscosityMpas, 2), unit: 'mPa·s', Icon: Droplet },
    { label: t.reynolds, value: formatReading(language, metrics.reynolds, 1), unit: '', Icon: Waves },
    { label: t.peakShear, value: formatReading(language, metrics.maxShearRate, 2), unit: 's⁻¹', Icon: Activity },
    { label: t.peakStress, value: formatReading(language, metrics.maxShearStressPa, 3), unit: 'Pa', Icon: Gauge },
  ];

  return (
    <div className="lab-app">
      <header className="lab-header">
        <div className="lab-header-inner">
          <h1 className="lab-brand">
            <span className="lab-brand-mark" aria-hidden="true"><Waves size={21} strokeWidth={2.2} /></span>
            <span>Visco<span className="lab-brand-accent">Sim</span></span>
          </h1>
          <span className="lab-model-tag"><Box size={16} aria-hidden="true" />{t.modelTag}</span>
          <div className="lab-header-actions">
            <label className="lab-language">
              <span className="sr-only">{t.language}</span>
              <select value={language} onChange={(event) => changeLanguage(event.target.value as Language)}>
                <option value="en" lang="en">EN</option>
                <option value="it" lang="it">IT</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </label>
            <button type="button" className="lab-icon-button lab-theme-toggle" aria-label={darkMode ? t.lightTheme : t.darkTheme} title={darkMode ? t.lightTheme : t.darkTheme} onClick={() => setDarkMode(!darkMode)}>
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button type="button" className="lab-button lab-header-export" aria-label={t.exportCsv} onClick={handleExportCsv}><Download size={17} /><span>{t.exportCsv}</span></button>
          </div>
        </div>
      </header>

      <main className="lab-main">
        <section aria-label={t.workspace} className="lab-workbench">
          <aside className="lab-sidebar">
            <section className="lab-control lab-panel" aria-labelledby="fluid-heading">
              <div className="lab-panel-heading">
                <span className="lab-symbol"><SlidersHorizontal size={19} /></span>
                <h2 id="fluid-heading">{t.fluid}</h2>
              </div>

              <div className="lab-material">
                <span className="lab-material-dot" style={{ backgroundColor: config.color }} aria-hidden="true" />
                <div><strong>{materialName}</strong><span>{t[MODEL_LABELS[config.model]]}</span></div>
                <button type="button" className="lab-icon-button" title={t.openLibrary} aria-label={t.openLibrary} onClick={() => libraryRef.current?.showModal()}><LibraryBig size={19} /></button>
              </div>

              <div className="lab-viscosity">
                <div className="lab-viscosity-label">
                  <label htmlFor="viscosity-custom-input">{parameterLabel}</label>
                  {config.model !== 'newtonian' && <InfoTooltip language={language} title={t.consistency} description={t.consistencyHelp} />}
                </div>
                <div className="lab-number-entry">
                  <input id="viscosity-custom-input" type="text" inputMode="decimal" autoComplete="off" aria-invalid={Boolean(inputError)} aria-describedby={inputError ? 'viscosity-error' : undefined}
                    value={viscosityInput} onChange={handleViscosityTextChange} onBlur={handleViscosityBlur}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
                  <span>{config.model === 'newtonian' ? 'mPa·s' : inputUnit}</span>
                </div>
                {inputError && <p id="viscosity-error" className="lab-field-error" role="alert">
                  {t.viscosityRange.replace('{min}', formatReading(language, MIN_LOG_VISCOSITY, 2)).replace('{max}', formatReading(language, viscosityLimit, 0))}
                </p>}
                <input className="lab-range" aria-label={t.logScale + ' · ' + parameterLabel} aria-valuetext={formatReading(language, config.viscosityMpas, 3) + ' ' + inputUnit}
                  type="range" min={0} max={100} step={0.1} value={sliderPos} onChange={handleSliderChange}
                  style={{ '--fill': sliderPos + '%' } as React.CSSProperties} />
                <div className="lab-range-labels" aria-hidden="true"><span>{formatReading(language, MIN_LOG_VISCOSITY, 2)}</span><span>{formatReading(language, viscosityLimit, 0)}</span></div>
                {config.model === 'newtonian' && config.viscosityMpas > MAX_VISCOSITY_MPAS &&
                  <p className="lab-field-hint">{t.highViscosityHint}</p>}
              </div>

              <div className="lab-presets">
                <div className="lab-presets-heading"><h3>{t.quickPresets}</h3><button type="button" className="lab-text-button" onClick={() => libraryRef.current?.showModal()}>{t.allFluids}</button></div>
                <div className="lab-chips">
                  {PRESET_TILES.map(({ preset, label }) => (
                    <button type="button" key={preset.id} aria-pressed={preset.id === config.presetId} onClick={() => applyPreset(preset)}>
                      <span style={{ backgroundColor: preset.color }} aria-hidden="true" />{t[label]}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <details className="lab-panel lab-settings">
              <summary><span className="lab-symbol lab-symbol-neutral"><Settings2 size={18} /></span><span>{t.modelGeometry}</span><ChevronDown size={18} className="lab-chevron" /></summary>
              <div className="lab-settings-body">
                <label className="lab-field"><span>{t.fluidBehavior}</span>
                  <select value={getActiveBehavior(config)} onChange={(event) => handleBehaviorChange(event.target.value as FluidBehaviorId)}>
                    {BEHAVIOR_OPTIONS.map(({ id, label }) => <option key={id} value={id}>{t[label]}</option>)}
                  </select>
                </label>
                <p className="lab-field-hint">{t[behavior.description]}</p>
                <div className="lab-parameter-grid">
                  <label className="lab-field"><span>{t.density} · kg/m³</span><BufferedNumberInput id="input-density" min={500} max={2500} step={10} value={config.densityKgM3} onCommit={(densityKgM3) => updateFluid({ densityKgM3 })} /></label>
                  {config.model !== 'newtonian' && <label className="lab-field"><span>{t.flowIndex}</span><BufferedNumberInput id="input-flow-index" min={0.15} max={1.8} step={0.05} value={config.flowIndex} onCommit={(flowIndex) => updateFluid({ flowIndex })} /></label>}
                  {config.model === 'herschel-bulkley' && <label className="lab-field"><span>{t.yieldStress} · Pa</span><BufferedNumberInput id="input-yield-stress" min={0} max={500} step={1} value={config.yieldStressPa} onCommit={(yieldStressPa) => updateFluid({ yieldStressPa })} /></label>}
                  <label className="lab-field"><span>{t.tankDiameter} · mm</span><BufferedNumberInput id="input-tank-diameter" min={Math.max(50, config.stirrerDiameterMm + 1)} max={600} step={10} value={config.tankDiameterMm} onCommit={(tankDiameterMm) => setConfig((prev) => ({ ...prev, tankDiameterMm }))} /></label>
                  <label className="lab-field"><span>{t.rodDiameter} · mm</span><BufferedNumberInput id="input-stirrer-diameter" min={6} max={Math.min(80, config.tankDiameterMm - 1)} step={2} value={config.stirrerDiameterMm} onCommit={(stirrerDiameterMm) => setConfig((prev) => ({ ...prev, stirrerDiameterMm }))} /></label>
                  <label className="lab-field"><span>{t.fluidColor}</span><input id="input-fluid-color" type="color" value={config.color} onChange={(event) => setConfig((prev) => ({ ...prev, color: event.target.value }))} /></label>
                </div>
              </div>
            </details>
          </aside>

          <FluidViewport config={config} language={language} mode={mode} onModeChange={setMode} showVectors={showVectors}
            elapsedSec={metrics.elapsedSec} onToggleVectors={() => setShowVectors((value) => !value)} onMetricsUpdate={handleMetricsUpdate} onResetComplete={handleResetComplete} />
        </section>

        <section className="lab-readouts" aria-label={t.readings}>
          {metricValues.map(({ label, value, unit, Icon }) => (
            <div key={label} className="lab-readout lab-panel">
              <span className="lab-symbol lab-symbol-neutral"><Icon size={19} /></span>
              <dl><dt>{label}</dt><dd>{value} {unit && <span>{unit}</span>}</dd></dl>
            </div>
          ))}
        </section>

        {metrics.stressSolveResidual > 0.01 &&
          <p className="lab-field-error" role="status">
            {t.stressResidualWarning} ({formatReading(language, 100 * metrics.stressSolveResidual, 1)}%)
          </p>}

        <details className="lab-panel lab-settings lab-chart-details" onToggle={(event) => setChartsOpen(event.currentTarget.open)}>
          <summary><span className="lab-symbol lab-symbol-neutral"><ChartNoAxesCombined size={18} /></span><span>{t.charts}</span><ChevronDown size={18} className="lab-chevron" /></summary>
          {chartsOpen && <div className="lab-charts">
            <RheologyChart language={language} config={config} operatingShearRate={metrics.meanShearRate} />
            <MixingChart language={language} history={history} />
          </div>}
        </details>
        <p className="lab-mobile-method"><Box size={15} aria-hidden="true" />{t.modelTag}</p>
      </main>

      <dialog className="lab-library" ref={libraryRef} aria-labelledby="library-heading" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="lab-library-content">
          <header><div><h2 id="library-heading">{t.fluidLibrary}</h2><p>{t.libraryDescription}</p></div>
            <button type="button" className="lab-icon-button" onClick={() => libraryRef.current?.close()} aria-label={t.closeLibrary}><X size={21} /></button></header>
          <div className="lab-library-grid">
            {FLUID_PRESETS.map((preset) => (
              <button type="button" key={preset.id} aria-pressed={preset.id === config.presetId} className="lab-library-card" onClick={() => { applyPreset(preset); libraryRef.current?.close(); }}>
                <span className="lab-material-dot" style={{ backgroundColor: preset.color }} aria-hidden="true" />
                <div><strong>{presetName(language, preset.id, preset.name)}</strong><span>{t[MODEL_LABELS[preset.model]]} · {formatReading(language, preset.viscosityMpas, 3)} {getRheologyInputUnit(preset.model)}</span></div>
                {preset.id === config.presetId && <Check size={17} aria-label={t.selected} />}
              </button>
            ))}
          </div>
        </div>
      </dialog>
    </div>
  );
}
