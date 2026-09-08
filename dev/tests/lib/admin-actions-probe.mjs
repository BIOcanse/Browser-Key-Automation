import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pageEvaluate } from './cdp-client.mjs';

export async function runAdminActionsProbe({ forward, browserClient, connectPage, workerClient, baseUrl, keyId, extensionId, sampleRoot }) {
  await mkdir(sampleRoot, { recursive: true });
  const evidence = { observations: [], checks: [] }, targets = [], openedRecordings = new Set();
  let ui, page, transportPage, nativeWindowId;
  const until = async (read, message, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(message);
  };
  const call = async (method, params = {}) => {
    const response = await forward(method, params);
    evidence.observations.push({ method, response: response.payload });
    assert.equal(response.payload.ok, true, JSON.stringify(response.payload)); return response.payload.result;
  };
  const ready = async (timeoutMs = 8000) => until(() => pageEvaluate(ui, () => !document.querySelector('[data-keys-refresh]').disabled), 'Admin operation did not settle', timeoutMs);
  const click = async name => {
    await pageEvaluate(ui, name => { const button = document.querySelector(`[data-${name}]`); if (!button || button.disabled) throw new Error(`Disabled or missing ${name}`); button.click(); }, name);
    await ready(name === 'action-run' ? 25000 : 8000);
  };
  const fill = (name, value) => pageEvaluate(ui, ({ name, value }) => {
    const node = document.querySelector(`[data-${name}]`); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
  }, { name, value });
  const chooseKey = async value => {
    await pageEvaluate(ui, value => { const select = document.querySelector('[data-action-key]'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  };
  const response = async (method, ok = true) => {
    const value = await pageEvaluate(ui, () => ({ body: document.querySelector('[data-action-result]').textContent, status: document.querySelector('[data-action-status]').textContent }));
    assert.ok(value.body, JSON.stringify(value));
    const result = JSON.parse(value.body); assert.equal(result.method, method); assert.equal(result.ok, ok, JSON.stringify(result));
    evidence.observations.push(result); return result;
  };
  const submit = async name => { await pageEvaluate(ui, name => document.querySelector(`[data-${name}]`).requestSubmit(), name); await ready(); };
  const fixtureClick = async selector => {
    const point = await pageEvaluate(page, selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }, selector);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  };
  try {
    const fixtureUrl = new URL('recording', baseUrl).href;
    const target = (await browserClient.send('Target.createTarget', { url: fixtureUrl })).targetId; targets.push(target);
    page = await connectPage(target); await page.send('Runtime.enable'); await page.send('Page.enable');
    const tab = await until(async () => (await call('tabs.list', { limit: 100 })).items.find(item => item.url === fixtureUrl), 'Recording target missing');
    await call('page.wait', { tabRef: tab.tabRef, until: 'complete' });
    const adminTarget = (await browserClient.send('Target.createTarget', { url: `chrome-extension://${extensionId}/admin/actions.html`, newWindow:true })).targetId; targets.push(adminTarget);
    ui = await connectPage(adminTarget); await ui.send('Runtime.enable'); await ui.send('Page.enable');
    ui.webSocket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Page.javascriptDialogOpening'&&message.params.type==='confirm')
        void ui.send('Page.handleJavaScriptDialog',{accept:true}).catch(error=>{evidence.dialogError=String(error);});
    });
    await until(() => pageEvaluate(ui, () => document.querySelector('[data-action-key]')?.options.length > 1).catch(() => false), 'Action manager did not load');
    await ready(); await chooseKey(keyId);
    const seed = await pageEvaluate(ui, async ({ windowId }) => {
      const { saveAction } = await import(chrome.runtime.getURL('background/actions/store.js'));
      const { compileSource } = await import(chrome.runtime.getURL('background/actions/service.js'));
      const { parseCommand } = await import(chrome.runtime.getURL('background/command-dispatcher.js'));
      const compiled = await compileSource('', [{ method: 'windows.get', schemaVersion: 1, params: { windowId } }], parseCommand);
      const pages = await saveAction('UI paging full source', 'Complete multi-page source', Array.from({ length: 201 }, () => compiled.instructions[0]));
      for (let index = 0; index < 101; ++index) await saveAction('UI paging repeated name', String(index), compiled.instructions);
      return pages;
    }, { windowId: tab.windowId });
    await fill('action-search', 'UI paging'); await submit('action-search-form');
    const firstCount = await pageEvaluate(ui, () => document.querySelectorAll('[data-action-list] li').length);
    assert.ok(firstCount > 0 && firstCount < 102);
    await fill('action-search', 'UI paging full source');
    for (let index = 0; index < 5 && await pageEvaluate(ui, () => !document.querySelector('[data-action-more]').hidden); ++index) await click('action-more');
    assert.equal(await pageEvaluate(ui, () => document.querySelectorAll('[data-action-list] li').length), 102);
    await submit('action-search-form');
    assert.equal(await pageEvaluate(ui, () => document.querySelectorAll('[data-action-list] li').length), 1);
    assert.equal(await pageEvaluate(ui, () => document.querySelector('[data-action-more]').hidden), true);
    await pageEvaluate(ui, id => [...document.querySelectorAll('[data-action-list] button')].find(button => button.textContent.startsWith(`#${id} ·`)).click(), seed.actionId); await ready();
    const loaded = await pageEvaluate(ui, () => JSON.parse(document.querySelector('[data-action-source]').value));
    assert.equal(loaded.length, 201);
    await call('actions.update', { actionId: seed.actionId, revision: 1, name: 'UI paging updated elsewhere', description: '', instructions: loaded });
    await fill('action-description', 'Stale UI edit'); await submit('action-editor');
    assert.equal((await response('actions.update', false)).error.details.reason, 'REVISION_CONFLICT');
    evidence.checks.push('Stable IDs, duplicate names, list pages, complete multi-page source and revision conflict');

    await click('action-new'); await fill('action-name', 'UI saved action');
    await fill('action-source', JSON.stringify([{ method: 'windows.get', schemaVersion: 1, params: { windowId: tab.windowId } }]));
    await click('action-compile'); assert.equal((await response('actions.compile')).result.runnable, true);
    await click('action-use-preview'); await submit('action-editor');
    const saved = (await response('actions.create')).result.action;
    await click('action-run'); const run = (await response('actions.run')).result;
    assert.equal(run.status, 'succeeded'); assert.equal(run.actionId, saved.actionId);
    await click('trace-read');
    const trace = await pageEvaluate(ui, () => JSON.parse(document.querySelector('[data-trace-output]').textContent).trace);
    assert.ok(trace.events.some(event => event.actionId === saved.actionId && event.stepIndex === 0));
    evidence.checks.push('UI compile, explicit save, run by ID and step review through selected Key');

    await click('tabs-refresh');
    await pageEvaluate(ui, tabRef => { const select = document.querySelector('[data-record-tab]'); select.value = tabRef; select.dispatchEvent(new Event('change', { bubbles: true })); }, tab.tabRef);
    await fill('record-duration', '60000'); await fill('record-retention', '120000');
    await submit('record-form'); const id = (await response('recording.start')).result.recording.recordingId; openedRecordings.add(id);
    await fixtureClick('#click'); await click('record-pause'); await response('recording.pause');
    await fixtureClick('#click'); await click('record-resume'); await response('recording.resume');
    await fixtureClick('#click'); await click('record-stop'); openedRecordings.delete(id);
    assert.equal((await response('recording.stop')).result.recording.state, 'stopped');
    await click('record-events');
    const raw = await pageEvaluate(ui, () => JSON.parse(document.querySelector('[data-record-events-output]').textContent));
    assert.equal(raw.events.filter(event => event.kind === 'click').length, 2);
    await click('record-compile'); assert.equal((await response('actions.compile')).result.runnable, true);
    assert.equal(await pageEvaluate(ui, () => JSON.parse(document.querySelector('[data-action-source]').value).recordingId), id);
    await click('action-use-preview'); await fill('action-name', 'UI recorded clicks'); await submit('action-editor'); await response('actions.create');
    await pageEvaluate(page, () => window.reset()); await click('action-run'); assert.equal((await response('actions.run')).result.status, 'succeeded');
    assert.equal(await pageEvaluate(page, () => window.snapshot().count), 2);
    evidence.checks.push('DOM recording UI start, pause, resume, stop, raw events, compile, save and actual replay');

    await pageEvaluate(ui,()=>{const mode=document.querySelector('[data-record-mode]');if(mode.querySelector('[value="real"]').disabled)throw new Error('Real recording option unavailable');mode.value='real';});
    await submit('record-form');const nativeId=(await response('recording.start')).result.recording.recordingId;openedRecordings.add(nativeId);
    await ui.send('Page.bringToFront');
    await click('record-pause');assert.equal((await response('recording.pause')).result.recording.state,'paused');
    await click('record-resume');assert.equal((await response('recording.resume')).result.recording.state,'recording');
    await click('record-stop');assert.equal((await response('recording.stop')).result.recording.state,'stopped');openedRecordings.delete(nativeId);
    await click('record-delete');await response('recording.delete');
    await pageEvaluate(ui,()=>{document.querySelector('[data-record-mode]').value='dom';});
    evidence.checks.push('Real recording UI activates selected target; separate manager window can pause, resume, stop and delete');

    const transportTarget = (await browserClient.send('Target.getTargets')).targetInfos.find(target => target.url === `chrome-extension://${extensionId}/offscreen/index.html`);
    assert.ok(transportTarget, 'Offscreen transport target missing');
    transportPage = await connectPage(transportTarget.targetId); await transportPage.send('Runtime.enable');
    await pageEvaluate(transportPage, () => {
      const original = Worker.prototype.postMessage;
      window.localRouteProbe = [];
      window.restoreLocalRouteProbe = () => { Worker.prototype.postMessage = original; };
      Worker.prototype.postMessage = function (message, ...rest) {
        const request = message?.payload;
        if (request && (request.kind.startsWith('route.local.') || request.kind.startsWith('native.'))) {
          window.localRouteProbe.push({ kind: request.kind, requestId: request.requestId, routeId: request.routeId ?? null,
            durationMs: request.durationMs ?? null, operation: request.operation?.kind ?? null });
        }
        return Reflect.apply(original, this, [message, ...rest]);
      };
    });
    await call('tabs.activate', { tabRef: tab.tabRef });
    await until(() => pageEvaluate(page, () => document.visibilityState === 'visible'), 'Native fixture tab did not become visible');
    const points = await pageEvaluate(page, () => {
      window.reset();
      const at = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; };
      return { button: at('#click'), field: at('#field') };
    });
    const tabBinding = [{ path: ['tabRef'], source: { kind: 'input', name: 'tab', valueType: 'tab_ref' } }];
    const windowBinding = [{ path: ['windowId'], source: { kind: 'input', name: 'window', valueType: 'window_id' } }];
    const nativeSteps = [
      { method: 'control.acquire', params: { scope: 'window' }, bindings: windowBinding },
      { method: 'input.calibrate', params: { timeoutMs: 5000 }, bindings: tabBinding },
      { method: 'virtualMouse.click', params: { at: points.button, timeoutMs: 2000 }, bindings: tabBinding },
      { method: 'virtualMouse.click', params: { at: points.field, timeoutMs: 2000 }, delayMs: 300, bindings: tabBinding },
      { method: 'virtualKeyboard.type', params: { text: 'UI native 录制', timeoutMs: 3000 }, bindings: tabBinding },
      { method: 'control.release', params: { scope: 'window' }, bindings: windowBinding },
    ].map(step => ({ ...step, schemaVersion: 1 }));
    nativeWindowId = tab.windowId;
    await click('action-new'); await fill('action-name', 'UI native action'); await fill('action-source', JSON.stringify(nativeSteps));
    await fill('action-inputs', JSON.stringify({ tab: tab.tabRef, window: tab.windowId }));
    await fill('action-timeout', '15000'); await submit('action-editor'); await response('actions.create');
    await click('action-run'); assert.equal((await response('actions.run')).result.status, 'succeeded');
    const nativePage = await pageEvaluate(page, () => window.snapshot());
    assert.equal(nativePage.count, 1); assert.equal(nativePage.value, 'UI native 录制');
    assert.ok(nativePage.evidence.some(event => event.type === 'click' && event.target === 'click' && event.trusted));
    assert.ok(nativePage.evidence.some(event => event.type === 'input' && event.target === 'field' && event.trusted));
    const routeEvidence = await pageEvaluate(transportPage, () => window.localRouteProbe);
    const opened = routeEvidence.filter(event => event.kind === 'route.local.open'), closed = routeEvidence.filter(event => event.kind === 'route.local.close');
    assert.equal(opened.length, 1); assert.equal(closed.length, 1);
    assert.ok(opened[0].durationMs > 5000 && opened[0].durationMs <= 15000);
    const nativeRequests = routeEvidence.filter(event => event.kind.startsWith('native.') && event.routeId !== null);
    assert.ok(nativeRequests.length >= 4);
    assert.ok(nativeRequests.every(event => event.routeId === closed[0].routeId));
    evidence.observations.push({ nativeUi: nativePage, localRoute: routeEvidence });
    evidence.checks.push('UI native calibration, trusted mouse and keyboard through exactly one App route followed by close');

    await submit('record-form'); const unfinished = (await response('recording.start')).result.recording.recordingId; openedRecordings.add(unfinished);
    const point = await pageEvaluate(page, () => { const box = document.querySelector('#pad').getBoundingClientRect(); return { x: box.x + 10, y: box.y + 10 }; });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    try { await click('record-stop'); openedRecordings.delete(unfinished); assert.equal((await response('recording.stop')).result.recording.state, 'interrupted'); }
    finally { await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }); }
    await click('record-compile'); assert.equal((await response('actions.compile')).result.runnable, false);
    assert.equal(await pageEvaluate(ui, () => document.querySelector('[data-action-use-preview]').disabled), true);
    assert.equal(await pageEvaluate(ui, () => JSON.parse(document.querySelector('[data-action-source]').value).recordingId), unfinished);
    await fill('action-name', 'Incomplete must not save'); await submit('action-editor');
    assert.equal((await response('actions.create', false)).error.details.reason, 'COMPILATION_INCOMPLETE');
    evidence.checks.push('Incomplete recorded gesture remains raw source and cannot silently save partial compilation');

    const other = await pageEvaluate(ui, async () => {
      const { createKey } = await import(chrome.runtime.getURL('background/key-service.js'));
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      return (await createKey({ mutationId: `am1.${Date.now()}.${token}`, displayName: 'UI isolated reader', keyKind: 'regular',
        permissions: ['actions.read', 'recording.read'], expiresAt: null, enabled: true })).key.keyId;
    });
    await click('keys-refresh');
    await pageEvaluate(ui, async () => {
      const { AdminPortClient } = await import(chrome.runtime.getURL('admin/port-client.js'));
      window.originalAdminRequest = AdminPortClient.prototype.request;
      AdminPortClient.prototype.request = function (method, params, ...rest) {
        const operation = window.originalAdminRequest.call(this, method, params, ...rest);
        return method === 'commands.execute' && params.command.method === 'actions.list'
          ? operation.then(value => new Promise(resolve => { window.releaseAdminRead = () => resolve(value); })) : operation;
      };
    });
    await pageEvaluate(ui, () => document.querySelector('[data-action-search-form]').requestSubmit());
    await until(() => pageEvaluate(ui, () => typeof window.releaseAdminRead === 'function'), 'Read gate not entered');
    await chooseKey(other);
    await pageEvaluate(ui, async () => { const { AdminPortClient } = await import(chrome.runtime.getURL('admin/port-client.js')); AdminPortClient.prototype.request = window.originalAdminRequest; window.releaseAdminRead(); });
    await ready();
    assert.equal(await pageEvaluate(ui, () => document.querySelectorAll('[data-action-list] li').length), 0);
    assert.equal(await pageEvaluate(ui, () => document.querySelector('[data-action-source]').value), '[]');
    await click('recordings-refresh');
    assert.equal(await pageEvaluate(ui, () => document.querySelectorAll('[data-recording-list] li').length), 0);
    evidence.checks.push('Key switching clears owned content and rejects a delayed old-Key read');

    await chooseKey(keyId);
    const locales = await pageEvaluate(ui, async () => {
      const { UI_LOCALES, UI_MESSAGES } = await import(chrome.runtime.getURL('generated/ui-config.js'));
      const select = document.querySelector('[data-locale]');
      return UI_LOCALES.map(({ tag }) => {
        select.value = tag; select.dispatchEvent(new Event('change', { bubbles: true }));
        const mismatches = [...document.querySelectorAll('[data-i18n]')].filter(node => node.textContent !== UI_MESSAGES[tag][node.dataset.i18n]).map(node => node.dataset.i18n);
        return { tag, actual: document.documentElement.lang, mismatches };
      });
    });
    assert.equal(locales.length, 20); assert.ok(locales.every(locale => locale.actual === locale.tag && !locale.mismatches.length), JSON.stringify(locales));
    for (const [locale, width, height] of [['zh-CN', 1280, 1000], ['ar', 390, 844]]) {
      await ui.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      await pageEvaluate(ui, locale => { const select = document.querySelector('[data-locale]'); select.value = locale; select.dispatchEvent(new Event('change', { bubbles: true })); }, locale);
      const fits = await pageEvaluate(ui, () => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      assert.ok(fits.content <= fits.width, JSON.stringify(fits));
      const shot = await ui.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(path.join(sampleRoot, `${locale}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
    evidence.checks.push('All 20 translations and desktop/mobile RTL layout');
    return { observations: evidence.observations.length, checks: evidence.checks };
  } catch (error) { evidence.error = String(error.stack ?? error); throw error; }
  finally {
    if (nativeWindowId !== undefined) await call('control.release', { scope: 'window', windowId: nativeWindowId }).catch(() => {});
    if (transportPage) {
      evidence.localRoute = await pageEvaluate(transportPage, () => window.localRouteProbe).catch(() => null);
      await pageEvaluate(transportPage, () => window.restoreLocalRouteProbe?.()).catch(() => {}); transportPage.close();
    }
    for (const recordingId of openedRecordings) await call('recording.stop', { recordingId }).catch(() => {});
    if (ui) { evidence.finalUi = await pageEvaluate(ui, () => ({ status: document.querySelector('[data-action-status]')?.textContent, result: document.querySelector('[data-action-result]')?.textContent })).catch(() => null); ui.close(); }
    page?.close();
    for (const targetId of targets) await browserClient.send('Target.closeTarget', { targetId }).catch(() => {});
    await writeFile(path.join(sampleRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
}
