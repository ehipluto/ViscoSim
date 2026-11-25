import React from 'react';
import { TimeSeriesPoint } from '../types/rheology';
import InfoTooltip from './InfoTooltip';

interface MixingChartProps {
  history: TimeSeriesPoint[];
}

const MixingChart: React.FC<MixingChartProps> = ({ history }) => {
  const width = 520;
  const height = 175;
  const padL = 44;
  const padR = 44;
  const padT = 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const hasData = history.length > 1;
  const maxKe = hasData
    ? Math.max(10, ...history.map((h) => h.kineticEnergyMjKg))
    : 50;

  const mixPath = hasData
    ? history
        .map((pt, i) => {
          const x = padL + (i / (history.length - 1)) * plotW;
          const y = padT + plotH - (Math.min(100, Math.max(0, pt.mixingIndex)) / 100) * plotH;
          return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ')
    : '';

  const kePath = hasData
    ? history
        .map((pt, i) => {
          const x = padL + (i / (history.length - 1)) * plotW;
          const y = padT + plotH - (Math.min(maxKe, Math.max(0, pt.kineticEnergyMjKg)) / maxKe) * plotH;
          return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ')
    : '';

  const latest = hasData ? history[history.length - 1] : null;

  return (
    <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-1.5">
            Cinetica di Miscelazione &amp; Energia
            <InfoTooltip
              title="Come leggere Cinetica & Energia"
              description="La linea verde M(%) misura nel tempo quanto il fluido si è mescolato (100% = uniforme). La linea ciano Ek mostra l’energia di movimento residua: nei fluidi densi crolla subito appena smetti di mescolare."
            />
          </h3>
          <p className="text-xs text-slate-400">Omogeneità Danckwerts M(t) ed energia cinetica specifica</p>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="text-emerald-400">― M (%)</span>
          <span className="text-cyan-400">― Ek (mJ/kg)</span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block">
        {[0, 0.5, 1].map((f) => {
          const y = padT + f * plotH;
          const mixVal = Math.round((1 - f) * 100);
          const keVal = ((1 - f) * maxKe).toFixed(0);
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="#1e293b" strokeWidth="1" />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fill="#34d399"
                fontSize="9.5"
                fontFamily="IBM Plex Mono, monospace"
              >
                {mixVal}%
              </text>
              <text
                x={padL + plotW + 6}
                y={y + 3}
                textAnchor="start"
                fill="#06b6d4"
                fontSize="9.5"
                fontFamily="IBM Plex Mono, monospace"
              >
                {keVal}
              </text>
            </g>
          );
        })}

        {hasData && (
          <>
            <path d={kePath} fill="none" stroke="#06b6d4" strokeWidth="1.5" opacity="0.85" />
            <path d={mixPath} fill="none" stroke="#34d399" strokeWidth="2" />
          </>
        )}

        <text
          x={padL + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          fill="#64748b"
          fontSize="9.5"
          fontFamily="IBM Plex Sans, sans-serif"
        >
          Finestra Temporale Campione (ultimi {history.length > 0 ? Math.round(history[history.length - 1].timeSec - history[0].timeSec) : 0} s)
        </text>
      </svg>

      <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 font-mono text-[11px] tabular-nums text-slate-300">
        <span>Omogeneità: {latest ? latest.mixingIndex.toFixed(1) : '0.0'} %</span>
        <span>Energia Ek: {latest ? latest.kineticEnergyMjKg.toFixed(2) : '0.00'} mJ/kg</span>
      </div>
    </div>
  );
};

export default MixingChart;
