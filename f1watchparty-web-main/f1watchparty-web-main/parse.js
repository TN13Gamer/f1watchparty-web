const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('puppeteer_lite.html', 'utf8');
const $ = cheerio.load(html);

console.log($('table').length + ' tables found');

const rows = [];
$('div, tr, li').each((i, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text.includes('VER') || text.includes('NOR') || (text.length > 5 && i < 150)) {
        if (text.length < 150) {
            rows.push(text);
        }
    }
});

console.log('Sample rows:', rows.slice(0, 30));
