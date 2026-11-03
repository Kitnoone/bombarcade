// Keep scrolling and pinch zoom, but never interpret two quick console taps as zoom.
// The ancestor CSS covers disabled keys and gaps too. This non-passive fallback
// handles touch browsers which still synthesize double-tap zoom in those areas.
export function preventDoubleTapZoom(surface) {
  let lastTap, start, multiTouch = false;
  surface.addEventListener('touchstart', event => {
    if (event.touches.length > 1) { multiTouch = true; lastTap = undefined; }
    const touch = event.touches[0];
    start = touch ? { x: touch.clientX, y: touch.clientY } : undefined;
  }, { passive: true });
  surface.addEventListener('touchend', event => {
    if (multiTouch || event.touches.length || event.changedTouches.length !== 1) {
      if (!event.touches.length) multiTouch = false;
      lastTap = undefined; return;
    }
    const touch = event.changedTouches[0];
    const tap = { x: touch.clientX, y: touch.clientY, at: performance.now() };
    if (!start || Math.hypot(tap.x - start.x, tap.y - start.y) > 12) { lastTap = undefined; return; }
    if (lastTap && tap.at - lastTap.at < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 48) event.preventDefault();
    lastTap = tap;
  }, { passive: false });
  surface.addEventListener('touchcancel', () => { lastTap = start = undefined; multiTouch = false; }, { passive: true });
  surface.addEventListener('dblclick', event => event.preventDefault());
}
