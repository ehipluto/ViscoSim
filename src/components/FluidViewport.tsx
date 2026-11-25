import React, { useEffect, useRef, useState } from 'react';
import { Compass, RotateCcw } from 'lucide-react';
import { CFDEngine } from '../simulation/cfdEngine';
import {
  FluidConfig,
  ProbeSample,
  ScaleRange,
  SimulationMetrics,
  VisualizationMode,
} from '../types/rheology';
import InfoTooltip from './InfoTooltip';

interface FluidViewportProps {
  config: FluidConfig;
  mode: VisualizationMode;
  onModeChange: (mode: VisualizationMode) => void;
  showVectors: boolean;
  onToggleVectors: () => void;
  onMetricsUpdate: (metrics: SimulationMetrics) => void;
  onResetComplete?: () => void;
}

const MODE_OPTIONS: Array<{
  id: VisualizationMode;
  label: string;
  helpTitle?: string;
  helpText?: string;
}> = [
  { id: 'fluid', label: 'Fluido Reale' },
  {
    id: 'velocity',
    label: 'Velocità',
    helpTitle: 'Mappa della Velocità |u|',
    helpText:
      'Mostra quanto velocemente si muove il fluido in ogni punto (in m/s). Il blu scuro indica zone ferme; ciano, verde e giallo indicano flusso rapido.',
  },
  {
    id: 'vorticity',
    label: 'Vorticità',
    helpTitle: 'Mappa della Vorticità ω',
    helpText:
      'Evidenzia i vortici e la rotazione locale del fluido (in s⁻¹): blu per rotazione oraria, rosso/ambra per rotazione antioraria, scuro per flusso rettilineo.',
  },
  {
    id: 'shear',
    label: 'Sforzo Taglio',
    helpTitle: 'Mappa dello Sforzo di Taglio τ',
    helpText:
      'Visualizza la forza meccanica interna applicata al fluido (in Pa). Nei fluidi pastosi rivela la "caverna" fluida attorno all’asta rispetto alle zone esterne immobili.',
  },
];

function getLegendGradient(mode: VisualizationMode): string {
  if (mode === 'velocity') {
    return 'linear-gradient(90deg, #0a0f1c 0%, #0e4e7a 25%, #06b6d4 50%, #34d399 75%, #fde047 100%)';
  }
  if (mode === 'vorticity') {
    return 'linear-gradient(90deg, #38bdf8 0%, #1d4ed8 25%, #111827 50%, #d97706 75%, #f43f5e 100%)';
  }
  return 'linear-gradient(90deg, #0b0e17 0%, #581c87 25%, #dc2626 55%, #f59e0b 80%, #fef9c3 100%)';
}

function formatScaleNum(val: number): string {
  const abs = Math.abs(val);
  if (abs === 0) return '0';
  if (abs < 0.1) return val.toFixed(3);
  if (abs < 10) return val.toFixed(2);
  if (abs < 100) return val.toFixed(1);
  return Math.round(val).toLocaleString('it-IT');
}

