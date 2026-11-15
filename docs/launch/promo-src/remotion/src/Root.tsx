import React from 'react';
import {Composition} from 'remotion';
import {Promo, SCENES, PromoPublic, PUBLIC_SCENES} from './Promo';
import {Launch, LAUNCH_FRAMES} from './v2/Launch';
import {Agent, AGENT_FRAMES} from './v2/Agent';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="MiraPromo" component={Promo} durationInFrames={Math.round(SCENES.reduce((a, b) => a + b, 0) * 30) - 9 * 6} fps={30} width={1920} height={1080} />
    <Composition id="MiraPromoPublic" component={PromoPublic} durationInFrames={Math.round(PUBLIC_SCENES.reduce((a, b) => a + b, 0) * 30) - 8 * 6} fps={30} width={1920} height={1080} />
    <Composition id="MiraPromoVertical" component={PromoPublic} durationInFrames={Math.round(PUBLIC_SCENES.reduce((a, b) => a + b, 0) * 30) - 8 * 6} fps={30} width={1080} height={1920} />
    <Composition id="MiraLaunch" component={Launch} durationInFrames={LAUNCH_FRAMES} fps={30} width={1920} height={1080} />
    <Composition id="MiraAgent" component={Agent} durationInFrames={AGENT_FRAMES} fps={30} width={1920} height={1080} />
  </>
);
