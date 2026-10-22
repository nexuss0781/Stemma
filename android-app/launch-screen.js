(() => {
  const screen = document.getElementById('stemma-launch-screen');
  if (!screen) return;
  const video = screen.querySelector('video');
  let closed = false;
  let timer;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    video.pause();
    screen.remove();
  }
  // This is decorative, never a dependency of auth, networking, or app startup.
  // Play once per main-document launch, not on resume or on system-app pages.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    timer = setTimeout(close, 150);
    return;
  }
  video.addEventListener('ended', close, { once: true });
  video.addEventListener('error', close, { once: true });
  timer = setTimeout(close, 4500);
  video.play().catch(close);
})();
