// On HTTP LAN addresses the native API is usually absent. NoSleep's silent
// inline media gives those browsers a second way to keep the display awake.
export function screenKeeper(button) {
  const native = window.isSecureContext && navigator.wakeLock;
  let piloting = false, manual = false, lock = null, video = null, pending = false;
  let generation = 0;
  const wanted = () => (piloting || manual) && !document.hidden;
  function label(text) {
    button.textContent = text;
    button.hidden = !native && !piloting;
  }
  function media() {
    if (video) return video;
    video = document.createElement('video');
    video.className = 'standby-media';
    video.setAttribute('aria-hidden', 'true');
    video.playsInline = true;
    video.loop = true;
    video.disablePictureInPicture = true;
    for (const type of ['webm', 'mp4']) {
      const source = document.createElement('source');
      source.type = 'video/' + type;
      source.src = new URL('./vendor/nosleep/standby.' + type, import.meta.url);
      video.append(source);
    }
    video.addEventListener('timeupdate', () => {
      if (video.duration > 1 && video.currentTime > 0.55) video.currentTime = 0.1;
    });
    document.body.append(video);
    return video;
  }
  async function acquire() {
    if (!wanted() || pending || lock || (video && !video.paused)) return;
    const version = generation;
    pending = true;
    try {
      if (native) {
        const next = await native.request('screen');
        if (version !== generation || !wanted()) { await next.release(); return; }
        lock = next;
        next.addEventListener('release', () => {
          if (lock !== next) return;
          lock = null;
          label('Не гасить экран');
        });
        label('Экран включён');
      } else {
        await media().play();
        if (version !== generation || !wanted()) { video.pause(); return; }
        label('Защита от сна включена');
      }
    } catch {
      if (wanted()) label('Не гасить экран · нажми для повтора');
    } finally {
      pending = false;
      if (version !== generation && wanted()) acquire();
    }
  }
  function sync() {
    generation++;
    if (wanted()) { acquire(); return; }
    const old = lock;
    lock = null;
    old?.release().catch(() => {});
    video?.pause();
    label('Не гасить экран');
  }
  // On phones media playback can require a completed tap. The first arrow
  // both moves the probe and retries playback within that same user gesture.
  document.addEventListener('click', acquire, true);
  document.addEventListener('touchend', acquire, { passive: true, capture: true });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pagehide', () => { manual = piloting = false; sync(); });
  button.onclick = () => { if (!piloting) manual = true; acquire(); };
  label('Не гасить экран');
  return {
    get piloting() { return piloting; },
    setPiloting(value) { piloting = value; label('Не гасить экран'); sync(); },
  };
}
