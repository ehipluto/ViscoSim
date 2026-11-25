import React from 'react';
import { formatViscosityDisplay } from '../constants/fluids';
import { SimulationMetrics } from '../types/rheology';
import InfoTooltip from './InfoTooltip';

interface TelemetryGridProps {
  metrics: SimulationMetrics;
  enableSmagorinsky: boolean;
}

const REGIME_STYLES: Record<
  SimulationMetrics['regime'],
  { glyph: string; className: string }
> = {
  Fermo: { glyph: '○', className: 'text-slate-400' },
  'Stokes / Creeping': { glyph: '●', className: 'text-sky-400' },
  Laminare: { glyph: '●', className: 'text-emerald-400' },
  Transizione: { glyph: '▲', className: 'text-amber-400' },
  Turbolento: { glyph: '■', className: 'text-rose-400' },
};

const TelemetryGrid: React.FC<TelemetryGridProps> = ({ metrics, enableSmagorinsky }) => {
  const regimeBadge = REGIME_STYLES[metrics.regime];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
      <div className="bg-[#0F141D] border border-slate-800 rounded-lg p-3.5">
        <div className="text-[11px] text-slate-400 flex items-center justify-between gap-1">
          <span>Num. Reynolds</span>
          <InfoTooltip
            title="Numero di Reynolds (Re)"
            description="Definito come Re = ρ·|u|_max·d / μ_app_media (con lunghezza caratteristica d = diametro asta). Vale 0 a fluido fermo; i regimi riportati sono indicativi e non rappresentano turbolenza 3D risolta."
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
          <span>Visc. Apparente</span>
          <InfoTooltip
            title="Viscosità Fisica Apparente Media"
            description="Media spaziale della viscosità molecolare apparente μ_app(γ̇). Resta sempre separata dall’eventuale viscosità numerica di sottogriglia μ_sgs."
          />
        </div>
        <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
          {formatViscosityDisplay(metrics.effectiveViscosityMpas)}
        </div>
        <div className="mt-1 text-[11px] font-mono text-slate-400 truncate">
          {enableSmagorinsky
            ? `mPa·s (+μ_sgs ${formatViscosityDisplay(metrics.sgsMeanViscosityMpas)})`
            : 'mPa·s'}
        </div>
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
            description="Sforzo tangenziale fisico massimo τ = μ_app · γ̇ (in Pascal) calcolato esclusivamente con la viscosità fisica apparente."
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
            description="Misura quanto il tracciante passivo si è mescolato nello spazio (indice di Danckwerts): 0% fluido non mescolato, 100% miscelazione completa."
          />
        </div>
        <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-emerald-400">
          {metrics.mixingIndex.toFixed(1)}
        </div>
        <div className="mt-1 text-[11px] font-mono text-slate-400">% Danckwerts</div>
      </div>
    </div>
  );
};

export default TelemetryGrid;
