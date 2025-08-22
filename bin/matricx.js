#!/usr/bin/env node

import si from 'systeminformation';
import os from 'os';
import blessed from 'blessed';
import prettyBytes from 'pretty-bytes';

const sampleMs = 1000;

let style = 'blocks';
const GLYPHS = {
  blocks: { fill: '█', empty: ' ' },
  shaded: { fill: '▓', empty: '░' },
  ascii:  { fill: '#', empty: '-' }
};

const screen = blessed.screen({
  smartCSR: true,
  title: 'Matricx'
});

const header = blessed.box({
  top: 0, left: 0, width: '100%', height: 1,
  content: 'Matricx',
  tags: true
});
screen.append(header);

const cpuBox = blessed.box({
  top: 1, left: 0, width: '100%', height: 6,
  label: ' CPU ', border: { type: 'line' }, tags: true
});
screen.append(cpuBox);

const memBox = blessed.box({
  top: 7, left: 0, width: '100%', height: 4,
  label: ' Memory ', border: { type: 'line' }, tags: true
});
screen.append(memBox);

const netBox = blessed.box({
  top: 11, left: 0, width: '100%', height: 4,
  label: ' Network ', border: { type: 'line' }, tags: true
});
screen.append(netBox);

// Processes box: anchored top at 15, bottom reserved for services+footer (bottom: 6)
const procBox = blessed.box({
  top: 15, left: 0, width: '100%', bottom: 6,
  label: ' Processes ', border: { type: 'line' }, tags: true, scrollable: true, alwaysScroll: true
});
screen.append(procBox);

// Services box: separate box above the footer
const servicesBox = blessed.box({
  bottom: 3, left: 0, width: '100%', height: 3,
  label: ' Services ', border: { type: 'line' }, tags: true
});
screen.append(servicesBox);

const footer = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 3,
  border: { type: 'line' }, tags: true
});
screen.append(footer);

// ---------- helpers ----------
const safeNum = (n) => Number.isFinite(n) ? n : 0;
const stripTags = (s) => String(s).replace(/\{\/?[^}]+\}/g, '');
const pctColor = (pct) => (pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'green');

// visible inner width of a full-width bordered box
const contentWidth = () => Math.max(10, (screen.width || 80) - 2);

function truncateMiddle(str, maxLen) {
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  const half = Math.floor((maxLen - 3) / 2);
  return str.slice(0, half) + '...' + str.slice(str.length - half);
}

// bar renderer
function makeBar(fraction, length, color) {
  const g = GLYPHS[style] || GLYPHS.blocks;
  const filled = Math.max(0, Math.min(length, Math.round(length * fraction)));
  const empty = Math.max(0, length - filled);
  return `{${color}-fg}${g.fill.repeat(filled)}{/}` + g.empty.repeat(empty);
}

// small '|' based mini-bar for cores
function makeMiniBar(fraction, length = 6, color = 'green') {
  const filled = Math.max(0, Math.min(length, Math.round(length * fraction)));
  const empty = Math.max(0, length - filled);
  return `{${color}-fg}` + '|'.repeat(filled) + '{/}' + ' '.repeat(empty);
}

// aligned bar with right text flush-right
function makeAlignedBarLine({ label = '', fraction = 0, rightText = '', color = 'green' }) {
  const innerW = contentWidth();
  const leftPad = 1;
  const labelText = label ? (label + ' ') : '';
  const rightLen = stripTags(rightText).length;
  const fixedLeft = leftPad + labelText.length;
  const minGap = 1;

  let barLen = innerW - fixedLeft - rightLen - minGap;
  if (barLen < 0) barLen = 0;

  const bar = makeBar(fraction, barLen, color);
  const gap = Math.max(minGap, innerW - fixedLeft - stripTags(bar).length - rightLen);

  return ' '.repeat(leftPad) + labelText + bar + ' '.repeat(gap) + rightText;
}

// evenly space items across a line width
function spaceEvenly(items, width) {
  if (items.length === 0) return '';
  const stripped = items.map(stripTags);
  const totalLen = stripped.reduce((a, s) => a + s.length, 0);
  const gaps = items.length - 1;
  const space = Math.max(1, Math.floor((width - totalLen) / gaps));
  return items.join(' '.repeat(space));
}

function rateColor(bytesPerSec) {
  const mb = Math.abs(bytesPerSec) / (1024 * 1024);
  if (mb > 5) return 'red';
  if (mb > 1) return 'yellow';
  return 'green';
}

