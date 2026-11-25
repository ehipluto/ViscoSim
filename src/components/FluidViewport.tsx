import React, { useEffect, useRef, useState } from 'react';
import { Compass, Crosshair, Lock, LockOpen, MousePointer2, Orbit, Pause, Play, RotateCcw } from 'lucide-react';
import { CFDEngine } from '../simulation/cfdEngine';
import { computeApparentViscosityPaS } from '../constants/fluids';
import { PointerPath, SIMULATION_STEP_SEC, SimulationClock } from '../simulation/simulationClock';
import {
  FluidConfig,
  ProbeSample,
  ScaleRange,
  SimulationMetrics,
  VisualizationMode,
} from '../types/rheology';
import InfoTooltip from './InfoTooltip';
import { copy, formatReading, type Language } from '../locale';

interface FluidViewportProps {
  config: FluidConfig;
  language: Language;
  elapsedSec: number;
  mode: VisualizationMode;
  onModeChange: (mode: VisualizationMode) => void;
  showVectors: boolean;
  onToggleVectors: () => void;
  onMetricsUpdate: (metrics: SimulationMetrics) => void;
  onResetComplete?: () => void;
}

const MODES: VisualizationMode[] = ['fluid', 'velocity', 'vorticity', 'shear'];
const MAP_HELP = { velocity: 'speedHelp', vorticity: 'vorticityHelp', shear: 'shearHelp' } as const;

function getLegendGradient(mode: VisualizationMode): string {
  if (mode === 'velocity') {
    return 'linear-gradient(90deg, #0a0f1c 0%, #0e4e7a 25%, #06b6d4 50%, #34d399 75%, #fde047 100%)';
  }
  if (mode === 'vorticity') {
    return 'linear-gradient(90deg, #38bdf8 0%, #1d4ed8 25%, #111827 50%, #d97706 75%, #f43f5e 100%)';
  }
  return 'linear-gradient(90deg, #0b0e17 0%, #581c87 25%, #dc2626 55%, #f59e0b 80%, #fef9c3 100%)';
}

function formatScaleNum(language: Language, val: number): string {
  const abs = Math.abs(val);
  return formatReading(language, val, abs < 0.1 ? 3 : abs < 10 ? 2 : abs < 100 ? 1 : 0);
}

