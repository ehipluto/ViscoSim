import React, { useMemo, useState } from 'react';
import {
  computeApparentViscosityPaS,
  computeShearStressPa,
  MIN_VISCOSITY_MPAS,
  SHEAR_REGULARIZATION_S_INV,
} from '../constants/fluids';
import { FluidConfig } from '../types/rheology';
import InfoTooltip from './InfoTooltip';

interface RheologyChartProps {
  config: FluidConfig;
  operatingShearRate: number;
}

const SHEAR_SAMPLES = Array.from({ length: 41 }, (_, idx) => {
  const exp = -1 + (idx / 40) * 4;
  return Math.pow(10, exp);
});

const RheologyChart: React.FC<RheologyChartProps> = ({ config, operatingShearRate }) => {
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
      const tau = computeShearStressPa(gamma, config, SHEAR_REGULARIZATION_S_INV);
      const muMpas = computeApparentViscosityPaS(gamma, config, SHEAR_REGULARIZATION_S_INV) * 1000;
      return {
        gamma,
        tau: Math.max(1e-6, tau),
        muMpas: Math.max(MIN_VISCOSITY_MPAS * 0.1, muMpas),
      };
    });

    const minLogTau = Math.floor(Math.min(...pts.map((p) => Math.log10(p.tau)), -2));
    const maxLogTau = Math.ceil(Math.max(...pts.map((p) => Math.log10(p.tau)), 3));

    const minLogMu = Math.floor(Math.min(...pts.map((p) => Math.log10(p.muMpas)), -2));
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
    const clampedOpGamma = Math.max(0.1, Math.min(1000, operatingShearRate || 0.1));
    const opTau = Math.max(
      1e-6,
      computeShearStressPa(clampedOpGamma, config, SHEAR_REGULARIZATION_S_INV)
    );
    const opMu =
      computeApparentViscosityPaS(clampedOpGamma, config, SHEAR_REGULARIZATION_S_INV) * 1000;
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
    <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-1.5">
            Curva di Flusso Reologica (Log-Log)
            <InfoTooltip
              title="Come leggere la Curva di Flusso"
              description="Mostra la legge costitutiva fisica regolarizzata usata dal solutore (con γ̇_reg = 10⁻³ s⁻¹ e Papanastasiou m). La linea ciano indica τ (Pa), quella ambra tratteggiata la viscosità apparente μ (mPa·s)."
            />
          </h3>
          <p className="text-xs text-slate-400">
            Sforzo τ (Pa) e viscosità fisica apparente μ (mPa·s) al variare di γ̇
          </p>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="text-cyan-400">― τ (Pa)</span>
          <span className="text-amber-400">- - μ (mPa·s)</span>
        </div>
      </div>

      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto block select-none cursor-crosshair"
          onPointerMove={handleSvgMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          {[0.1, 1, 10, 100, 1000].map((g) => {
            const x = curveData.mapX(g);
            return (
              <g key={g}>
                <line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke="#1e293b" strokeWidth="1" />
                <text
                  x={x}
                  y={height - 10}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="10"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {g}
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
                <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="#1e293b" strokeWidth="1" />
                <text
                  x={padL - 6}
                  y={y + 3}
                  textAnchor="end"
                  fill="#06b6d4"
                  fontSize="9.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  10^{expTau.toFixed(0)}
                </text>
                <text
                  x={padL + plotW + 6}
                  y={y + 3}
                  textAnchor="start"
                  fill="#f59e0b"
                  fontSize="9.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  10^{expMu.toFixed(0)}
                </text>
              </g>
            );
          })}

          <path d={curveData.muPath} fill="none" stroke="#f59e0b" strokeWidth="1.75" strokeDasharray="4 3" />
          <path d={curveData.tauPath} fill="none" stroke="#06b6d4" strokeWidth="2.25" />

          <circle cx={curveData.opX} cy={curveData.opYTau} r="4.5" fill="#06b6d4" stroke="#07090e" strokeWidth="1.5" />

          {activePoint && (
            <g>
              <line
                x1={curveData.mapX(activePoint.gamma)}
                y1={padT}
                x2={curveData.mapX(activePoint.gamma)}
                y2={padT + plotH}
                stroke="#64748b"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <circle
                cx={curveData.mapX(activePoint.gamma)}
                cy={curveData.mapYTau(activePoint.tau)}
                r="4"
                fill="#22d3ee"
              />
              <circle
                cx={curveData.mapX(activePoint.gamma)}
                cy={curveData.mapYMu(activePoint.muMpas)}
                r="4"
                fill="#fbbf24"
              />
            </g>
          )}

          <text
            x={padL + plotW / 2}
            y={height - 1}
            textAnchor="middle"
            fill="#64748b"
            fontSize="9.5"
            fontFamily="IBM Plex Sans, sans-serif"
          >
            Tasso di Taglio γ̇ (s⁻¹)
          </text>
        </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 font-mono text-[11px] tabular-nums text-slate-300">
        {activePoint ? (
          <>
            <span>Cursore γ̇: {activePoint.gamma.toFixed(2)} s⁻¹</span>
            <span>τ: {activePoint.tau.toFixed(3)} Pa</span>
            <span>
              μ:{' '}
              {activePoint.muMpas >= 100
                ? Math.round(activePoint.muMpas).toLocaleString('it-IT')
                : activePoint.muMpas.toFixed(3)}{' '}
              mPa·s
            </span>
          </>
        ) : (
          <>
            <span>Punto vasca γ̇̄: {curveData.clampedOpGamma.toFixed(2)} s⁻¹</span>
            <span>τ̄: {curveData.opTau.toFixed(3)} Pa</span>
            <span>
              μ_eff:{' '}
              {curveData.opMu >= 100
                ? Math.round(curveData.opMu).toLocaleString('it-IT')
                : curveData.opMu.toFixed(3)}{' '}
              mPa·s
            </span>
          </>
        )}
      </div>
    </div>
  );
};

export default RheologyChart;
