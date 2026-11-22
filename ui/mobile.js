(() => {
  const phone = matchMedia('(pointer: coarse) and (max-width: 950px)');
  function mount() {
    if (!phone.matches || document.querySelector('#mobile-home')) return;
    const home = document.querySelector('#screen-home');
    const view = document.createElement('section');
    view.id = 'mobile-home';
    view.innerHTML = '<header><strong>Xuper</strong><button type="button">Menú completo</button></header><p role="status"></p><input type="search" placeholder="Buscar en el catálogo" aria-label="Buscar en el catálogo"><div class="mobile-grid"></div><button class="more" type="button">Ver más</button>';
    home.appendChild(view);
    const menu = document.createElement('button');
    menu.id = 'mobile-return';
    menu.textContent = 'Volver al catálogo';
    home.appendChild(menu);
    view.querySelector('header button').onclick = () => home.classList.add('mobile-menu');
    menu.onclick = () => home.classList.remove('mobile-menu');
    const input = view.querySelector('input');
    const grid = view.querySelector('.mobile-grid');
    const more = view.querySelector('.more');
    let count = 36, previous;
    function draw() {
      const app = window.__xuper;
      if (!app) return;
      previous = app.vod;
      const query = input.value.trim().toLocaleLowerCase();
      const items = previous.map((item,index)=>({item,index})).filter(({item})=>
        String(item.title || '').toLocaleLowerCase().includes(query));
      grid.replaceChildren();
      items.slice(0,count).forEach(({item,index})=>{
        const card = document.createElement('button');
        const img = document.createElement('img');
        img.alt = ''; img.loading = 'lazy';
        if (item.poster) img.src = item.poster;
        const title = document.createElement('span');
        title.textContent = item.title;
        card.append(img,title);
        card.onclick = () => app.openDetail(index);
        grid.appendChild(card);
      });
      if (!items.length) grid.textContent = 'Sin resultados';
      more.hidden = items.length <= count;
    }
    input.oninput = () => { count = 36; draw(); };
    document.addEventListener('xuper:catalog-updated', draw);
    document.addEventListener('DOMContentLoaded', draw);
    more.onclick = () => { count += 36; draw(); };
    const status = view.querySelector('[role=status]');
    const source = document.querySelector('#credit-status');
    new MutationObserver(()=>{status.textContent = source.textContent; if (previous !== window.__xuper?.vod) draw();})
      .observe(source,{childList:true,subtree:true,characterData:true});
    status.textContent = source.textContent;
    draw();
  }
  mount();
  phone.addEventListener?.('change',mount);
})();