const FluidViewport: React.FC<FluidViewportProps> = ({
  config,
  language,
  elapsedSec,
  mode,
  onModeChange,
  showVectors,
  onToggleVectors,
  onMetricsUpdate,
  onResetComplete,
}) => {
  const t = copy[language];
  const containerRef = useRef<HTMLDivElement>(null);
  const fluidCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef<number>(512);

  const configRef = useRef(config);
  const modeRef = useRef(mode);
  const vectorsRef = useRef(showVectors);
  const metricsCallbackRef = useRef(onMetricsUpdate);
  const resetCallbackRef = useRef(onResetComplete);
  const resetRequested = useRef(false);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [lockedMode, setLockedMode] = useState<VisualizationMode | null>(null);
  const scaleLockedRef = useRef(false);
  const pointerPath = useRef(new PointerPath());

  configRef.current = config;
  modeRef.current = mode;
  vectorsRef.current = showVectors;
  metricsCallbackRef.current = onMetricsUpdate;
  resetCallbackRef.current = onResetComplete;
  scaleLockedRef.current = lockedMode === mode;

  const physicsKey = [
    config.model, config.viscosityMpas, config.flowIndex, config.yieldStressPa,
    config.papanastasiouM, config.densityKgM3, config.tankDiameterMm, config.stirrerDiameterMm,
  ].join('/');
  const physicsKeyRef = useRef(physicsKey);
  physicsKeyRef.current = physicsKey;

  const pointerRef = useRef<{
    active: boolean;
    hovering: boolean;
    xNorm: number;
    yNorm: number;
    pointerId: number | null;
  }>({
    active: false,
    hovering: false,
    xNorm: 0.5,
    yNorm: 0.5,
    pointerId: null,
  });

  const [probe, setProbe] = useState<ProbeSample | null>(null);
  const [scaleRange, setScaleRange] = useState<ScaleRange>({
    min: 0,
    mid: 50,
    max: 100,
    unit: '',
    label: '',
  });

  useEffect(() => {
    const fluidCanvas = fluidCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const container = containerRef.current;
    if (!fluidCanvas || !overlayCanvas || !container) return;

    const engine = new CFDEngine();
    engine.initRenderer(fluidCanvas);
    engine.reset(computeApparentViscosityPaS(0, configRef.current));

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
    const clock = new SimulationClock(performance.now());
    let lastPhysicsKey = physicsKeyRef.current;
    let lastUiSyncTime = 0;
    let lastRenderKey = '';
    let range = engine.getActiveScaleRange('fluid');
    let metricsDirty = true;
    let lastUiMode = modeRef.current;
    let lastUiPaused = pausedRef.current;
    let lastUiLock = scaleLockedRef.current;
    let activity = false;
    const syncVisibility = () => {
      clock.reset(performance.now());
      pointerRef.current.active = false;
      pointerRef.current.pointerId = null;
      pointerPath.current.clear();
    };
    document.addEventListener('visibilitychange', syncVisibility);

    const renderFrame = (now: number) => {
      rafId = requestAnimationFrame(renderFrame);
      if (document.hidden) return;
      const cfg = configRef.current;
      const ptr = pointerRef.current;
      let fieldsChanged = false;
      if (resetRequested.current || physicsKeyRef.current !== lastPhysicsKey) {
        if (physicsKeyRef.current !== lastPhysicsKey) {
          pointerPath.current.clear();
          pointerRef.current.active = false;
          pointerRef.current.pointerId = null;
        }
        resetRequested.current = false;
        lastPhysicsKey = physicsKeyRef.current;
        engine.reset(computeApparentViscosityPaS(0, cfg), scaleLockedRef.current);
        fieldsChanged = true;
        activity = false;
        clock.reset(now);
        resetCallbackRef.current?.();
      }

      if (pausedRef.current || (!activity && !pointerPath.current.hasPendingInput)) {
        clock.reset(now);
      } else {
        clock.advance(now, (timeMs) => {
          const segment = pointerPath.current.sample(timeMs);
          if (segment) engine.applyStirrerImpulse(...segment, SIMULATION_STEP_SEC, cfg);
          engine.step(SIMULATION_STEP_SEC, cfg);
          activity = true;
          fieldsChanged = true;
        });
      }

      const sz = sizeRef.current;
      const renderKey = [
        sz, modeRef.current, vectorsRef.current, cfg.color, scaleLockedRef.current,
        ptr.active, ptr.hovering, ptr.xNorm, ptr.yNorm,
      ].join('/');
      const needsPaint = fieldsChanged || renderKey !== lastRenderKey;
      if (needsPaint) {
        lastRenderKey = renderKey;
        range = engine.renderFluidLayer(
          fluidCanvas,
          sz,
          sz,
          modeRef.current,
          cfg.color,
          scaleLockedRef.current,
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

        overlayCtx.strokeStyle = 'rgba(190, 211, 255, .72)';
        overlayCtx.lineWidth = Math.max(1, sz * 0.002);
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

        if (ptr.active || ptr.hovering) {
          const sx = ptr.xNorm * sz;
          const sy = ptr.yNorm * sz;
          const rodRadiusPx = Math.max(
            5,
            ((cfg.stirrerDiameterMm * 0.5) / Math.max(50, cfg.tankDiameterMm)) * (radiusPx * 2)
          );

          const stirring = ptr.active;
          overlayCtx.strokeStyle = stirring ? '#e5e3ff' : 'rgba(226, 232, 240, 0.62)';
          overlayCtx.lineWidth = stirring ? 2 : 1.25;
          overlayCtx.beginPath();
          overlayCtx.arc(sx, sy, rodRadiusPx, 0, Math.PI * 2);
          overlayCtx.stroke();

          if (stirring) {
            overlayCtx.fillStyle = 'rgba(194, 160, 255, .3)';
            overlayCtx.fill();
            overlayCtx.beginPath();
            overlayCtx.arc(sx, sy, Math.max(1.5, sz * 0.004), 0, Math.PI * 2);
            overlayCtx.fillStyle = '#f0ebff';
            overlayCtx.fill();
          }
        }
      }
      metricsDirty ||= needsPaint;
      const controlsChanged = lastUiMode !== modeRef.current || lastUiPaused !== pausedRef.current ||
        lastUiLock !== scaleLockedRef.current;
      if ((metricsDirty && now - lastUiSyncTime >= 100) || controlsChanged) {
        metricsDirty = false;
        lastUiSyncTime = now;
        lastUiMode = modeRef.current;
        lastUiPaused = pausedRef.current;
        lastUiLock = scaleLockedRef.current;
        setScaleRange(range);
        metricsCallbackRef.current(engine.getMetrics(cfg, range));
        if (ptr.hovering || ptr.active) {
          setProbe(engine.sampleProbe(ptr.xNorm, ptr.yNorm, cfg));
        } else {
          setProbe(null);
        }
      }
    };

    rafId = requestAnimationFrame(renderFrame);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncVisibility);
      engine.dispose();
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
    if (pausedRef.current || pointerRef.current.active || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toNormCoords(e.clientX, e.clientY);
    pointerPath.current.push({ timeMs: e.timeStamp, x, y, kind: 'down' });
    pointerRef.current = {
      active: true,
      hovering: true,
      xNorm: x,
      yNorm: y,
      pointerId: e.pointerId,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = toNormCoords(e.clientX, e.clientY);
    const ptr = pointerRef.current;
    if (ptr.active && ptr.pointerId !== e.pointerId) return;
    ptr.hovering = true;
    ptr.xNorm = x;
    ptr.yNorm = y;
    if (ptr.active) pointerPath.current.push({ timeMs: e.timeStamp, x, y, kind: 'move' });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current.pointerId !== e.pointerId) return;
    pointerRef.current.active = false;
    pointerRef.current.pointerId = null;
    if (e.type === 'pointerup') {
      const [x, y] = toNormCoords(e.clientX, e.clientY);
      pointerPath.current.push({ timeMs: e.timeStamp, x, y, kind: 'up' });
    } else {
      pointerPath.current.clear();
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (e.pointerType !== 'mouse') {
      pointerRef.current.hovering = false;
    }
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current.active && e.pointerType === 'mouse') {
      pointerRef.current.hovering = false;
    }
  };


  const status = paused ? t.paused : elapsedSec > 0 ? t.running : t.ready;
  const togglePause = () => {
    pausedRef.current = !paused;
    pointerRef.current.active = false;
    pointerRef.current.pointerId = null;
    pointerPath.current.clear();
    setPaused(!paused);
  };
  const resetTank = () => {
    pointerRef.current.active = false;
    pointerRef.current.pointerId = null;
    pointerPath.current.clear();
    resetRequested.current = true;
  };

  return (
    <section className="lab-stage" aria-labelledby="tank-heading" data-running={!paused && elapsedSec > 0}>
      <header className="lab-stage-header">
        <div className="lab-stage-title">
          <span className="lab-stage-glyph"><Orbit size={21} /></span>
          <div><h2 id="tank-heading">{t.tank}</h2><p>{t.topView}</p></div>
        </div>
        <span className="lab-stage-status" data-paused={paused}><i aria-hidden="true" />{status}</span>
      </header>

      <div className="lab-map-toolbar" role="group" aria-label={t.viewSelector}>
        {MODES.map((option) => <button type="button" key={option} aria-pressed={mode === option}
          onClick={() => { if (mode !== option) setLockedMode(null); onModeChange(option); }}>{t[option]}</button>)}
        <button type="button" className="lab-map-vectors" aria-pressed={showVectors} onClick={onToggleVectors}><Compass size={15} />{t.vectors}</button>
      </div>

      <div className="lab-stage-scene">
        <span className="lab-axis lab-axis-x" aria-hidden="true" />
        <span className="lab-axis lab-axis-y" aria-hidden="true" />
        <div className="lab-stage-dimension"><span>{t.diameter}</span><strong>Ø {config.tankDiameterMm} mm</strong></div>
        <div className="lab-stage-time"><span>{t.simTime}</span><strong>{elapsedSec.toLocaleString(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s</strong></div>
        <div ref={containerRef} className="lab-tank">
          <div className="lab-tank-bezel" aria-hidden="true" />
          <div className="lab-tank-ticks" aria-hidden="true" />
          <canvas ref={fluidCanvasRef} className="lab-fluid-canvas" aria-label={t.tankLabel}
            onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp} onLostPointerCapture={handlePointerUp} onPointerLeave={handlePointerLeave} />
          <canvas ref={overlayCanvasRef} className="lab-overlay-canvas" aria-hidden="true" />
          {mode === 'fluid' && <div className="lab-tank-glint" aria-hidden="true" />}
        </div>

        {probe?.active && <div className="lab-probe" aria-label={t.probe}>
          <Crosshair size={16} aria-hidden="true" />
          <span><b>{formatScaleNum(language, probe.speedMs)}</b> m/s</span>
          <span><b>{formatScaleNum(language, probe.shearRate)}</b> s⁻¹</span>
          <span><b>{formatScaleNum(language, probe.shearStressPa)}</b> Pa</span>
        </div>}
      </div>

      {mode !== 'fluid' && <div className="lab-map-legend">
        <div className="lab-legend-title"><span>{t[mode]} · {scaleRange.unit}</span>
          <InfoTooltip language={language} title={t[mode]} description={t[MAP_HELP[mode]]} />
        </div>
        <div className="lab-legend-scale"><div style={{ background: getLegendGradient(mode) }} />
          <div><span>{formatScaleNum(language, scaleRange.min)}</span><span>{formatScaleNum(language, scaleRange.mid)}</span><span>{formatScaleNum(language, scaleRange.max)}</span></div>
        </div>
        <button type="button" aria-pressed={lockedMode === mode} onClick={() => setLockedMode(lockedMode === mode ? null : mode)}>
          {lockedMode === mode ? <Lock size={15} /> : <LockOpen size={15} />} {lockedMode === mode ? t.unlockScale : t.lockScale}
        </button>
      </div>}

      <footer className="lab-stage-footer">
        <span className="lab-stage-hint"><MousePointer2 size={17} aria-hidden="true" /> {paused ? t.resumeHint : t.drag}</span>
        <div className="lab-stage-actions">
          <button type="button" className="lab-stage-button" aria-label={paused ? t.resume : t.pause} title={paused ? t.resume : t.pause} onClick={togglePause}>{paused ? <Play size={17} /> : <Pause size={17} />}</button>
          <button type="button" className="lab-stage-button" aria-label={t.reset} title={t.reset} onClick={resetTank}><RotateCcw size={17} /></button>
        </div>
      </footer>
    </section>
  );
};

export default FluidViewport;
