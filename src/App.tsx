import { useCallback, useEffect, useRef, useState } from 'react';
import ConfigActionsBar from './components/ConfigActionsBar';
import ControlPanel from './components/ControlPanel';
import DiagnosticsDrawer from './components/DiagnosticsDrawer';
import FluidViewport from './components/FluidViewport';
import MixingChart from './components/MixingChart';
import PresetsTable from './components/PresetsTable';
import RheologyChart from './components/RheologyChart';
import TelemetryGrid from './components/TelemetryGrid';
import { DEFAULT_FLUID_CONFIG, MIN_VISCOSITY_MPAS } from './constants/fluids';
import {
  buildCsvReport,
  buildInteractionTraceV2,
  encodeConfigToUrlParam,
  loadInitialConfigFromBrowser,
  saveConfigToLocalStorage,
  validateAndMigrateFluidConfig,
  wrapPersistedConfigV2,
} from './simulation/persistence';
import { SimulationController } from './simulation/workerClient';
import {
  FluidConfig,
  FluidPreset,
  InteractionEvent,
  SimulationMetrics,
  TimeSeriesPoint,
  VisualizationMode,
} from './types/rheology';

const INITIAL_METRICS: SimulationMetrics = {
  elapsedSec: 0,
  reynolds: 0,
  regime: 'Fermo',
  maxSpeedMs: 0,
  meanShearRate: 0,
  maxShearRate: 0,
  maxShearStressPa: 0,
  effectiveViscosityMpas: DEFAULT_FLUID_CONFIG.viscosityMpas,
  sgsMeanViscosityMpas: 0,
  mixingIndex: 0,
  kineticEnergyMjKg: 0,
  scaleRange: {
    min: 0,
    mid: 50,
    max: 100,
    unit: '',
    label: 'Moto del Fluido',
  },
  diagnostics: {
    renderFps: 0,
    solverUps: 0,
    dtPhysSec: 0.016,
    simulatedTimeSec: 0,
    gridN: 96,
    courantNumber: 0,
    divRms: 0,
    divMax: 0,
    divRmsRaw: 0,
    netBoundaryFlux: 0,
    diffusionResidual: 0,
    pressureResidual: 0,
    picardIterations: 1,
    picardResidual: 0,
    convergenceStatus: 'converged',
    substepsLastStep: 1,
    timeDilationRatio: 1,
    rollbacksCount: 0,
    sgsMeanViscosityMpas: 0,
    sgsMaxViscosityMpas: 0,
    numericalViscosityClampedCount: 0,
  },
};

