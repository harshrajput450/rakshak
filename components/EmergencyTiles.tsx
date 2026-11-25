import React from 'react';
import {
  Activity,
  AlertTriangle,
  Bone,
  Brain,
  Droplet,
  Droplets,
  Flame,
  Gauge,
  HeartCrack,
  HeartPulse,
  PawPrint,
  ShieldAlert,
  Siren,
  Skull,
  Sun,
  UserMinus,
  Waves,
  Wind,
  Zap,
} from 'lucide-react';
import type {
  EmergencyId,
  EmergencyProtocol,
  Language,
} from '../src/types/emergency';

interface Props {
  lang: Language;
  protocols: EmergencyProtocol[];
  onSelectProtocol: (id: EmergencyId) => void;
}

function renderEmergencyIcon(iconName: string, isCritical: boolean) {
  const cls = `h-6 w-6 shrink-0 ${
    isCritical ? 'text-[#DC2626]' : 'text-[#0F1E36]'
  }`;
  switch (iconName) {
    case 'heart-pulse':
      return <HeartPulse className={cls} aria-hidden="true" />;
    case 'wind':
      return <Wind className={cls} aria-hidden="true" />;
    case 'droplets':
      return <Droplets className={cls} aria-hidden="true" />;
    case 'activity':
      return <Activity className={cls} aria-hidden="true" />;
    case 'flame':
      return <Flame className={cls} aria-hidden="true" />;
    case 'alert-triangle':
      return <AlertTriangle className={cls} aria-hidden="true" />;
    case 'heart-crack':
      return <HeartCrack className={cls} aria-hidden="true" />;
    case 'brain':
      return <Brain className={cls} aria-hidden="true" />;
    case 'user-minus':
      return <UserMinus className={cls} aria-hidden="true" />;
    case 'bone':
      return <Bone className={cls} aria-hidden="true" />;
    case 'shield-alert':
      return <ShieldAlert className={cls} aria-hidden="true" />;
    case 'waves':
      return <Waves className={cls} aria-hidden="true" />;
    case 'zap':
      return <Zap className={cls} aria-hidden="true" />;
    case 'skull':
      return <Skull className={cls} aria-hidden="true" />;
    case 'sun':
      return <Sun className={cls} aria-hidden="true" />;
    case 'lungs':
      return <Wind className={cls} aria-hidden="true" />;
    case 'siren':
      return <Siren className={cls} aria-hidden="true" />;
    case 'paw-print':
      return <PawPrint className={cls} aria-hidden="true" />;
    case 'droplet':
      return <Droplet className={cls} aria-hidden="true" />;
    case 'gauge':
      return <Gauge className={cls} aria-hidden="true" />;
    default:
      return <ShieldAlert className={cls} aria-hidden="true" />;
  }
}

export const EmergencyTiles: React.FC<Props> = ({
  lang,
  protocols,
  onSelectProtocol,
}) => {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {protocols.map((p) => {
          const isCritical = p.urgency === 'critical';
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelectProtocol(p.id)}
              className={`group flex min-h-[84px] items-start gap-3.5 rounded-2xl border p-4 text-left shadow-xs transition-all hover:shadow-md active:scale-[0.99] ${
                isCritical
                  ? 'border-red-200 bg-white hover:border-[#DC2626] hover:bg-red-50/40'
                  : 'border-slate-200 bg-white hover:border-[#0F1E36] hover:bg-slate-50'
              }`}
            >
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                  isCritical ? 'bg-red-50' : 'bg-slate-100'
                }`}
              >
                {renderEmergencyIcon(p.icon, isCritical)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-base text-[#0F1E36] leading-snug">
                    {p.shortLabel[lang]}
                  </span>
                </div>
                <p className="mt-0.5 text-xs font-medium text-slate-600 line-clamp-2">
                  {p.subtitle[lang]}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
