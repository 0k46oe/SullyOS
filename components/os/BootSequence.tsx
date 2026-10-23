import React from 'react';
import type { OSTheme } from '../../types';
import ClassicBootSequence from './ClassicBootSequence';

interface Props {
  dataReady: boolean;
  wallpaper?: string;
  style?: OSTheme['bootAnimationStyle'];
  onDone: () => void;
}
export default function BootSequence({dataReady, wallpaper, onDone}: Props) {
  return <ClassicBootSequence dataReady={dataReady} wallpaper={wallpaper} onDone={onDone} />;
}