export default function App() {
  const [initialBoot] = useState(() => loadInitialConfigFromBrowser());
  const [config, setConfig] = useState<FluidConfig>(initialBoot.config);
  const [viscosityInput, setViscosityInput] = useState<string>(
    String(initialBoot.config.viscosityMpas)
  );
  const [mode, setMode] = useState<VisualizationMode>('fluid');
  const [showVectors, setShowVectors] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<SimulationMetrics>(INITIAL_METRICS);
  const [history, setHistory] = useState<TimeSeriesPoint[]>([]);
  const [statusNotice, setStatusNotice] = useState<string | null>(
    initialBoot.warnings.length > 0 ? initialBoot.warnings[0] : null
  );

  const lastSampleTimeRef = useRef<number>(-1);
  const controllerRef = useRef<SimulationController | null>(null);
  const eventsRef = useRef<InteractionEvent[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveConfigToLocalStorage(config);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [config]);

  useEffect(() => {
    if (!statusNotice) return;
    const t = window.setTimeout(() => setStatusNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [statusNotice]);

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

  const applyPreset = (preset: FluidPreset) => {
    setViscosityInput(String(preset.viscosityMpas));
    setConfig((prev) => ({
      ...prev,
      presetId: preset.id,
      name: preset.name,
      model: preset.model,
      viscosityMpas: Math.max(MIN_VISCOSITY_MPAS, preset.viscosityMpas),
      flowIndex: preset.flowIndex,
      yieldStressPa: preset.yieldStressPa,
      papanastasiouM: preset.papanastasiouM,
      densityKgM3: preset.densityKgM3,
      color: preset.color,
    }));
  };

  const handleShareUrl = async () => {
    const encoded = encodeConfigToUrlParam(config);
    const url = `${window.location.origin}${window.location.pathname}?cfg=${encoded}`;
    window.history.replaceState(null, '', `?cfg=${encoded}`);
    try {
      await navigator.clipboard.writeText(url);
      setStatusNotice('Link configurazione copiato negli appunti.');
    } catch {
      setStatusNotice('Parametro ?cfg= aggiornato nella barra degli indirizzi.');
    }
  };

  const handleExportJson = () => {
    const payload = {
      ...wrapPersistedConfigV2(config),
      trace: buildInteractionTraceV2(config, eventsRef.current),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `viscosim-config-${Math.round(config.viscosityMpas)}mpas.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setStatusNotice('Configurazione e traccia esportate in JSON.');
  };

  const handleImportJsonFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = validateAndMigrateFluidConfig(parsed);
      if (!res.ok || !res.config) {
        setStatusNotice(res.error ?? 'File JSON non valido.');
        return;
      }
      setConfig(res.config);
      setViscosityInput(String(res.config.viscosityMpas));
      controllerRef.current?.reset(res.config);
      handleResetComplete();
      setStatusNotice(
        res.warnings.length > 0
          ? `Configurazione importata (${res.warnings[0]}).`
          : 'Configurazione JSON importata e validata.'
      );
    } catch {
      setStatusNotice('Impossibile leggere il file JSON selezionato.');
    }
  };

  const handleResetDefaults = () => {
    setConfig(DEFAULT_FLUID_CONFIG);
    setViscosityInput(String(DEFAULT_FLUID_CONFIG.viscosityMpas));
    window.history.replaceState(null, '', window.location.pathname);
    saveConfigToLocalStorage(DEFAULT_FLUID_CONFIG);
    controllerRef.current?.reset(DEFAULT_FLUID_CONFIG);
    handleResetComplete();
    setStatusNotice('Parametri predefiniti ripristinati.');
  };

  const handleExportCsv = () => {
    const csv = buildCsvReport(config, metrics, history);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `viscosim-report-${Math.round(config.viscosityMpas)}mpas.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 bg-[#07090E]/95 sticky top-0 z-30 backdrop-blur-sm">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <a
            href="#simulatore"
            className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
          >
            ViscoSim
          </a>

          <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-400">
            <a href="#simulatore" className="hover:text-slate-100 transition-colors whitespace-nowrap">
              Simulatore
            </a>
            <a href="#reologia" className="hover:text-slate-100 transition-colors whitespace-nowrap">
              Curva Reologica
            </a>
            <a href="#riferimenti" className="hover:text-slate-100 transition-colors whitespace-nowrap">
              Riferimenti Fluidi
            </a>
          </nav>

          <ConfigActionsBar
            onShareUrl={handleShareUrl}
            onExportJson={handleExportJson}
            onImportJsonFile={handleImportJsonFile}
            onResetDefaults={handleResetDefaults}
            onExportCsv={handleExportCsv}
          />
        </div>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {statusNotice && (
          <div
            role="status"
            className="bg-[#0F141D] border border-cyan-500/40 text-cyan-200 text-xs px-4 py-2.5 rounded-lg flex items-center justify-between gap-3"
          >
            <span>{statusNotice}</span>
            <button
              type="button"
              onClick={() => setStatusNotice(null)}
              className="text-slate-400 hover:text-slate-100 text-xs font-mono"
            >
              Chiudi
            </button>
          </div>
        )}

        <section
          id="simulatore"
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
        >
          <ControlPanel
            config={config}
            viscosityInput={viscosityInput}
            onViscosityInputChange={setViscosityInput}
            onConfigChange={setConfig}
            onApplyPreset={applyPreset}
          />

          <div className="lg:col-span-7 xl:col-span-8 space-y-4">
            <FluidViewport
              config={config}
              mode={mode}
              onModeChange={setMode}
              showVectors={showVectors}
              onToggleVectors={() => setShowVectors((v) => !v)}
              onMetricsUpdate={handleMetricsUpdate}
              onResetComplete={handleResetComplete}
              controllerRef={controllerRef}
              onEventsSnapshot={(ev) => {
                eventsRef.current = ev;
              }}
            />

            <TelemetryGrid
              metrics={metrics}
              enableSmagorinsky={config.enableSmagorinsky}
            />

            <DiagnosticsDrawer
              diagnostics={metrics.diagnostics}
              enableSmagorinsky={config.enableSmagorinsky}
            />
          </div>
        </section>

        <section id="reologia" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <RheologyChart config={config} operatingShearRate={metrics.meanShearRate} />
          <MixingChart history={history} />
        </section>

        <PresetsTable activePresetId={config.presetId} onSelectPreset={applyPreset} />
      </main>
    </div>
  );
}
