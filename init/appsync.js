module.exports = function(nano, nginx, config) {
  return require('steelmesh-appsync')(nano.use(config.couch.dbname), {
    targetPath: config.appsPath
  });
};
