var path = require('path'),
    fs = require('fs'),
    os = require('os'),
    events = require('events'),
    util = require('util'),
    connect = require('connect'),
    quip = require('quip'),
    url = require('url'),
    uuid = require('node-uuid'),
    Log = require('log'),
    cron = require('cron'),
    reHost = /^(.*?)(\..*$|$)/;
    
/* internal functions */

function dummyStackFn(stack, callback) {
    if (callback) {
        callback();
    } // if
} // dummyStackFn

function loadExtensions(config, stack) {
    var autoLoad = !config.enabledExtensions,
        extensionName, extension, enabled, ii;

    stack.log('looking for extensions in: ' + config.pathExt);
    
    fs.readdir(config.pathExt, function(err, files) {
        for (ii = 0; (! err) && ii < files.length; ii++) {
            if (path.extname(files[ii]) == '.js') {
                extensionName = path.basename(files[ii], '.js');
                enabled = autoLoad || config.enabledExtensions.indexOf(extensionName) >= 0;
                stack.log('found extension "' + extensionName + '", enabled = ' + enabled);
                
                if (enabled) {
                    extension = require(path.join(config.pathExt, files[ii]));

                    // if the extension has an initialization function, then call it
                    if (extension.init) {
                        extension.init(stack);
                    } // if

                    stack.emit('extension', extension);
                    stack.log('loaded extension: ' + files[ii]);
                } // if
            } // if
        } // for  
    });
} // loadExtensions

function loadJobs(config, stack) {
    fs.readdir(config.pathJobs, function(err, files) {
        if (! err) {
            files.forEach(function(jobFile) {
                stack.registerJob(require(path.join(config.pathJobs, jobFile)));
            });
        } // if
        
        stack.saveJobStatus();
    });
} // loadJobs

function loadSettingsFile(stack, callback) {
    fs.readFile('settings.json', 'utf8', function(err, data) {
        if (err) {
            stack.settings = {};
        }
        else {
            stack.settings = JSON.parse(data);
        } // if..else
        
        if (callback) {
            callback();
        } // if..else
    });
} // loadSettingsFile

function NodeStack() {
    this.config = {
        // the data files folder
        datapath: 'data',

        // path the directory that will hold logs
        pathLogs: path.resolve('logs'),

        // path to the directory that contains extension files
        pathExt: path.resolve('lib/extensions'),
        
        // extensions that are enabled
        // DEFAULT = (details and dashboard extensions are loaded)
        // Replace with your own list of extensions to manually configure
        // Alternatively this can be replace with `null` to load all extensions
        enabledExtensions: ['details', 'dashboard', 'postgis'], 

        // path to the job files
        pathJobs: path.resolve('lib/jobs'),
        
        // some configuration defaults
        farmRegex: /^(\w+)(\-?.*)$/i,
        farmMaster: 'master',
        
        // whether or not write operations should be logged
        logWrites: true,
        
        // where can we find couchdb on this system
        couchdb_host:  'localhost',
        couchdb_port:   5984,
        couchdb_name:  'tripplanner', // 'stackdata',
        couchdb_proto: 'http',
        
        // default pgsql connection string
        pgUrl: 'tcp://postgres:1234@localhost/postgres',
        
        // TODO: remove these and place in the geo module
        urls: [
            'http://localhost:8080/geoserver/wfs'
        ]
    };

    this.id = uuid();
    this.logStream = null;
    this.logger = null;
    this.queuedLogs = [];
    this.masterProcess = true;
    this.mode = null;
    this.connectors = {};
    this.extensions = [];
    this.jobs = [];
    this.couch = null;
    this.settings = null;
    this.inSync = false;
    
    // initialise the master hostname
    this.masterHost = undefined;
} // NodeStack constructor

util.inherits(NodeStack, events.EventEmitter);

NodeStack.prototype.cleanup = function() {
    // iterate through the extensions and given them the opportunity to cleanup
    this.extensions.forEach(function(ext) {
        if (ext.cleanup) {
            ext.cleanup(_this);
        } // if
    });

    this.log('stack shutdown');
    // end the log stream
    this.logStream.end();
}; // cleanup

NodeStack.prototype.configure = function(initConfig) {
    function handleTerminate() {
        process.exit();
    } // handleTerminate

    // initialise the initialization config to defaults
    initConfig = initConfig || {};
    
    for (var key in initConfig) {
        this.config[key] = initConfig[key];
    } // for
    
    // handle stack interrupt
    process.on('SIGINT', handleTerminate);
    process.on('SIGTERM', handleTerminate);
    
    // handle the stack shutdown
    process.on('exit', function() {
        NodeStack.prototype.cleanup.call(_this);
    });
    
    return this;
}; // configure

