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
    const cardCache = new WeakMap();
    let renderedItems = [];
    const shelves = document.createElement('div');
    shelves.className = 'mobile-shelves';
    view.insertBefore(shelves,view.querySelector('.mobile-total'));
    let filter = 'Todo', previous;
    let search, timer;
    const more = document.createElement('button');
    view.appendChild(more);
    function nextPage() {
      const current = search;
      if (!current || current.busy || current.done) return;
      current.busy = true;
      current.error = false;
      draw();
      window.__xuper.service('search',{value:current.query,pageNum:current.page,pageSize:50},(error,data)=>{
        if (search !== current) return;
        current.busy = false;
        current.error = !!error || !Array.isArray(data?.items);
        if (!current.error) {
          for (const raw of data.items) current.items.push(window.__xuper.catalogTools.normalize(raw,current.items.length+1));
          current.page++;
          current.done = data.items.length < 50 || (Number(data.total)>0 && current.items.length>=Number(data.total));
        }
        draw();
        requestAnimationFrame(loadVisible);
      });
    }
    function loadVisible() {
      if (search && !search.error && !search.busy && !search.done && search.page>1 &&
          view.scrollTop + view.clientHeight >= view.scrollHeight - 350) nextPage();
    }
    more.onclick = nextPage;
    view.addEventListener('scroll',loadVisible,{passive:true});
    const feature = view.querySelector('.mobile-feature');
    for (const label of ['Todo','Películas','Series','Infantil','Anime','TV en vivo']) {
      const tab = document.createElement('button');
      tab.textContent = label;
      tab.onclick = () => { filter = label; input.oninput(); };
      view.querySelector('nav').appendChild(tab);
    }
    function draw() {
      const app = window.__xuper;
      if (!app) return;
      previous = app.vod;
      const tools = app.catalogTools;
      const query = tools.text(input.value.trim());
      const live = filter === 'TV en vivo';
      const local = live ? app.channels.filter(ch=>tools.text(ch.name || '').includes(query)) :
        tools.section(filter).filter(item=>!query || tools.text(item.title).includes(query) || tools.text(item.alias || '').includes(query));
      const merged = new Map(local.map(item=>[String(item.id),item]));
      for (const item of search?.items || []) {
        if (filter !== 'Todo' && tools.isSeries(item) !== (filter === 'Series')) continue;
        if (!merged.has(String(item.id))) merged.set(String(item.id),item);
      }
      const items = live ? local : Array.from(merged.values());
      view.querySelectorAll('nav button').forEach(tab=>tab.setAttribute('aria-pressed',String(tab.textContent === filter)));
      const pick = !query && !live && items.find(item=>item.backdrop || item.landscape);
      feature.hidden = !pick;
      if (pick) {
        feature.querySelector('img').src = pick.backdrop || pick.landscape;
        feature.querySelector('b').textContent = pick.title;
        feature.onclick = () => tools.open(pick);
      }
      shelves.replaceChildren();
      if (!query && filter === 'Todo') {
        for (const [name,list] of [['Top 10 películas',tools.topMovies()],['Top 10 series',tools.topSeries()],['Recién agregados',tools.newest(10)]]) {
          if (!list.length) continue;
          const heading = document.createElement('h2');
          heading.textContent = name;
          const rail = document.createElement('div');
          rail.className = 'mobile-rail';
          list.slice(0,10).forEach((item,i)=>{
            const button = document.createElement('button');
            const art = document.createElement('img');
            art.loading = 'lazy'; art.alt = '';
            if (item.poster) art.src = item.poster;
            button.append(art,(name.startsWith('Top') ? (i+1)+'. ' : '')+item.title);
            button.onclick = ()=>tools.open(item);
            rail.append(button);
          });
          shelves.append(heading,rail);
        }
      }
      view.querySelector('.mobile-total').textContent = items.length + (live ? ' canales' : ' títulos');
      more.hidden = !search || search.done;
      more.disabled = !!search?.busy;
      more.textContent = search?.busy ? 'Buscando…' : search?.error ? 'Reintentar búsqueda' : 'Cargar más resultados';
      if (items.length && items.length === renderedItems.length && items.every((item,i)=>item===renderedItems[i])) return;
      renderedItems = items;
      const cards = document.createDocumentFragment();
      items.forEach(item=>{
        if (cardCache.has(item)) { cards.appendChild(cardCache.get(item)); return; }
        const card = document.createElement('button');
        const img = document.createElement('img');
        img.alt = ''; img.loading = 'lazy';
        const art = live ? item.logo : item.poster || item.backdrop || item.landscape;
        if (art) img.src = art;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        const title = document.createElement('span');
        title.textContent = live ? item.name : item.title;
        card.append(img,title);
        card.onclick = () => live ? tools.tune(item) : tools.open(item);
        cardCache.set(item,card);
        cards.appendChild(card);
      });
      grid.replaceChildren(cards);
      if (!items.length && (!search || search.done)) grid.textContent = 'Sin resultados';
    }
    input.oninput = () => {
      clearTimeout(timer);
      const query = input.value.trim();
      search = query.length >= 2 && ['Todo','Películas','Series'].includes(filter) ? {query,page:1,items:[]} : null;
      draw();
      if (search) timer = setTimeout(nextPage,350);
    };
    document.addEventListener('xuper:catalog-updated', draw);
    document.addEventListener('xuper:ranks-updated',()=>{if (filter==='Todo' && !input.value) draw();});
    document.addEventListener('xuper:channels-updated',()=>{if (filter==='TV en vivo') draw();});
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
