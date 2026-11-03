import { FIELD, hexDistance } from './adventure.js';
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, content) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (content !== undefined) n.textContent = content; return n; };
const point = p => [82 + p.col * 78 + (p.row % 2) * 39, 49 + p.row * 42];
const polygon = (x, y) => [[0,-28],[39,-14],[39,14],[0,28],[-39,14],[-39,-14]].map(([a,b]) => `${x+a},${y+b}`).join(' ');
const icons = {
  spire: 'M-17 16H17M-13 14V-2L-9-13-5-2V14M-3 14V-13L0-23 3-13V14M5 14V-2L9-13 13-2V14',
  gear: 'M-5-17H5L7-11 13-9 19-10 23-2 17 2 16 8 18 14 10 19 5 14H-2L-7 19-15 14-13 8-16 2-22-2-18-10-12-9-7-12ZM7 0A7 7 0 1 0-7 0A7 7 0 1 0 7 0',
  antenna: 'M-11 18 0-14 11 18ZM-7 9H7M-4 0H4M-12-15A18 18 0 0 0-12 5M12-15A18 18 0 0 1 12 5M-7-11A10 10 0 0 0-7 0M7-11A10 10 0 0 1 7 0',
  forge: 'M-19 17V-5L-7 1V-10L6-3V-18H12V0L19-5V17ZM-12 6V13M-4 6V13M4 6V13M12 6V13',
  skull: 'M-9 17V10Q-22 3-15-11Q-11-21 0-21T15-11Q22 3 9 10V17ZM-9 0A4 4 0 1 0-1 0A4 4 0 1 0-9 0M1 0A4 4 0 1 0 9 0A4 4 0 1 0 1 0M-3 9H3M-4 11V17M4 11V17',
};
export function renderField(svg, state) {
  if (svg.dataset.round !== String(state.round)) {
    svg.dataset.round = state.round; svg.dataset.position = ''; svg.dataset.viruses = '';
    svg.setAttribute('viewBox', '0 0 1535 555'); svg.setAttribute('preserveAspectRatio', 'none');
    const defs = el('defs');
    const filter = el('filter', { id: 'fog-noise', x: '0', y: '0', width: '100%', height: '100%' });
    filter.append(el('feTurbulence', { type: 'fractalNoise', baseFrequency: '.009 .025', numOctaves: '3', seed: '12' }), el('feColorMatrix', { type: 'matrix', values: '0 0 0 0 .38 0 0 0 0 .64 0 0 0 0 .57 0 0 0 .65 0' }));
    const mask = el('mask', { id: 'fog-mask', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1535, height: 555 });
    mask.append(el('rect', { width: 1535, height: 555, fill: 'white' }), el('g', { class: 'fog-holes', fill: 'black' }));
    defs.append(filter, mask);
    const cells = el('g', { class: 'field-cells' }), coordinates = el('g', { class: 'field-coordinates' });
    for (let row = 0; row < FIELD.rows; row++) for (let col = 0; col < FIELD.columns; col++) {
      const [x,y] = point({col,row}); cells.append(el('polygon', { points: polygon(x,y), 'data-col': col, 'data-row': row, class: 'hex' }));
    }
    for (let col = 0; col < FIELD.columns; col++) coordinates.append(el('text', { x: point({ col, row: 0 })[0], y: 14, 'text-anchor': 'middle' }, String(col + 1).padStart(2, '0')));
    for (let row = 0; row < FIELD.rows; row++) coordinates.append(el('text', { x: 9, y: point({ col: 0, row })[1] + 6 }, String(row + 1).padStart(2, '0')));
    const nodes = el('g', { class: 'field-nodes' });
    for (const node of state.nodes) {
      const [x,y] = point(node), group = el('g', { transform: `translate(${x} ${y})`, class: `node${node.target ? ' target' : ''}`, 'data-col': node.col, 'data-row': node.row, 'data-kind': node.kind, 'aria-label': node.target ? 'Целевой узел' : 'Узел ' + node.kind });
      group.append(el('path', { d: node.target ? 'M0-23 23 0 0 23-23 0Z' : icons[node.kind] || icons.spire, class: node.target ? 'target-pulse' : 'node-icon' })); nodes.append(group);
    }
    const fog = el('rect', { width: 1535, height: 555, filter: 'url(#fog-noise)', mask: 'url(#fog-mask)', class: 'field-fog' });
    const viruses = el('g', { class: 'field-viruses' });
    const probe = el('g', { class: 'probe' });
    const scan = el('g', { class: 'scan-arc' }); scan.append(el('circle', { r: 141, opacity: 0 }), el('path', { d: 'M-89-109A141 141 0 0 1 132 50', opacity: '.45' }), el('circle', { cx: 132, cy: 50, r: 3, class: 'probe-core' }));
    probe.append(scan, el('circle', { r: 29, class: 'probe-halo' }), el('circle', { r: 21 }), el('circle', { r: 10, class: 'probe-core' }), el('path', { d: 'M-38 0H-25M25 0H38M0-38V-25M0 25V38' }));
    svg.replaceChildren(defs,cells,fog,nodes,viruses,probe,coordinates);
  }
  const position = `${state.position.col}:${state.position.row}`;
  if (svg.dataset.position !== position) {
    svg.dataset.position = position;
    const holes = [];
    for (const cell of svg.querySelectorAll('.hex')) {
      const p = { col: +cell.dataset.col, row: +cell.dataset.row }, visible = hexDistance(p,state.position) <= FIELD.radius;
      cell.classList.toggle('revealed', visible);
      if (visible) holes.push(el('polygon', { points: polygon(...point(p)) }));
    }
    svg.querySelector('.fog-holes').replaceChildren(...holes);
    for (const node of svg.querySelectorAll('.node')) node.style.display = hexDistance({ col: +node.dataset.col, row: +node.dataset.row }, state.position) <= FIELD.radius ? '' : 'none';
    const [x,y] = point(state.position); svg.querySelector('.probe').style.transform = `translate(${x}px,${y}px)`;
  }
  const signature = position + '/' + JSON.stringify(state.viruses);
  if (svg.dataset.viruses === signature) return;
  svg.dataset.viruses = signature;
  const visibleViruses = state.viruses.filter(v => hexDistance(v, state.position) <= FIELD.radius);
  svg.querySelector('.field-viruses').replaceChildren(...visibleViruses.map(v => {
    const [x,y] = point(v), group = el('g', { transform: `translate(${x} ${y})`, class: 'virus', 'data-id': v.id, 'aria-label': 'Вирус' });
    group.append(el('circle', { r: 32, class: 'virus-halo' }), el('path', { d: 'M0-27 6-15 18-19 16-7 28 0 16 7 19 19 6 16 0 28-6 16-19 19-16 7-28 0-16-7-19-19-6-16Z' }), el('path', { d: 'M-9-8 9 8M9-8-9 8', stroke: '#ffb7a0', 'stroke-width': 3 }), el('circle', { r: 3, class: 'virus-core' })); return group;
  }));
}
