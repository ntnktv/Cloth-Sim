// Small presentation helpers for the minimal layout. No simulation logic here.
const status = document.getElementById('status');
let hideTimer = 0;
new MutationObserver(() => {
  const empty = !status.textContent.trim();
  status.classList.toggle('show', !empty);
  clearTimeout(hideTimer);
  if (!empty) hideTimer = setTimeout(() => status.classList.remove('show'), 4500);
}).observe(status, { childList: true, characterData: true, subtree: true });

const menus = [...document.querySelectorAll('details.export')];
document.addEventListener('pointerdown', e => {
  for (const menu of menus) if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') for (const menu of menus) menu.open = false;
});
for (const id of ['svg', 'png', 'saveProject', 'openProject', 'newProject'])
  document.getElementById(id).addEventListener('click', e => { e.target.closest('details').open = false; });
