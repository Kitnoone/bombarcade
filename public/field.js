import { FIELD, hexDistance } from './adventure.js';
const NS = 'http://www.w3.org/2000/svg', R = 28;
const point = p => [40 + Math.sqrt(3) * R * (p.col + (p.row % 2) / 2), 40 + 1.5 * R * p.row];
function el(tag, attrs = {}, content) {
  const node = document.createElementNS(NS, tag);
  for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
  if (content !== undefined) node.textContent = content;
  return node;
}
export function renderField(svg, trial) {
  if (svg.dataset.round !== String(trial.round)) {
    svg.dataset.round = String(trial.round);
    svg.dataset.signature = '';
    svg.setAttribute('viewBox','0 0 940 555');
    const cells = el('g', { class: 'field-cells' });
    for (let row = 0; row < FIELD.rows; row++) for (let col = 0; col < FIELD.columns; col++) {
      const [x,y] = point({col,row});
      const points = Array.from({length:6},(_,i) => {
        const a = (60 * i - 30) * Math.PI / 180;
        return (x + (R-1) * Math.cos(a)) + ',' + (y + (R-1) * Math.sin(a));
      }).join(' ');
      cells.append(el('polygon',{points,'data-col':col,'data-row':row,class:'hex'}));
    }
    const nodes = el('g',{class:'field-nodes'});
    trial.nodes.forEach(n => {
      const [x,y] = point(n);
      const group = el('g',{transform:'translate('+x+' '+y+')',class:'node'+(n.target?' target':''),'data-col':n.col,'data-row':n.row,'data-target':String(n.target)});
      group.append(el('circle',{r:18}),el('text',{'text-anchor':'middle','dominant-baseline':'central'},n.sign));
      nodes.append(group);
    });
    const probe = el('g',{class:'probe'});
    probe.append(el('circle',{r:23,class:'probe-halo'}),el('circle',{r:15}),el('circle',{r:3,class:'probe-core'}),el('path',{d:'M -29 0 H -21 M 21 0 H 29 M 0 -29 V -21 M 0 21 V 29'}));
    svg.replaceChildren(cells,nodes,probe);
  }
  const signature = trial.position.col + ':' + trial.position.row;
  if (svg.dataset.signature === signature) return;
  svg.dataset.signature = signature;
  for (const cell of svg.querySelectorAll('.hex')) cell.classList.toggle('revealed',hexDistance({col:Number(cell.dataset.col),row:Number(cell.dataset.row)},trial.position)<=FIELD.radius);
  for (const node of svg.querySelectorAll('.node')) {
    const visible = hexDistance({col:Number(node.dataset.col),row:Number(node.dataset.row)},trial.position)<=FIELD.radius;
    node.style.display = visible ? '' : 'none';
    node.classList.toggle('occupied',Number(node.dataset.col)===trial.position.col && Number(node.dataset.row)===trial.position.row);
  }
  const [x,y] = point(trial.position);
  svg.querySelector('.probe').style.transform = 'translate('+x+'px,'+y+'px)';
}
