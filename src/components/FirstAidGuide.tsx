import React from 'react';
import {GoldenHourGuide} from '../../components/GoldenHourGuide';
import type {
  EmergencyId,
  EmergencyProtocol,
  Language,
} from '../types/emergency';

interface Props {
  protocol: EmergencyProtocol;
  allProtocols?: EmergencyProtocol[];
  lang: Language;
  voiceOnly: boolean;
  isOnline: boolean;
  helperNote?: string;
  queryText?: string;
  predictedConfidence?: number;
  modelVersion?: string;
  skipInitialAutoSpeak?: boolean;
  onBackHome: () => void;
  onOpenCprCoach: () => void;
  onSwitchProtocol?: (id: EmergencyId) => void;
}

export const FirstAidGuide: React.FC<Props> = (props) => {
  return <GoldenHourGuide {...props} />;
};
