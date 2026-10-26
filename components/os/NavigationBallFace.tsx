import React, { useState } from 'react';
import type { NavigationBallAppearance } from '../../utils/navigationBallAppearance';
import { clawdFallbackUrl, clawdImageUrl, useNavigationPetForm, useNavigationPetPreferences } from '../../utils/navigationBallPet';
import './NavigationBall.css';

/** Custom uploads stay local; Clawd uses only the pinned public asset directory. */
export default function NavigationBallFace({ appearance }: { appearance: NavigationBallAppearance }) {
  const pet = useNavigationPetPreferences();
  const automatic = useNavigationPetForm();
  const [failure, setFailure] = useState({ source: '', stage: 0 });
  const form = pet.selection === 'auto' ? automatic : pet.selection;
  const source = pet.enabled ? clawdImageUrl(form) : appearance.image;
  const stage = failure.source === source ? failure.stage : 0;
  const displayed = stage === 0 ? source : pet.enabled && stage === 1 ? clawdFallbackUrl(form) : '';
  return displayed
    ? <img className="navigation-ball-custom-image" data-pet={pet.enabled} src={displayed} referrerPolicy="no-referrer" alt="" draggable={false} onError={() => setFailure({ source, stage: stage + 1 })} />
    : <span className={source ? 'navigation-ball-image-fallback' : undefined} aria-hidden="true" />;
}
