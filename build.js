const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir);
  console.log('Created dist/ directory.');
} else {
  console.log('dist/ directory already exists.');
}

// Allowed static file extensions
const allowedExts = ['.html', '.png', '.json', '.webm'];
const excludedFiles = ['package.json', 'package-lock.json', 'vercel.json'];

const files = fs.readdirSync(__dirname);
let copyCount = 0;

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  const stat = fs.statSync(filePath);
  
  if (stat.isFile()) {
    const ext = path.extname(file).toLowerCase();
    if ((allowedExts.includes(ext) || file === '_redirects') && !excludedFiles.includes(file)) {
      const destPath = path.join(distDir, file);
      fs.copyFileSync(filePath, destPath);
      console.log(`Copied: ${file}`);
      copyCount++;
    }
  }
});

console.log(`\nSuccessfully prepared ${copyCount} static assets in dist/ folder.`);