let lastNet = null;
let observedNetMax = 1;

// simple service matchers: name -> substrings to look for in process name
const SERVICE_MATCHERS = [
  { name: 'Docker', matches: ['dockerd', 'docker', 'containerd'] },
  { name: 'MongoDB', matches: ['mongod', 'mongo'] },
  { name: 'Postgres', matches: ['postgres', 'postgresql'] },
  { name: 'MySQL', matches: ['mysqld', 'mysql'] },
  { name: 'Redis', matches: ['redis-server', 'redis'] },
  { name: 'Nginx', matches: ['nginx'] },
  { name: 'Apache', matches: ['httpd', 'apache2'] }
];

async function sampleOnce() {
  try {
    const [load, mem, netStatsRaw, procs, osInfo, uptimeSec, battery] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.processes(),
      si.osInfo(),
      si.time().uptime,
      si.battery().catch(() => ({}))
    ]);
    const loadAvg = os.loadavg();

    // ----- CPU -----
    const cpuPct = safeNum(load.currentLoad || 0);

    // create small '|' based progress bars for each core
    const miniBarLen = 6; // width of each per-core mini bar (tweak if you want longer)
    const cores = (load.cpus || []).map((c, i) => {
      const pct = safeNum(c.load);
      const color = pctColor(pct);
      const bar = makeMiniBar(Math.max(0, Math.min(1, pct / 100)), miniBarLen, color);
      const pctStr = String(Math.round(pct)).padStart(2, '0');
      // compact per-core string: "C1:| || 09%"
      return `C${i + 1}:${bar} ${pctStr}%`;
    });

    const half = Math.ceil(cores.length / 2);

    const cpuLine = makeAlignedBarLine({
      fraction: Math.max(0, Math.min(1, cpuPct / 100)),
      rightText: `${cpuPct.toFixed(1)}% | cores: ${cores.length}`,
      color: pctColor(cpuPct)
    });

    cpuBox.setContent(
      cpuLine + '\n' +
      spaceEvenly(cores.slice(0, half), contentWidth()) + '\n' +
      spaceEvenly(cores.slice(half), contentWidth())
    );

    // ----- Memory -----
    const totalMem = safeNum(mem.total);
    const usedMem  = safeNum(mem.active || mem.used);
    const memPct   = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

    const memLine = makeAlignedBarLine({
      fraction: Math.max(0, Math.min(1, memPct / 100)),
      rightText: `${memPct.toFixed(1)}%`,
      color: pctColor(memPct)
    });

    memBox.setContent(
      memLine + '\n' +
      ` ${prettyBytes(usedMem)} / ${prettyBytes(totalMem)} (${memPct.toFixed(1)}%)`
    );

    // ----- Network -----
    const netStats = Array.isArray(netStatsRaw) ? netStatsRaw : (netStatsRaw ? [netStatsRaw] : []);
    const primary = netStats.find(n => safeNum(n.rx_bytes) + safeNum(n.tx_bytes) > 0) || netStats[0];
    let rxps = 0, txps = 0;
    const now = Date.now();

    if (primary) {
      if (Number.isFinite(primary.rx_sec) && primary.rx_sec > 0) rxps = safeNum(primary.rx_sec);
      if (Number.isFinite(primary.tx_sec) && primary.tx_sec > 0) txps = safeNum(primary.tx_sec);
      if (!(rxps > 0 || txps > 0)) {
        if (lastNet) {
          const dt = Math.max(0.001, (now - lastNet.t) / 1000);
          rxps = (safeNum(primary.rx_bytes) - lastNet.rx) / dt;
          txps = (safeNum(primary.tx_bytes) - lastNet.tx) / dt;
        }
        lastNet = { rx: safeNum(primary.rx_bytes), tx: safeNum(primary.tx_bytes), t: now };
      } else {
        lastNet = { rx: safeNum(primary.rx_bytes || 0), tx: safeNum(primary.tx_bytes || 0), t: now };
      }
    }

    observedNetMax = Math.max(observedNetMax * 0.95, 1, Math.abs(rxps), Math.abs(txps));

    const downLine = makeAlignedBarLine({
      label: 'Down',
      fraction: Math.abs(rxps) / observedNetMax,
      rightText: `${prettyBytes(rxps)}/s`,
      color: rateColor(rxps)
    });

    const upLine = makeAlignedBarLine({
      label: 'Up  ',
      fraction: Math.abs(txps) / observedNetMax,
      rightText: `${prettyBytes(txps)}/s`,
      color: rateColor(txps)
    });

    netBox.setContent(downLine + '\n' + upLine);

    // ----- Processes -----
    const procTop = 15;
    const reservedBottom = 6; // space reserved for Services (3) + Footer (3)
    const procHeight = Math.max(5, Math.floor((screen.height || 24) - procTop - reservedBottom));
    const maxProcs = Math.max(5, procHeight - 3);

    // prepare formatting widths based on inner width
    const innerW = contentWidth();
    const pidW = 6;    // " PID "
    const cpuW = 6;    // " CPU% "
    const rssW = 10;   // " 123.4 MB"
    const gap = 2;     // spaces between columns
    const nameW = Math.max(12, innerW - pidW - cpuW - rssW - (gap * 3));

    // header lines (columns + legend / what-are-what)
    const hdrName = 'NAME'.padEnd(nameW).slice(0, nameW);
    const hdrPid  = 'PID'.padStart(pidW);
    const hdrCpu  = 'CPU%'.padStart(cpuW);
    const hdrRss  = 'RSS'.padStart(rssW);
    const headingLine = `${hdrName}${' '.repeat(gap)}${hdrPid}${' '.repeat(gap)}${hdrCpu}${' '.repeat(gap)}${hdrRss}`;

    // pick top processes by CPU then RSS to fill the box fully
    const procList = (procs.list || []).slice().sort((a, b) => {
      const ac = (a.cpu || 0), bc = (b.cpu || 0);
      if (bc !== ac) return bc - ac;
      const ar = (a.memRss || 0), br = (b.memRss || 0);
      return br - ar;
    }).slice(0, maxProcs);

    const lines = [headingLine];

    for (let p of procList) {
      const name = truncateMiddle(String(p.name || p.command || ''), nameW);
      const pid  = String(p.pid || '').padStart(pidW);
      const cpu  = safeNum(p.cpu || 0).toFixed(1).padStart(cpuW);
      const rss  = prettyBytes(p.memRss || 0).padStart(rssW);

      const line = `${name.padEnd(nameW)}${' '.repeat(gap)}${pid}${' '.repeat(gap)}${cpu}${' '.repeat(gap)}${rss}`;
      lines.push(line);
    }

    // if we have fewer entries than the visible area, pad with empty lines to fill the box
    while (lines.length < (maxProcs + 2)) lines.push('');

    procBox.setContent(lines.join('\n'));

    // ----- Services detection (scan process list) -----
    const lowerProcs = (procs.list || []).map(p => ({
      name: (p.name || '').toLowerCase(),
      pid: p.pid,
      cpu: p.cpu,
      memRss: p.memRss
    }));

    const serviceStatuses = SERVICE_MATCHERS.map(svc => {
      const found = lowerProcs.find(p => svc.matches.some(m => p.name.includes(m)));
      if (found) {
        const cpu = (found.cpu || 0).toFixed(1);
        return `${svc.name}: {green-fg}running{/} (pid ${found.pid} ${cpu}% CPU)`;
      } else {
        return `${svc.name}: {red-fg}stopped{/}`;
      }
    });

    // present services in one or two lines depending on width
    const servicesLine = serviceStatuses.join('  |  ');
    servicesBox.setContent(servicesLine);

    // ----- Footer -----
    const uptimeDays = Math.floor(uptimeSec / 86400);
    const uptimeHrs  = Math.floor((uptimeSec % 86400) / 3600);
    const uptimeMin  = Math.floor((uptimeSec % 3600) / 60);
    const nowStr     = new Date().toLocaleString();

    footer.setContent(
      `{green-fg}${osInfo.distro} ${osInfo.release} (${osInfo.kernel}){/}  |  ` +
      `{cyan-fg}Uptime: ${uptimeDays}d ${uptimeHrs}h ${uptimeMin}m{/}  |  ` +
      `{yellow-fg}Load Avg: ${loadAvg.map(v => v.toFixed(2)).join(', ')}{/}  |  ` +
      `{magenta-fg}Battery: ${battery?.hasBattery ? (battery.percent + '%') : 'N/A'}{/}  |  ` +
      `{white-fg}${nowStr}{/}`
    );
  } catch (err) {
    header.setContent(`Matricx (error: ${err.message})`);
  }
}

// quit on Ctrl+C
process.on('SIGINT', () => process.exit(0));

sampleOnce().then(() => screen.render());
setInterval(() => { sampleOnce().then(() => screen.render()); }, sampleMs);
