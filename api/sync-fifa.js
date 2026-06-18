const syncHandler = require('./sync-standings');

module.exports = async (req, res) => {
  req.query = {
    ...(req.query || {}),
    type: 'fifastreams',
    manual: 'true'
  };

  return syncHandler(req, res);
};
