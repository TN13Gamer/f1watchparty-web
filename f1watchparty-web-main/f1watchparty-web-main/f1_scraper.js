const puppeteer = require('puppeteer');

let browser;
let page;
let isLogged = false;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function initScraper(email, pass) {
    if (!browser) {
        console.log('🏎️ Launching F1 Live Scraper Browser...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        if (email && pass) {
            try {
                console.log('🔑 Logging into F1.com...');
                await page.goto('https://account.formula1.com/#/en/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await wait(3000); // Wait for SPA to fully render

                await page.waitForSelector('input.txtLogin', { timeout: 10000 });
                await page.type('input.txtLogin', email, { delay: 30 });
                await page.type('input.txtPassword', pass, { delay: 30 });

                // Click login — SPA login won't trigger waitForNavigation, so just click and wait
                await page.click('button.btn-primary');
                await wait(5000); // Give the SPA time to process the login

                const url = page.url();
                console.log('📍 URL after login:', url);
                
                if (!url.includes('login')) {
                    console.log('✅ Login Successful!');
                    isLogged = true;
                } else {
                    console.warn('⚠️ Still on login page — credentials may be wrong or F1 is blocking automation.');
                }
            } catch (e) {
                console.error('❌ Login error:', e.message);
            }
        }

        // Navigate to timing page
        const url = isLogged
            ? 'https://www.formula1.com/en/timing/live-timing.html'
            : 'https://www.formula1.com/en/timing/f1-live-lite#live-leaderboard';

        console.log(`🌐 Navigating to ${isLogged ? 'FULL' : 'LITE'} timing...`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.error('❌ Navigation error:', e.message);
        }
        console.log('✅ Scraper Ready');
    }
}

async function scrapeLiveLeaderboard() {
    try {
        if (!page) return { success: false, isLogged, data: [] };

        const leaderboardData = await page.evaluate(() => {
            const data = [];

            // Try full timing selectors first
            let rows = document.querySelectorAll('.js-row, tr[data-driver-key]');

            // Fallback to Lite selectors
            if (rows.length === 0) {
                rows = document.querySelectorAll('tr, .row-wrapper, [class*="driver"]');
            }

            rows.forEach(row => {
                const text = (row.innerText || '').trim();
                if (!text) return;

                const parts = text.split(/\n/).map(p => p.trim()).filter(p => p.length > 0);

                // Find position: first number between 1–24
                let pos = 0;
                for (const part of parts) {
                    const n = parseInt(part);
                    if (!isNaN(n) && n >= 1 && n <= 24) { pos = n; break; }
                }
                if (pos === 0 || data.find(d => d.position === pos)) return;

                // Driver: first non-numeric string with 2+ chars
                const driver = parts.find(p => isNaN(parseInt(p)) && p.length >= 2) || 'UNK';
                const gap = parts.find(p => p.includes('+') || p.includes('LAP') || p.includes('STOP')) || '';

                data.push({ position: pos, driver, gap, interval: '' });
            });

            return data;
        });

        return {
            success: true,
            isLogged,
            data: leaderboardData.sort((a, b) => a.position - b.position)
        };
    } catch (error) {
        console.error('❌ Scraper error:', error.message);
        return { success: false, isLogged, data: [] };
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

module.exports = { scrapeLiveLeaderboard, initScraper, closeScraper };
