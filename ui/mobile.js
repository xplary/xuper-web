(() => {
  const phone = matchMedia('(pointer: coarse) and (max-width: 950px)');
  function mount() {
    if (!phone.matches || document.querySelector('#mobile-home')) return;
    const home = document.querySelector('#screen-home');
    const view = document.createElement('section');
    view.id = 'mobile-home';
    view.innerHTML = '<header><strong>Xuper</strong><button type="button">Menú completo</button></header><p role="status"></p><button class="mobile-feature" type="button"><img alt=""><b></b></button><input type="search" placeholder="Buscar una película o serie" aria-label="Buscar en el catálogo"><nav aria-label="Tipo de contenido"></nav><div class="mobile-total"></div><div class="mobile-grid"></div>';
    home.appendChild(view);
    const menu = document.createElement('button');
    menu.id = 'mobile-return';
    menu.textContent = 'Volver al catálogo';
    home.appendChild(menu);
    view.querySelector('header button').onclick = () => home.classList.add('mobile-menu');
    menu.onclick = () => home.classList.remove('mobile-menu');
    const input = view.querySelector('input');
    const grid = view.querySelector('.mobile-grid');
    let filter = 'Todo', previous;
    const feature = view.querySelector('.mobile-feature');
    for (const label of ['Todo','Películas','Series']) {
      const tab = document.createElement('button');
      tab.textContent = label;
      tab.onclick = () => { filter = label; draw(); };
      view.querySelector('nav').appendChild(tab);
    }
    function draw() {
      const app = window.__xuper;
      if (!app) return;
      previous = app.vod;
      const query = input.value.trim().toLocaleLowerCase();
      const items = previous.map((item,index)=>({item,index})).filter(({item})=>
        String(item.title || '').toLocaleLowerCase().includes(query) &&
        (filter === 'Todo' || (item.kind === 'serie') === (filter === 'Series')));
      view.querySelectorAll('nav button').forEach(tab=>tab.setAttribute('aria-pressed',String(tab.textContent === filter)));
      const pick = !query && items.find(({item})=>item.backdrop || item.landscape);
      feature.hidden = !pick;
      if (pick) {
        feature.querySelector('img').src = pick.item.backdrop || pick.item.landscape;
        feature.querySelector('b').textContent = pick.item.title;
        feature.onclick = () => app.openDetail(pick.index);
      }
      view.querySelector('.mobile-total').textContent = items.length + (items.length === 1 ? ' título' : ' títulos');
      const cards = document.createDocumentFragment();
      items.forEach(({item,index})=>{
        const card = document.createElement('button');
        const img = document.createElement('img');
        img.alt = ''; img.loading = 'lazy';
        const art = item.poster || item.backdrop || item.landscape;
        if (art) img.src = art;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        const title = document.createElement('span');
        title.textContent = item.title;
        card.append(img,title);
        card.onclick = () => app.openDetail(index);
        cards.appendChild(card);
      });
      grid.replaceChildren(cards);
      if (!items.length) grid.textContent = 'Sin resultados';
    }
    input.oninput = draw;
    document.addEventListener('xuper:catalog-updated', draw);
    document.addEventListener('DOMContentLoaded', draw);
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
