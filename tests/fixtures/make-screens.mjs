// Renders synthetic bank-app screenshots (invented data) used by the OCR tests.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = new URL('./screens/', import.meta.url).pathname;
const row = (p, sub, a) => `<div class="r"><div><div class="p">${p}</div><div class="s">${sub}</div></div><div class="a ${a.startsWith('-') ? '' : 'pos'}">${a}</div></div>`;
const mobile = (dark, groups) => `<html><body style="margin:0;font-family:Helvetica,Arial,sans-serif;background:${dark ? '#111827' : '#fff'};color:${dark ? '#f3f4f6' : '#111'}">
<style>.h{padding:18px 20px 6px;font-size:13px;color:${dark ? '#9ca3af' : '#6b7280'};font-weight:600}.r{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid ${dark ? '#1f2937' : '#eee'}}
.p{font-size:16px;font-weight:600}.s{font-size:12px;color:${dark ? '#9ca3af' : '#6b7280'};margin-top:2px}.a{font-size:16px;font-variant-numeric:tabular-nums}.pos{color:#059669}.top{padding:22px 20px;font-size:22px;font-weight:700}</style>
<div class="top">Lønkonto</div>${groups.map(([d, rows]) => `<div class="h">${d}</div>${rows.map(r => row(...r)).join('')}`).join('')}</body></html>`;
const desktop = rows => `<html><body style="margin:0;font-family:Arial,sans-serif;background:#fff;color:#111;padding:24px"><h2 style="margin:0 0 14px">Kontobevægelser</h2>
<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="text-align:left;color:#555"><th style="padding:8px">Dato</th><th>Tekst</th><th style="text-align:right">Beløb</th><th style="text-align:right;padding-right:8px">Saldo</th></tr>
${rows.map(r => `<tr style="border-top:1px solid #ddd"><td style="padding:9px 8px">${r[0]}</td><td>${r[1]}</td><td style="text-align:right">${r[2]}</td><td style="text-align:right;padding-right:8px">${r[3]}</td></tr>`).join('')}</table></body></html>`;
const b = await chromium.launch();
const shot = async (name, html, w, h, scale = 2) => { const p = await (await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale })).newPage(); await p.setContent(html); await p.screenshot({ path: out + name }); };
const g1 = [['8. november 2026', [['NETTO', 'Dagligvarer', '-428,50'], ['Circle K Amager', 'Transport', '-350,00'], ['Kaffe Baren', 'Restaurant', '-35,00'], ['Kaffe Baren', 'Restaurant', '-35,00']]], ['7. november 2026', [['SPAR', 'Dagligvarer', '-212,95'], ['MobilePay Anna Jensen', 'Overførsel', '+150,00']]]];
const g2 = [['7. november 2026', [['SPAR', 'Dagligvarer', '-212,95'], ['MobilePay Anna Jensen', 'Overførsel', '+150,00']]], ['6. november 2026', [['DSB', 'Transport', '-98,00'], ['Apoteket', 'Sundhed', '-64,75']]], ['1. november 2026', [['LØN', 'Indkomst', '+32.500,00']]]];
await shot('mobile-light-1.png', mobile(false, g1), 390, 560);
await shot('mobile-light-2.png', mobile(false, g2), 390, 560);
await shot('mobile-dark.png', mobile(true, g1), 390, 560);
await shot('desktop-balance.png', desktop([['08.11.2026', 'Netto Vesterbro', '-428,50', '12.071,50'], ['07.11.2026', 'Dankort-køb SPAR 4412', '-212,95', '12.500,00'], ['06.11.2026', 'MobilePay Anna', '150,00', '12.712,95'], ['05.11.2026', 'DSB Billetter', '-98,00', '12.562,95'], ['01.11.2026', 'Lønoverførsel', '32.500,00', '12.660,95']]), 900, 330, 1);
await b.close(); console.log('screens written');
