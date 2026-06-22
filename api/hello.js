module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'text/plain');
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  res.status(200).send('Hello World from Vercel Backend!');
};
