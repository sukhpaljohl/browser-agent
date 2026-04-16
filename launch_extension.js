const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

(async () => {
  const extensionPath = path.resolve(__dirname, 'extension');
  const tempProfilePath = path.resolve(__dirname, 'temp_chrome_profile');

  if (!fs.existsSync(tempProfilePath)) {
    fs.mkdirSync(tempProfilePath);
  }

  console.log(`Loading extension from: ${extensionPath}`);
  console.log('Launching isolated Chrome browser (with Stealth)...');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    userDataDir: tempProfilePath,
    // Extremely important: Puppeteer disables extensions by default. This overrides it!
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--silent-debugger-extension-api'
    ]
  });

  const page = await browser.newPage();
  console.log('Navigating to chatgpt.com...');
  await page.goto('https://chatgpt.com', { waitUntil: 'networkidle2' });

  console.log('Isolated Browser launched with the extension loaded successfully!');
  
  browser.on('disconnected', () => {
    console.log('Browser closed. Exiting...');
    process.exit(0);
  });
})();
