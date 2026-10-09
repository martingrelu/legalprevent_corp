(() => {
  const links = document.querySelectorAll('.language-switch a');
  links.forEach(link => {
    const destination = new URL(link.href);
    destination.search = window.location.search;
    destination.hash = window.location.hash;
    link.href = destination.href;
  });
  links.forEach(link => link.addEventListener('click', () => {
    try { localStorage.setItem('lp_lang', link.lang); } catch {}
  }));
  let preferred;
  try { preferred = localStorage.getItem('lp_lang'); } catch {}
  const target = [...links].find(link=>link.lang===preferred);
  if (!target || preferred === document.documentElement.lang) return;
  const notice = document.createElement('aside');
  notice.className = 'language-notice';
  const link = document.createElement('a');
  link.href = target.href;
  link.textContent = preferred === 'en' ? 'This page is also available in English →' : 'Esta página también está disponible en español →';
  link.lang = preferred;
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = '×';
  close.setAttribute('aria-label', preferred === 'en' ? 'Dismiss' : 'Cerrar');
  close.addEventListener('click',()=>notice.remove());
  notice.append(link,close); document.body.append(notice);
})();
