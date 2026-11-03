import os from 'node:os';

const VIRTUAL = /(vethernet|virtualbox|vmware|hyper-v|wsl|docker|vbox|veth|br-|virbr|tailscale|zerotier|hamachi|radmin|loopback|npcap|tap|tun|utun)/i;
const WIRELESS = /(wi-?fi|wlan|wireless|беспроводн|wl)/i;
const WIRED = /(ethernet|eth|en\d|lan|подключение по локальной сети)/i;

export function isPrivate(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function usable(address) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) && !address.startsWith('127.') && !address.startsWith('169.254.') && address !== '0.0.0.0';
}
// Phones must never receive localhost: only real IPv4 addresses of this computer are offered.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const list = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'number' ? (entry.family === 4 ? 'IPv4' : 'IPv6') : entry.family;
      if (family !== 'IPv4' || entry.internal || !usable(entry.address)) continue;
      const virtual = VIRTUAL.test(name);
      const kind = virtual ? 'virtual' : WIRELESS.test(name) ? 'wifi' : WIRED.test(name) ? 'wired' : 'network';
      const score = (isPrivate(entry.address) ? 0 : 10) + (virtual ? 20 : 0) + (kind === 'network' ? 1 : 0);
      list.push({ address: entry.address, name, kind, virtual, private: isPrivate(entry.address), score });
    }
  }
  list.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return list.map(({ score, ...entry }, i) => ({ ...entry, recommended: i === 0 && !entry.virtual }));
}
