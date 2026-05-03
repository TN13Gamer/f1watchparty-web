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
            
            // F1 Lite heavily uses dynamic classes. We will robustly look for rows that contain positions 1-20
            // and known driver acronyms (e.g. VER, NOR, LEC).
            // A typical row will have: position, driver name/acronym, gap, interval
            
            // 1. Try to find the main table or list
            const possibleRows = document.querySelectorAll('tr, li, .leaderboard-row, [class*="driver"]');
            
            let posCount = 1;
            possibleRows.forEach(row => {
                const text = row.innerText || '';
                
                // Fast heuristic to check if it's a driver row (has a position number at the start)
                const isDriverRow = text.match(new RegExp(`^\\s*${posCount}\\s+`)) || 
                                    text.match(/VER|NOR|LEC|SAI|HAM|RUS|PER|PIA|ALO|STR|TSU|RIC|HUL|MAG|BOT|ZHO|ALB|SAR|GAS|OCO/);
                                    
                if (isDriverRow && text.length > 5 && text.length < 100) {
                    // Extract data (this is a generic extractor as exact classes change)
                    // We split by newline or multiple spaces
                    const parts = text.split(/\n|\s{2,}/).map(p => p.trim()).filter(p => p);
                    
                    if (parts.length >= 2) {
                        data.push({
                            position: posCount,
                            // Attempt to guess which part is the driver (usually the second or third part, 3 letters)
                            driver: parts.find(p => p.length === 3 && p === p.toUpperCase()) || parts[1] || 'UNK',
                            gap: parts.find(p => p.includes('+') || p.includes('LAP')) || '',
                            interval: parts[parts.length - 1] || '',
                            raw: text // Kept for debugging
                        });
                        posCount++;
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