NodeStack.prototype.createServer = function(logExceptions) {
    if (logExceptions) {
        process.addListener('uncaughtException', function(error) {
            reportError(null, error);
        });
    } // if
    
    // create the server
    return connect.createServer(
        // initialise connect middleware
        connect.favicon(),
        quip(),

        // define the connect routes
        connect.router(function(app) {
            // when an extension is loaded, hook into the router
            _this.on('extension', function(ext) {
                _this.extensions.push(ext);
                
                if (ext.router) {
                    ext.router(app, _this);
                } // if
            });
            
            // when a connector is created, hook into the router
            _this.on('connector', function(connector) {
                if (connector.router) {
                    connector.router(app, _this);
                } // if
            });
        })
    );
}; // createServer

NodeStack.prototype.detectMode = function(callback) {
    var hostname = os.hostname(),
        isMaster = hostname.replace(this.config.farmRegex, '$1').toLowerCase() === 
            this.config.farmMaster.toLowerCase();
        
    // if we are on the warchief box, then the master process is the warchief and 
    // the worker process is the highlander (there can be only one)
    this.mode = this.masterProcess ? (isMaster ? 'master' : 'slave') : 'worker';
    
    if (! isMaster) {
        this.masterHost = 'master' + hostname.replace(this.config.farmRegex, '$2');
    } // if

    this.log('stack initialized, mode = ' + this.mode);
    this.emit('updateMode', this.mode);
}; // detectMode

NodeStack.prototype.getConfig = function() {
    var roConfig = {};
    
    // shallow copy the configuration 
    for (var key in this.config) {
        roConfig[key] = this.config[key];
    } // for
    
    return roConfig;
}; // getConfig

NodeStack.prototype.getConnectors = function() {
    var results = [];
    
    for (var key in this.connectors) {
        results[results.length] = this.connectors[key];
    } // for
    
    return results;
}; // getConnectors

NodeStack.prototype.init = function() {
    
    // initialise logging
    this.log();
    this.log('stack starting');
    this.masterProcess = typeof this.cluster == 'undefined' || this.cluster.isMaster;
    
    // detect the mode we are running in (i.e. slave, master, hive, etc)
    this.detectMode();
    
    this.on('couchOK', function() {
        _this.log('CouchDB initialization complete. Completing stack initialization.');
        
        if (this.masterProcess) {
            loadJobs(_this.config, _this);
        } // if
        
        if (this.masterProcess) {
            this.sendMessage('village.online');
        } // if
    });
    
    // require the couchdb connector
    this.requireConnector('couchdb');
    this.requireConnector('postgres');

    // load extensions
    loadExtensions(this.config, this);
}; // init

NodeStack.prototype.initLog = function() {
    return require('./log')();
}; // initLog

NodeStack.prototype.isMaster = function() {
    return this.mode === 'master';
}; // isMaster

NodeStack.prototype.log = function(message, level) {
    var args = [message || '---'];
        
    // queue the log for writing
    this.queuedLogs.push(args.concat(Array.prototype.slice.call(arguments, 2)));
    
    // if we don't have a logger, but cluster is initialized, then create the logger
    if (! this.logger) {
        var isMaster = typeof this.cluster == 'undefined' || this.cluster.isMaster,
            filename = path.join(
                this.config.pathLogs, 
                (isMaster ? 'master' : 'worker') + '-' + process.pid + '.log'
            );
        
        // create the logger
        this.logStream = fs.createWriteStream(filename);
        this.logger = new Log(Log.DEBUG, this.logStream);
    } // if
    
    // if we have a logger, then log
    if (this.logger) {
        for (var ii = 0, entryCount = this.queuedLogs.length; ii < entryCount; ii++) {
            this.logger.log(level || 'INFO', this.queuedLogs[ii]);
        } // for
        
        this.queuedLogs = [];
    } // if
}; // log

