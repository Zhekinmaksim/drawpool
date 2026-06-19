/* Tweaks panel for DrawPool. React powers only this overlay;
   on every change it calls window.applyTweaks(t) to drive the
   vanilla app (intensity, motion, optional readouts). */
const { useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "intensity": "calm",
  "sound": true,
  "yieldTicker": false,
  "fairBlock": false,
  "reduceMotion": false
}/*EDITMODE-END*/;

function DrawPoolTweaks() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  useEffect(() => { if (window.applyTweaks) window.applyTweaks(t); }, [t]);
  return (
    <TweaksPanel>
      <TweakSection label="Gambling energy" />
      <TweakRadio label="Intensity" value={t.intensity}
        options={["calm", "balanced", "hype"]}
        onChange={(v) => setTweak("intensity", v)} />
      <p style={{ margin: "0 0 2px", fontSize: 10.5, lineHeight: 1.45, color: "rgba(41,38,27,.5)" }}>
        calm = restrained DeFi · hype = slot-machine pulse, faster reel, bigger win.
      </p>
      <TweakSection label="Readouts" />
      <TweakToggle label="Draw sound" value={t.sound}
        onChange={(v) => setTweak("sound", v)} />
      <TweakToggle label="Live yield ticker" value={t.yieldTicker}
        onChange={(v) => setTweak("yieldTicker", v)} />
      <TweakToggle label="“Provably fair” block" value={t.fairBlock}
        onChange={(v) => setTweak("fairBlock", v)} />
      <TweakSection label="Accessibility" />
      <TweakToggle label="Reduce motion" value={t.reduceMotion}
        onChange={(v) => setTweak("reduceMotion", v)} />
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById("tweaks-root")).render(<DrawPoolTweaks />);
window.__DRAWPOOL_TWEAKS_BOOTED = true;
