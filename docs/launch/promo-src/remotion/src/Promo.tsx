import React from 'react';
import {AbsoluteFill, Img, interpolate, Easing, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Video} from '@remotion/media';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {M1, M2} from './marks';
import {BRAND} from './brand';

// One visual system for the whole film: warm ground, serif headlines, the real interface floating as a card.
const BG = '#F6F1EA', INK = '#2A2420', SOFT = '#8A7F75';
const SERIF = '"Noto Serif CJK SC", "Noto Serif SC", serif';
const ease = Easing.bezier(0.16, 1, 0.3, 1);

const Caption: React.FC<{text: string; sub?: string}> = ({text, sub}) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [6, 20], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease});
  const y = interpolate(f, [6, 20], [14, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease});
  const {width, height} = useVideoConfig(), portrait = height > width;
  return (
    <div style={{position: 'absolute', left: 0, right: 0, bottom: portrait ? 300 : 44, textAlign: 'center', opacity: o, transform: `translateY(${y}px)`}}>
      <div style={{fontFamily: SERIF, fontSize: portrait ? 64 : 46, fontWeight: 700, color: INK, letterSpacing: 1}}>{text}</div>
      {sub ? <div style={{fontFamily: SERIF, fontSize: 26, color: SOFT, marginTop: 10}}>{sub}</div> : null}
    </div>
  );
};

