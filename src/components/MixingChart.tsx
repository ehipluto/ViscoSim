import React from 'react';
import { TimeSeriesPoint } from '../types/rheology';
import InfoTooltip from './InfoTooltip';
import { copy, formatReading, type Language } from '../locale';

interface MixingChartProps {
  language: Language;
  history: TimeSeriesPoint[];
}

const MixingChart: React.FC<MixingChartProps> = ({ language, history }) => {
  const t = copy[language];
  const width = 520;
  const height = 175;
  const padL = 44;
  const padR = 44;
  const padT = 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const hasData = history.length > 1 && history.at(-1)!.timeSec > history[0].timeSec;
  const maxKe = hasData
    ? Math.max(10, ...history.map((h) => h.kineticEnergyMjKg))
    : 50;

  const startTime = history[0]?.timeSec ?? 0;
  const duration = (history.at(-1)?.timeSec ?? startTime) - startTime;

  const kePath = hasData
    ? history
        .map((pt, i) => {
          const x = padL + ((pt.timeSec - startTime) / duration) * plotW;
          const y = padT + plotH - (Math.min(maxKe, Math.max(0, pt.kineticEnergyMjKg)) / maxKe) * plotH;
          return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ')
    : '';

  const latest = hasData ? history[history.length - 1] : null;

  return (
    <div className="lab-panel lab-chart">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="inline-flex items-center gap-1.5">
            {t.motionChart}
            <InfoTooltip
              language={language}
              title={t.energy}
              description={t.energyHelp}
            />
          </h3>
          <p className="text-xs text-slate-400">{t.energyDescription}</p>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="lab-chart-violet">― Ek (mJ/kg)</span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block" role="img" aria-label={t.energyDescription}>
        {[0, 0.5, 1].map((f) => {
          const y = padT + f * plotH;
          const keVal = formatReading(language, (1 - f) * maxKe, 0);
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--lab-chart-grid)" strokeWidth="1" />
              <text
                x={padL + plotW + 6}
                y={y + 3}
                textAnchor="start"
                fill="var(--lab-chart-violet)"
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
            <path d={kePath} fill="none" stroke="var(--lab-chart-violet)" strokeWidth="1.5" opacity="0.85" />
          </>
        )}

        <text
          x={padL + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          fill="var(--lab-muted)"
          fontSize="9.5"
          fontFamily="DM Sans, sans-serif"
        >
          {hasData ? t.sampleWindow + ' · ' + formatReading(language, duration, 1) + ' s' : t.noSamples}
        </text>
      </svg>

      <div className="flex items-center justify-between pt-2 lab-chart-caption font-mono tabular-nums">
        <span>{t.energy}: {formatReading(language, latest?.kineticEnergyMjKg ?? 0, 2)} mJ/kg</span>
      </div>
    </div>
  );
};

export default MixingChart;
