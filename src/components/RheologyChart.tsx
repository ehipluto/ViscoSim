import React, { useMemo, useState } from 'react';
import { computeApparentViscosityPaS, computeShearStressPa } from '../constants/fluids';
import { FluidConfig } from '../types/rheology';
import InfoTooltip from './InfoTooltip';
import { copy, formatReading, type Language } from '../locale';

interface RheologyChartProps {
  language: Language;
  config: FluidConfig;
  operatingShearRate: number;
}

const SHEAR_SAMPLES = Array.from({ length: 41 }, (_, idx) => {
  const exp = -1 + (idx / 40) * 4;
  return Math.pow(10, exp);
});

const RheologyChart: React.FC<RheologyChartProps> = ({ language, config, operatingShearRate }) => {
  const t = copy[language];
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 520;
  const height = 220;
  const padL = 54;
  const padR = 54;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const curveGeometry = useMemo(() => {
    const pts = SHEAR_SAMPLES.map((gamma) => {
      const tau = computeShearStressPa(gamma, config);
      const muMpas = computeApparentViscosityPaS(gamma, config) * 1000;
      return { gamma, tau: Math.max(1e-4, tau), muMpas: Math.max(0.01, muMpas) };
    });

    const minLogTau = Math.floor(Math.min(...pts.map((p) => Math.log10(p.tau)), -2));
    const maxLogTau = Math.ceil(Math.max(...pts.map((p) => Math.log10(p.tau)), 3));

    const minLogMu = Math.floor(Math.min(...pts.map((p) => Math.log10(p.muMpas)), -1));
    const maxLogMu = Math.ceil(Math.max(...pts.map((p) => Math.log10(p.muMpas)), 5));

    const mapX = (gamma: number) => {
      const logG = Math.log10(Math.max(0.1, Math.min(1000, gamma)));
      return padL + ((logG - -1) / 4) * plotW;
    };

    const mapYTau = (tau: number) => {
      const logT = Math.log10(Math.max(Math.pow(10, minLogTau), tau));
      const norm = (logT - minLogTau) / Math.max(1, maxLogTau - minLogTau);
      return padT + plotH - norm * plotH;
    };

    const mapYMu = (mu: number) => {
      const logM = Math.log10(Math.max(Math.pow(10, minLogMu), mu));
      const norm = (logM - minLogMu) / Math.max(1, maxLogMu - minLogMu);
      return padT + plotH - norm * plotH;
    };

    const tauPath = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${mapX(p.gamma).toFixed(1)} ${mapYTau(p.tau).toFixed(1)}`)
      .join(' ');

    const muPath = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${mapX(p.gamma).toFixed(1)} ${mapYMu(p.muMpas).toFixed(1)}`)
      .join(' ');

    return {
      pts,
      tauPath,
      muPath,
      minLogTau,
      maxLogTau,
      minLogMu,
      maxLogMu,
      mapX,
      mapYTau,
      mapYMu,
    };
  }, [config, plotW, plotH]);

  const operatingPoint = useMemo(() => {
    if (operatingShearRate < 0.1 || operatingShearRate > 1000) return null;
    const clampedOpGamma = operatingShearRate;
    const opTau = Math.max(1e-4, computeShearStressPa(clampedOpGamma, config));
    const opMu = Math.max(0.01, computeApparentViscosityPaS(clampedOpGamma, config) * 1000);
    return {
      clampedOpGamma,
      opTau,
      opMu,
      opX: curveGeometry.mapX(clampedOpGamma),
      opYTau: curveGeometry.mapYTau(opTau),
    };
  }, [curveGeometry, config, operatingShearRate]);

  const curveData = { ...curveGeometry, ...operatingPoint };
  const activePoint = hoverIdx !== null ? curveGeometry.pts[hoverIdx] : null;

  const handleSvgMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const norm = Math.max(0, Math.min(1, (relX - padL) / plotW));
    const idx = Math.round(norm * (SHEAR_SAMPLES.length - 1));
    setHoverIdx(idx);
  };

  return (
    <div className="lab-panel lab-chart">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="inline-flex items-center gap-1.5">
            {t.rheologyChart}
            <InfoTooltip
              language={language}
              title={t.rheologyChart}
              description={t.rheologyHelp}
            />
          </h3>
          <p className="text-xs text-slate-400">
            {t.rheologyDescription}
          </p>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="lab-chart-violet">― τ (Pa)</span>
          <span className="lab-chart-amber">- - μ (mPa·s)</span>
        </div>
      </div>

      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto block select-none cursor-crosshair"
          role="img"
          aria-label={t.rheologyDescription}
          onPointerMove={handleSvgMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          {[0.1, 1, 10, 100, 1000].map((g) => {
            const x = curveData.mapX(g);
            return (
              <g key={g}>
                <line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke="var(--lab-chart-grid)" strokeWidth="1" />
                <text
                  x={x}
                  y={height - 10}
                  textAnchor="middle"
                  fill="var(--lab-muted)"
                  fontSize="10"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {formatReading(language, g, 1)}
                </text>
              </g>
            );
          })}

          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const y = padT + f * plotH;
            const expTau =
              curveData.maxLogTau - f * (curveData.maxLogTau - curveData.minLogTau);
            const expMu =
              curveData.maxLogMu - f * (curveData.maxLogMu - curveData.minLogMu);
            return (
              <g key={f}>
                <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--lab-chart-grid)" strokeWidth="1" />
                <text
                  x={padL - 6}
                  y={y + 3}
                  textAnchor="end"
                  fill="var(--lab-chart-violet)"
                  fontSize="9.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  10^{expTau.toFixed(0)}
                </text>
                <text
                  x={padL + plotW + 6}
                  y={y + 3}
                  textAnchor="start"
                  fill="var(--lab-chart-amber)"
                  fontSize="9.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  10^{expMu.toFixed(0)}
                </text>
              </g>
            );
          })}

          <path d={curveData.muPath} fill="none" stroke="var(--lab-chart-amber)" strokeWidth="1.75" strokeDasharray="4 3" />
          <path d={curveData.tauPath} fill="none" stroke="var(--lab-chart-violet)" strokeWidth="2.25" />

          {operatingPoint && <circle cx={operatingPoint.opX} cy={operatingPoint.opYTau} r="4.5" fill="var(--lab-chart-violet)" stroke="var(--lab-panel)" strokeWidth="1.5" />}

          {activePoint && (
            <g>
              <line
                x1={curveData.mapX(activePoint.gamma)}
                y1={padT}
                x2={curveData.mapX(activePoint.gamma)}
                y2={padT + plotH}
                stroke="var(--lab-muted)"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <circle
                cx={curveData.mapX(activePoint.gamma)}
                cy={curveData.mapYTau(activePoint.tau)}
                r="4"
                fill="var(--lab-chart-violet)"
              />
              <circle
                cx={curveData.mapX(activePoint.gamma)}
                cy={curveData.mapYMu(activePoint.muMpas)}
                r="4"
                fill="var(--lab-chart-amber)"
              />
            </g>
          )}

          <text
            x={padL + plotW / 2}
            y={height - 1}
            textAnchor="middle"
            fill="var(--lab-muted)"
            fontSize="9.5"
            fontFamily="DM Sans, sans-serif"
          >
            {t.shearRate} γ̇ (s⁻¹)
          </text>
        </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 lab-chart-caption font-mono tabular-nums">
        {activePoint ? (
          <>
            <span>{t.chartPointer} γ̇: {formatReading(language, activePoint.gamma, 2)} s⁻¹</span>
            <span>τ: {formatReading(language, activePoint.tau, 3)} Pa</span>
            <span>μ: {formatReading(language, activePoint.muMpas, 2)} mPa·s</span>
          </>
        ) : operatingPoint ? (
          <>
            <span>{t.meanShear}: {formatReading(language, operatingPoint.clampedOpGamma, 2)} s⁻¹</span>
            <span>{t.stressAtMean}: {formatReading(language, operatingPoint.opTau, 3)} Pa</span>
            <span>{t.viscosityAtMean}: {formatReading(language, operatingPoint.opMu, 2)} mPa·s</span>
          </>
        ) : <span>{t.shearOutside}</span>}
      </div>
    </div>
  );
};

export default RheologyChart;
