const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  // Array to hold intercepted JSON responses
  const interceptedJSONs = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (response.request().resourceType() === 'fetch' || response.request().resourceType() === 'xhr') {
        const text = await response.text();
        if (text.includes('VER') || text.includes('position') || text.includes('Interval')) {
            console.log('Intercepted interesting JSON from:', url);
            interceptedJSONs.push({
                url: url,
                data: text.substring(0, 1000)
            });
        }
      }
    } catch (e) {
      // Ignore errors parsing streams or non-json
    }
  });

  console.log('Navigating to F1 Live Lite...');
  await page.goto('https://www.formula1.com/en/timing/f1-live-lite#live-leaderboard', { waitUntil: 'networkidle2' });

  // Give it a few seconds to finish WebSocket negotiations
  await new Promise(r => setTimeout(r, 5000));
  
  fs.writeFileSync('intercepted.json', JSON.stringify(interceptedJSONs, null, 2));
  console.log('Saved intercepted JSONs. Found:', interceptedJSONs.length);

  await browser.close();
})();
