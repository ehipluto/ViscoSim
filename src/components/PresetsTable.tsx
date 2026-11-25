import React from 'react';
import { FLUID_PRESETS, formatViscosityDisplay } from '../constants/fluids';
import { FluidPreset, RheologyModel } from '../types/rheology';

interface PresetsTableProps {
  activePresetId: string | null;
  onSelectPreset: (preset: FluidPreset) => void;
}

const MODEL_LABELS: Record<RheologyModel, string> = {
  newtonian: 'Newtoniano',
  'power-law': 'Power-Law',
  'herschel-bulkley': 'Herschel-Bulkley',
};

const PresetsTable: React.FC<PresetsTableProps> = ({ activePresetId, onSelectPreset }) => {
  return (
    <section id="riferimenti" className="bg-[#0F141D] border border-slate-800 rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Tabella Comparativa Fluidi Industriali
          </h2>
          <p className="text-xs text-slate-400">
            Seleziona una riga per caricare i parametri reologici calibrati come punto di partenza modificabile.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="py-2.5 pr-4 font-medium">Fluido</th>
              <th className="py-2.5 px-3 font-medium">Classe Reologica</th>
              <th className="py-2.5 px-3 font-medium text-right">K / μ (mPa·s)</th>
              <th className="py-2.5 px-3 font-medium text-right">Indice n</th>
              <th className="py-2.5 px-3 font-medium text-right">τy (Pa)</th>
              <th className="py-2.5 pl-3 font-medium text-right">ρ (kg/m³)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
            {FLUID_PRESETS.map((preset) => {
              const selected = activePresetId === preset.id;
              return (
                <tr
                  key={preset.id}
                  onClick={() => onSelectPreset(preset)}
                  className={`cursor-pointer transition-colors ${
                    selected ? 'bg-cyan-500/10 text-cyan-200' : 'hover:bg-slate-800/40 text-slate-200'
                  }`}
                >
                  <td className="py-2.5 pr-4 font-sans font-medium whitespace-nowrap">
                    {preset.name}
                  </td>
                  <td className="py-2.5 px-3 font-sans text-slate-400 whitespace-nowrap">
                    {MODEL_LABELS[preset.model]} · {preset.category}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {formatViscosityDisplay(preset.viscosityMpas)}
                  </td>
                  <td className="py-2.5 px-3 text-right">{preset.flowIndex.toFixed(2)}</td>
                  <td className="py-2.5 px-3 text-right">{preset.yieldStressPa}</td>
                  <td className="py-2.5 pl-3 text-right">{preset.densityKgM3}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default PresetsTable;