const FluidViewport: React.FC<FluidViewportProps> = ({
  config,
  mode,
  onModeChange,
  showVectors,
  onToggleVectors,
  onMetricsUpdate,
  onResetComplete,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fluidCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CFDEngine | null>(null);
  const sizeRef = useRef<number>(512);

  const configRef = useRef(config);
  const modeRef = useRef(mode);
  const vectorsRef = useRef(showVectors);
  const metricsCallbackRef = useRef(onMetricsUpdate);

  configRef.current = config;
  modeRef.current = mode;
  vectorsRef.current = showVectors;
  metricsCallbackRef.current = onMetricsUpdate;

  const pointerRef = useRef<{
    active: boolean;
    hovering: boolean;
    xNorm: number;
    yNorm: number;
    prevXNorm: number;
    prevYNorm: number;
    pointerId: number | null;
  }>({
    active: false,
    hovering: false,
    xNorm: 0.5,
    yNorm: 0.5,
    prevXNorm: 0.5,
    prevYNorm: 0.5,
    pointerId: null,
  });

  const [probe, setProbe] = useState<ProbeSample | null>(null);
  const [scaleRange, setScaleRange] = useState<ScaleRange>({
    min: 0,
    mid: 50,
    max: 100,
    unit: '',
    label: 'Moto del Fluido',
  });

  useEffect(() => {
    const fluidCanvas = fluidCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const container = containerRef.current;
    if (!fluidCanvas || !overlayCanvas || !container) return;

    const engine = new CFDEngine();
    engine.initRenderer(fluidCanvas);
    engineRef.current = engine;

    const overlayCtx = overlayCanvas.getContext('2d');
    if (!overlayCtx) return;

    const syncCanvasSize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.max(280, Math.round(rect.width * dpr));
      sizeRef.current = px;
      if (overlayCanvas.width !== px || overlayCanvas.height !== px) {
        overlayCanvas.width = px;
        overlayCanvas.height = px;
      }
    };

    syncCanvasSize();
    const observer = new ResizeObserver(syncCanvasSize);
    observer.observe(container);

    let rafId = 0;
    let lastFrameTime = performance.now();
    let lastUiSyncTime = 0;

    const renderFrame = (now: number) => {
      const dt = Math.min(0.033, Math.max(0.004, (now - lastFrameTime) * 0.001));
      lastFrameTime = now;

      const cfg = configRef.current;
      const ptr = pointerRef.current;
      if (ptr.active) {
        engine.applyStirrerImpulse(
          ptr.prevXNorm,
          ptr.prevYNorm,
          ptr.xNorm,
          ptr.yNorm,
          dt,
          cfg
        );
        ptr.prevXNorm = ptr.xNorm;
        ptr.prevYNorm = ptr.yNorm;
      }

      engine.step(dt, cfg);

      const sz = sizeRef.current;
      const range = engine.renderFluidLayer(
        fluidCanvas,
        sz,
        sz,
        modeRef.current,
        cfg.color
      );

      overlayCtx.clearRect(0, 0, sz, sz);
      const cx = sz * 0.5;
      const cy = sz * 0.5;
      const radiusPx = sz * 0.45;

      if (vectorsRef.current) {
        overlayCtx.save();
        overlayCtx.beginPath();
        overlayCtx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
        overlayCtx.clip();
        engine.drawVectorOverlay(overlayCtx, sz, sz);
        overlayCtx.restore();
      }

      overlayCtx.strokeStyle = '#334155';
      overlayCtx.lineWidth = Math.max(1.5, sz * 0.0035);
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      overlayCtx.stroke();

      overlayCtx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      overlayCtx.lineWidth = 1;
      for (let a = 0; a < 12; a++) {
        const ang = (a * Math.PI) / 6;
        const rIn = radiusPx + 2;
        const rOut = radiusPx + (a % 3 === 0 ? 9 : 5);
        overlayCtx.beginPath();
        overlayCtx.moveTo(cx + Math.cos(ang) * rIn, cy + Math.sin(ang) * rIn);
        overlayCtx.lineTo(cx + Math.cos(ang) * rOut, cy + Math.sin(ang) * rOut);
        overlayCtx.stroke();
      }

      if (ptr.hovering || ptr.active) {
        const sx = ptr.xNorm * sz;
        const sy = ptr.yNorm * sz;
        const rodRadiusPx = Math.max(
          5,
          ((cfg.stirrerDiameterMm * 0.5) / Math.max(50, cfg.tankDiameterMm)) * (radiusPx * 2)
        );

        overlayCtx.strokeStyle = ptr.active ? '#06b6d4' : 'rgba(226, 232, 240, 0.55)';
        overlayCtx.lineWidth = ptr.active ? 2 : 1.25;
        overlayCtx.beginPath();
        overlayCtx.arc(sx, sy, rodRadiusPx, 0, Math.PI * 2);
        overlayCtx.stroke();

        if (ptr.active) {
          overlayCtx.fillStyle = 'rgba(6, 182, 212, 0.18)';
          overlayCtx.fill();
        }
      }

      if (now - lastUiSyncTime >= 100) {
        lastUiSyncTime = now;
        setScaleRange(range);
        metricsCallbackRef.current(engine.getMetrics(cfg, range));
        if (ptr.hovering || ptr.active) {
          setProbe(engine.sampleProbe(ptr.xNorm, ptr.yNorm, cfg));
        } else {
          setProbe(null);
        }
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const toNormCoords = (clientX: number, clientY: number): [number, number] => {
    const canvas = fluidCanvasRef.current;
    if (!canvas) return [0.5, 0.5];
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return [x, y];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toNormCoords(e.clientX, e.clientY);
    pointerRef.current = {
      active: true,
      hovering: true,
      xNorm: x,
      yNorm: y,
      prevXNorm: x,
      prevYNorm: y,
      pointerId: e.pointerId,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = toNormCoords(e.clientX, e.clientY);
    const ptr = pointerRef.current;
    ptr.hovering = true;
    ptr.xNorm = x;
    ptr.yNorm = y;
    if (!ptr.active) {
      ptr.prevXNorm = x;
      ptr.prevYNorm = y;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    pointerRef.current.active = false;
    pointerRef.current.pointerId = null;
    if (e.pointerType !== 'mouse') {
      pointerRef.current.hovering = false;
    }
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current.active && e.pointerType === 'mouse') {
      pointerRef.current.hovering = false;
    }
  };

  const activeModeOpt = MODE_OPTIONS.find((opt) => opt.id === mode);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#0F141D] border border-slate-800 rounded-lg"
          role="tablist"
          aria-label="Modalità di visualizzazione fluidodinamica"
        >
          {MODE_OPTIONS.map((opt) => {
            const active = mode === opt.id;
            return (
              <div key={opt.id} className="inline-flex items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onModeChange(opt.id)}
                  className={`px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[38px] sm:min-h-[34px] ${
                    active
                      ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                      : 'text-slate-400 hover:text-slate-100 border border-transparent'
                  }`}
                >
                  {opt.label}
                </button>
                {opt.helpTitle && opt.helpText && (
                  <span className="pr-1">
                    <InfoTooltip title={opt.helpTitle} description={opt.helpText} />
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleVectors}
            aria-pressed={showVectors}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 min-h-[40px] sm:min-h-[36px] ${
              showVectors
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-[#0F141D] border-slate-800 text-slate-300 hover:border-slate-700'
            }`}
          >
            <Compass size={14} />
            Vettori
          </button>

          <button
            type="button"
            onClick={() => {
              engineRef.current?.reset(configRef.current.viscosityMpas / 1000);
              onResetComplete?.();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0F141D] border border-slate-800 text-slate-200 hover:border-slate-700 transition-colors whitespace-nowrap shrink-0 min-h-[40px] sm:min-h-[36px]"
          >
            <RotateCcw size={14} />
            Reset Vasca
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative w-full aspect-square max-w-[600px] mx-auto bg-[#07090E] border border-slate-800 rounded-lg overflow-hidden"
      >
        <canvas
          ref={fluidCanvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          className="w-full h-full block touch-none select-none cursor-crosshair"
        />

        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        <div className="absolute top-3 left-3 pointer-events-none font-mono text-[11px] tabular-nums text-slate-400 bg-[#07090E]/85 border border-slate-800 px-2.5 py-1 rounded">
          D = {config.tankDiameterMm} mm · d = {config.stirrerDiameterMm} mm
        </div>

        {probe && probe.active && (
          <div className="absolute bottom-3 left-3 right-3 sm:right-auto pointer-events-none bg-[#07090E]/90 border border-slate-800 rounded px-3 py-2 font-mono text-[11px] tabular-nums text-slate-200 grid grid-cols-2 sm:flex sm:items-center gap-x-4 gap-y-1">
            <span>
              r: <strong className="text-slate-100">{probe.rMm.toFixed(1)}</strong> mm
            </span>
            <span>
              |u|: <strong className="text-cyan-400">{probe.speedMs.toFixed(2)}</strong> m/s
            </span>
            <span>
              γ̇: <strong className="text-slate-100">{probe.shearRate.toFixed(1)}</strong> s⁻¹
            </span>
            <span>
              τ: <strong className="text-amber-400">{probe.shearStressPa.toFixed(2)}</strong> Pa
            </span>
          </div>
        )}

        {!probe && (
          <div className="absolute bottom-3 left-3 pointer-events-none font-sans text-xs text-slate-400 bg-[#07090E]/80 border border-slate-800/80 px-2.5 py-1 rounded">
            Trascina nel recipiente per agitare il fluido
          </div>
        )}
      </div>

      {mode === 'fluid' ? (
        <div className="bg-[#0F141D] border border-slate-800 rounded-lg px-4 py-2.5 flex items-center justify-between gap-2 text-xs">
          <span className="text-slate-300 font-medium inline-flex items-center gap-2">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full border border-white/25 shrink-0"
              style={{ backgroundColor: config.color }}
              aria-hidden="true"
            />
            Vista Fluido Reale
          </span>
          <span className="text-slate-400">
            Osserva il comportamento fisico di scorrimento, vortici e scia interna
          </span>
        </div>
      ) : (
        <div className="bg-[#0F141D] border border-slate-800 rounded-lg px-4 py-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-300 font-medium inline-flex items-center gap-1.5">
              {scaleRange.label}
              {activeModeOpt?.helpTitle && activeModeOpt?.helpText && (
                <InfoTooltip title={activeModeOpt.helpTitle} description={activeModeOpt.helpText} />
              )}
            </span>
            <span className="font-mono text-slate-400 tabular-nums">{scaleRange.unit}</span>
          </div>
          <div
            className="h-2.5 w-full rounded-sm border border-slate-800"
            style={{ background: getLegendGradient(mode) }}
          />
          <div className="flex justify-between font-mono text-[11px] text-slate-400 tabular-nums">
            <span>{formatScaleNum(scaleRange.min)}</span>
            <span>{formatScaleNum(scaleRange.mid)}</span>
            <span>{formatScaleNum(scaleRange.max)}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default FluidViewport;