/** A stretch of the real take, floating as a card; `focus` zooms slowly toward one region of the screen (fractions of 1440×900). */
const Shot: React.FC<{src: string; from: number; rate?: number; caption: string; sub?: string; focus?: [number, number]; zoom?: number; cover?: number}> = ({src, from, rate = 1, caption, sub, focus = [0.5, 0.5], zoom = 1.06, cover = 0}) => {
  const f = useCurrentFrame(), {fps, durationInFrames, width, height} = useVideoConfig();
  const box = height > width ? {left: 60, top: 260, width: 960, height: 1160} : {left: 288, top: 52, width: 1344, height: 840};
  // A beat of the whole screen, then the camera moves in on where the thing happens and drifts a little while it plays.
  const s = interpolate(f, [0, 8, 26, durationInFrames], [1, 1, zoom, zoom * 1.04], {extrapolateRight: 'clamp', easing: Easing.bezier(0.33, 1, 0.68, 1)});
  return (
    <AbsoluteFill style={{background: BG}}>
      <div style={{position: 'absolute', ...box, borderRadius: 18, overflow: 'hidden',
        boxShadow: '0 30px 80px -30px rgba(60,40,20,.35), 0 0 0 1px rgba(60,40,20,.08)', background: '#fff'}}>
        <div style={{position: 'relative', width: '100%', height: '100%', transform: `scale(${s})`, transformOrigin: `${focus[0] * 100}% ${focus[1] * 100}%`}}>
          <Video src={staticFile(src)} trimBefore={Math.round(from * fps)} playbackRate={rate} muted style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${focus[0] * 100}% ${focus[1] * 100}%`}} />
          {cover ? <div style={{position: 'absolute', left: 0, top: 0, width: `${cover * 100}%`, height: '100%', backdropFilter: 'blur(16px)', background: 'rgba(246,241,234,.55)'}} /> : null}
        </div>
      </div>
      <Caption text={caption} sub={sub} />
    </AbsoluteFill>
  );
};

const Title: React.FC<{text: string; sub?: string; pet?: boolean; big?: boolean}> = ({text, sub, pet, big}) => {
  const f = useCurrentFrame(), {width, height} = useVideoConfig();
  // In a tall frame the headline breaks after its comma rather than wherever the width runs out.
  const shown = height > width ? text.replace('，', '，\n') : text;
  const o = interpolate(f, [0, 18], [0, 1], {extrapolateRight: 'clamp', easing: ease});
  const y = interpolate(f, [0, 18], [24, 0], {extrapolateRight: 'clamp', easing: ease});
  return (
    <AbsoluteFill style={{background: BG, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 28}}>
      {pet ? <Img src={staticFile('pet.png')} style={{width: 168, height: 168, imageRendering: 'pixelated', opacity: o, transform: `translateY(${y}px)`}} /> : null}
      <div style={{fontFamily: SERIF, fontSize: big ? 132 : 72, fontWeight: 700, color: INK, maxWidth: '86%', textAlign: 'center', lineHeight: 1.3, whiteSpace: 'pre-line', opacity: o, transform: `translateY(${y}px)`, letterSpacing: big ? 4 : 2}}>{shown}</div>
      {sub ? <div style={{fontFamily: SERIF, fontSize: 34, color: SOFT, opacity: o}}>{sub}</div> : null}
    </AbsoluteFill>
  );
};

const T = (s: number) => Math.round(s * 30);
const X = linearTiming({durationInFrames: 6});
const A = 'take1.mp4', B = 'take2.mp4';
export const SCENES = [3.2, 5, 5, 5, 5, 5, 6, 8, 4, 4];
export const Promo: React.FC = () => (
  <TransitionSeries name="Mira promo">
    <TransitionSeries.Sequence name="Open" durationInFrames={T(SCENES[0])}><Title text={BRAND.slogan} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Morning" durationInFrames={T(SCENES[1])}><Shot src={A} from={M1.inbox + 0.4} caption="早上，它已经替你想好了" sub="昨晚想到的事，等你挑" focus={[0.84, 0.18]} zoom={1.9} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Ask" durationInFrames={T(SCENES[2])}><Shot src={A} from={M1.typing} rate={1.8} caption="一句话，交代一件事" focus={[0.33, 0.72]} zoom={2.4} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Clarify" durationInFrames={T(SCENES[3])}><Shot src={B} from={M2.questions} caption="它先问清楚，再动手" sub="主色，和日期对不对" focus={[0.33, 0.98]} zoom={2.4} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Decide" durationInFrames={T(SCENES[4])}><Shot src={B} from={M2.typing} rate={1.4} caption="关键的事，你来定" focus={[0.33, 0.98]} zoom={2.4} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Parallel" durationInFrames={T(SCENES[5])}><Shot src={B} from={M2.opened - 0.5} caption="两个任务，同时在做" focus={[0.95, 0.08]} zoom={2.2} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Progress" durationInFrames={T(SCENES[6])}><Shot src={B} from={M2.board} rate={5} caption="做到哪一步，看得见" focus={[0.95, 0.4]} zoom={2.2} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Delivery" durationInFrames={T(SCENES[7])}><Shot src={B} from={M2.preview - 0.8} caption="交付的是成品" sub="网页邀请函，在面板里直接打开" focus={[0.82, 0.5]} zoom={1.7} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Accept" durationInFrames={T(SCENES[8])}><Shot src={B} from={M2.accepted - 2.2} caption="看过，验收" focus={[0.985, 0.06]} zoom={1.9} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="End" durationInFrames={T(SCENES[9])}><Title text={BRAND.cn} sub={BRAND.en !== BRAND.cn ? BRAND.en : undefined} big /></TransitionSeries.Sequence>
  </TransitionSeries>
);

export const PUBLIC_SCENES = [3.2, 5, 5, 5, 5, 6, 8, 4, 4];
export const PromoPublic: React.FC = () => (
  <TransitionSeries name="Mira promo">
    <TransitionSeries.Sequence name="Open" durationInFrames={T(PUBLIC_SCENES[0])}><Title text={BRAND.slogan} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Ask" durationInFrames={T(PUBLIC_SCENES[1])}><Shot src={A} from={M1.typing} rate={1.8} cover={0.195} caption="一句话，交代一件事" focus={[0.33, 0.72]} zoom={2.4} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Clarify" durationInFrames={T(PUBLIC_SCENES[2])}><Shot src={B} from={M2.questions} cover={0.195} caption="它先问清楚，再动手" sub="主色，和日期对不对" focus={[0.33, 0.98]} zoom={2.4} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Decide" durationInFrames={T(PUBLIC_SCENES[3])}><Shot src={B} from={M2.typing} rate={1.4} cover={0.195} caption="关键的事，你来定" focus={[0.33, 0.98]} zoom={2.4} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Parallel" durationInFrames={T(PUBLIC_SCENES[4])}><Shot src={B} from={M2.opened - 0.5} cover={0.195} caption="两个任务，同时在做" focus={[0.95, 0.08]} zoom={2.2} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Progress" durationInFrames={T(PUBLIC_SCENES[5])}><Shot src={B} from={M2.board} rate={5} cover={0.195} caption="做到哪一步，看得见" focus={[0.95, 0.4]} zoom={2.2} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Delivery" durationInFrames={T(PUBLIC_SCENES[6])}><Shot src={B} from={M2.preview - 0.8} cover={0.195} caption="交付的是成品" sub="网页邀请函，在面板里直接打开" focus={[0.82, 0.5]} zoom={1.7} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="Accept" durationInFrames={T(PUBLIC_SCENES[7])}><Shot src={B} from={M2.accepted - 2.2} cover={0.195} caption="看过，验收" focus={[0.985, 0.06]} zoom={1.9} /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={X} />
    <TransitionSeries.Sequence name="End" durationInFrames={T(PUBLIC_SCENES[8])}><Title text={BRAND.cn} sub={BRAND.en !== BRAND.cn ? BRAND.en : undefined} big /></TransitionSeries.Sequence>
  </TransitionSeries>
);
