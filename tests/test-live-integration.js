const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

(async () => {
  const extensionPath = path.resolve(__dirname, '..', 'extension');
  const tempProfilePath = path.resolve(__dirname, '..', 'temp_chrome_profile');

  if (!fs.existsSync(tempProfilePath)) {
    fs.mkdirSync(tempProfilePath);
  }

  console.log(`[TEST] Loading extension from: ${extensionPath}`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    userDataDir: tempProfilePath,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--silent-debugger-extension-api'
    ]
  });

  // Wait for the service worker target to be created
  const target = await browser.waitForTarget(t => t.type() === 'service_worker');
  const worker = await target.worker();

  console.log('[TEST] Isolated Chrome launched! Connected to Service Worker.');

  console.log('[TEST] Simulating BRAIN_INIT_TASK...');
  let res = await worker.evaluate(() => {
    return new Promise(resolve => {
      chrome.runtime.onMessage.dispatch(
        { type: 'BRAIN_INIT_TASK', goal: 'search for laptop', startUrl: 'https://amazon.com' },
        {},
        resolve
      );
      // Fallback if dispatch doesn't trigger standard sendResponse behavior cleanly when mocked manually
      setTimeout(() => resolve(self.taskStateTracker?.getSnapshot()), 100);
    });
  });
  console.log('[TEST] Init Result:', res);

  console.log('\n[TEST] Simulating A -> B -> A loop directly into Service Worker event listener...');
  
  const actions = [
    { url: 'https://amazon.com', fp: 'fp1', type: 'click', role: 'link' },
    { url: 'https://amazon.com/product', fp: 'fp2', type: 'scroll', role: 'main' },
    { url: 'https://amazon.com', fp: 'fp1', type: 'click', role: 'link' }
  ];

  for (const act of actions) {
    console.log(`[TEST] Dispatching Action: ${act.url} (${act.type})`);
    
    // We can evaluate directly in the service worker context to test the message handlers
    const loopRes = await worker.evaluate((act) => {
      return new Promise(resolve => {
         // Create mock sender
         const sender = { tab: { id: 1 } };
         // Call the message listener that is already registered
         // But there's no easy way to get the specific listener that background/service-worker.js registered.
         // Wait, the router is just listening to chrome.runtime.onMessage.
         
         // Since taskStateTracker and loopDetector are globals now, we can just call them directly!
         const actionObj = { type: act.type, role: act.role, boundingBox: {x:0,y:0,width:10,height:10} };
         if (self.taskStateTracker) {
             self.taskStateTracker.recordAction(actionObj, 'none', act.url);
         }
         let result = null;
         if (self.loopDetector) {
             result = self.loopDetector.check(act.url, act.fp, actionObj);
         }
         resolve(result);
      });
    }, act);

    console.log('[TEST] LoopDetector Check Result:', loopRes);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n[TEST] Verifying final task state in the Service Worker...');
  const state = await worker.evaluate(() => {
    return self.taskStateTracker ? self.taskStateTracker.getSnapshot() : null;
  });
  
  console.log(`[TEST] Final Step Index: ${state?.step_index}`);
  console.log(`[TEST] Final Unique Nodes Visited: ${state?.uniqueNodesVisited}`);

  console.log('[TEST] Done! Closing browser.');
  await browser.close();
  process.exit(0);
})();
