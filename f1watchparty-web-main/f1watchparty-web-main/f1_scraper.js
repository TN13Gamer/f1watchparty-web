const puppeteer = require('puppeteer');

let browser;
let page;

async function initScraper() {
    if (!browser) {
        console.log('🏎️ Launching F1 Live Scraper Browser...');
        browser = await puppeteer.launch({
            headless: 'new', // Run in background
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        page = await browser.newPage();
        
        // Disguise as a real user
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
        // Go to the live lite page
        console.log('🌐 Navigating to F1 Live Lite...');
        await page.goto('https://www.formula1.com/en/timing/f1-live-lite#live-leaderboard', { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('✅ Scraper Ready');
    }
}

async function scrapeLiveLeaderboard() {
    try {
        if (!page) await initScraper();
        
        // We evaluate directly in the browser context
        const leaderboardData = await page.evaluate(() => {
            const data = [];
            // Very broad selector to catch any potential rows
            const rows = document.querySelectorAll('tr, [class*="row"], [class*="driver"]');
            
            console.log(`Found ${rows.length} potential rows`);
            
            rows.forEach(row => {
                const text = row.innerText || '';
                // Split by newline and remove empty/whitespace-only parts
                const parts = text.split(/\n/).map(p => p.trim()).filter(p => p && p.length > 0);
                
                // A valid driver row usually has position as the first part (1-20)
                const pos = parseInt(parts[0]);
                if (!isNaN(pos) && pos >= 1 && pos <= 20) {
                    // Avoid duplicate entries for the same position if we caught nested elements
                    if (!data.find(d => d.position === pos)) {
                        data.push({
                            position: pos,
                            driver: parts[1] || 'UNK',
                            gap: parts[2] || '',
                            interval: parts[3] || '',
                            raw: text.replace(/\n/g, ' | ')
                        });
                    }
                }
            });
            
            return data;
        });

        // Dedup by position just in case we caught multiple elements per row
        const uniqueData = [];
        const seenPositions = new Set();
        for (const item of leaderboardData) {
            if (!seenPositions.has(item.position) && item.position <= 20) {
                seenPositions.add(item.position);
                uniqueData.push(item);
            }
        }

        return uniqueData;

    } catch (error) {
        console.error('❌ Scraper error:', error.message);
        // Attempt to recover browser if it crashed
        if (browser) {
            await browser.close();
            browser = null;
            page = null;
        }
        return [];
    }
}

async function closeScraper() {
    if (browser) {
        await browser.close();
        browser = null;
        page = null;
        console.log('🛑 Scraper Closed');
    }
}

module.exports = {
    scrapeLiveLeaderboard,
    initScraper,
    closeScraper
};
