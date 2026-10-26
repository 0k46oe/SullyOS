import React, { useState } from 'react';
import type { NavigationBallAppearance } from '../../utils/navigationBallAppearance';
import './NavigationBall.css';

/** Used by both the actual ball and its settings preview. No remote image URLs. */
export default function NavigationBallFace({ appearance }: { appearance: NavigationBallAppearance }) {
  const [failedImage, setFailedImage] = useState('');
  return appearance.image && failedImage !== appearance.image
    ? <img className="navigation-ball-custom-image" src={appearance.image} alt="" draggable={false} onError={() => setFailedImage(appearance.image)} />
    : <span aria-hidden="true" />;
}
