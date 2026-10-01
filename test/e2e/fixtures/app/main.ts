document.documentElement.dataset.version = __APP_VERSION__;
document.getElementById('version')!.textContent = __APP_VERSION__;

const view = document.getElementById('view')!;

// The lazy chunk is what breaks in a tab opened before a deploy.
document.getElementById('open')!.addEventListener('click', async () => {
  try {
    const settings = await import('./settings');
    view.textContent = settings.render();
  } catch (error) {
    view.innerHTML = `<span class="error">💥 ${(error as Error).message}</span>`;
  }
});