NodeStack.prototype.registerJob = function(job) {
    var pattern = job.pattern || '',
        title = job.title || '';

    // parse the pattern and if ok, then schedule the job
    try {
        this.log('found job: "' + title + '" checking pattern: "' + pattern + '"');
        new cron.CronTime(pattern);
        
        if (job.run) {
            this.log('pattern ok, registering job.');
            this.jobs.push(job);

            job.cron = new cron.CronJob(pattern, function() {
                _this.runJob(job);
            });
        }
        else {
            this.log('no run handler for job, not registering');
        } // if..else
    }
    catch (e) {
        _this.log('could not register job: "' + title + '", pattern "' + pattern + '" not valid.', 'error');
    } // try..catch
}; // registerJob

NodeStack.prototype.reportError = function(callback, error) {
    var message,
        stack;

    if (typeof error == 'string') {
        message = error;
    }
    else {
        message = error.message;
        stack = error.stack;
    } // if..else
    
    if (callback) {
        callback({
            error: message,
            stack: stack
        });
    } // if
};

NodeStack.prototype.requireConnector = function(id) {
    var connector = this.connectors[id] || require('./connectors/' + id);
    
    // add to the list of connectors if it doesn't already exists
    if (! this.connectors[id]) {
        if (connector.init) {
            connector.init(this);
        } // if

        // add to the list of connectors
        _this.connectors[id] = connector;
        
        // emit the newConnector event
        _this.emit('connector', connector);
    } // if
    
    return connector;
}; // requireConnector

NodeStack.prototype.restart = function() {
    // iterate through the jobs and if they have a cron job running,
    // cancel them
    for (var ii = 0; ii < this.jobs.length; ii++) {
        if (this.jobs[ii].cron) {
            clearInterval(this.jobs[ii].cron.timer);
        } // if
    } // for
    
    this.jobs = [];
    
    // reset connectors
    this.connectors = {};
    
    // reset extensions
    this.extensions = [];
    
    // initialise
    this.init();
}; // restart

NodeStack.prototype.run = function(callback, innerFn) {
    try {
        var results = innerFn.call(null);
        callback(results);
    }
    catch (e) {
        callback({
            error: e.message
        });
    } // try..catch
};

NodeStack.prototype.runJob = function(job) {
    try {
        // run the job
        job.run(this);
        
        // update the time the job was last run
        job.lastRun = new Date();
        
        this.saveJobStatus();
    }
    catch (e) {
        // log the exception
        this.log('error running job "' + (job.title || '') + '"');
    } // try..catch
}; // runJob

NodeStack.prototype.saveJobStatus = function() {
    // update the job status file
    fs.writeFile(
        path.resolve('html/_stack/_jobdata.json'), 
        JSON.stringify({ jobs: this.jobs }), 
        'utf8'
    );
}; // saveJobStatus

/**
### sendMessage
*/
NodeStack.prototype.sendMessage = function(changeType, changeData) {
    if (this.changeLogger) {
        this.changeLogger.write(this, changeType, changeData);
    } // if
}; // sendChange

/**
### settingRead
*/
NodeStack.prototype.settingRead = function(section, name, callback, reload) {
    // if the settings file has not been opened, then do that now
    if ((! this.settings) || reload) {
        loadSettingsFile(this, function() {
            _this.settingRead(section, name, callback);
        });
    }
    else {
        var sectionData = this.settings[section] || {},
            settingValue = sectionData[name];
            
        if (callback) {
            callback(settingValue);
        } // if
    } // if..else
}; // settingRead

NodeStack.prototype.settingWrite = function(section, name, value, callback) {
    if (! this.settings[section]) {
        this.settings[section] = {};
    } // if

    // update the setting value
    this.settings[section][name] = value;

    // write the settings file
    fs.writeFileSync('settings.json', JSON.stringify(this.settings), 'utf8', callback);
}; // settingWrite

NodeStack.prototype.validateDesign = function(typeName, design) {
    console.log('validating design for type: ' + typeName);
    this.emit('validateDesign', typeName, design);
}; // validateDesign

NodeStack.prototype.wrap = function(handlerFn) {
    
    function jsonify(cbName, res, output) {
        if (cbName) {
            res.jsonp(cbName, output);
        }
        else {
            res.json(output);
        } // if..else
    } // jsonify

    return function(req, res, next) {
        var queryParams = url.parse(req.url, true).query,
            output = {};

        try {
            handlerFn(_this, function(output) {
                jsonify(queryParams.callback, res, output || { error: 'No results' });
            }, queryParams, req, res, next);
        }
        catch (e) {
            _this.reportError(function(data) {
                jsonify(queryParams.callback, res, data);
            }, e);
        } // try..catch
    };
}; // wrap
    
var _this = module.exports = new NodeStack();