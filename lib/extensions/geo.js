var fs = require('fs'),
    path = require('path'),
    reInvalidDataset = /^(\.|geostack).*$/;

function datasets(stack, callback, queryParams, req, res, next) {
    var config = stack.getConfig(),
        datapath = path.resolve(config.datapath || 'data'),
        datasets = [];
        
    fs.readdir(datapath, function(err, files) {
        
        files.forEach(function(file) {
            // if the file is valid, then add it to the list of datasets
            if (! reInvalidDataset.test(file)) {
                datasets.push({
                    id: file
                });
            } // if
        });
        
        callback({
            datasets: datasets
        });
    });
} // datasets

function datasetSearch(geostack, callback, queryParams, req, res, next) {
    // require the dataset
    var dataset = require(process.cwd() + '/lib/datasets/' + req.params.dataset),
        dsConfig = extendConfig(dataset.config),
        processor = require('./geo/' + dataset.type).init(dsConfig)[req.params.op];
        
    if (processor) {
        processor(geostack, callback, queryParams, req, res);
    }
    else {
        throw new Error('Dataset does not support the \'' + req.params.op + '\' operation');
    } // if..else
} // datasetSearch

exports.init = function(stack) {
    stack.requireConnector('postgres');
    stack.requireConnector('postgis');
    stack.requireConnector('geoserver');
}; // init

exports.router = function(app, stack) {
    app.get('/public/pois/:dataset/:op', stack.wrap(datasetSearch));

    // add some dashboard reporting
    app.get('/dash/datasets', stack.wrap(datasets));
};